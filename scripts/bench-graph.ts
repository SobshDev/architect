// Benchmarks Architect on a synthetic, committed 5,000-file TypeScript repo against the v0.1 targets:
// a full check from a cold cache <= 30 s, check --changed with a warm cache <= 2 s, and the PostToolUse hook
// p95 <= 500 ms. Every command runs as its own process, as an agent or CI runs it, so times include startup.
// "bun scripts/bench-graph.ts" prints the numbers; "--assert" also exits 1 when one is over twice its target.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "../src/cli/main.ts");
const TODAY = "2026-09-26";

const COMPONENTS = 20;
const FILES_PER_COMPONENT = 250;
const FOLDERS_PER_COMPONENT = 10;
const HOOK_RUNS = 20;

let seed = 42;
function random(n: number): number {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed % n;
}

const component = (c: number) => `c${String(c).padStart(2, "0")}`;
const filePath = (c: number, f: number) => `src/${component(c)}/f${f % FOLDERS_PER_COMPONENT}/m${f}.ts`;

function relative(from: string, to: string): string {
  const a = dirname(from).split("/");
  const b = to.replace(/\.ts$/, ".js").split("/");
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  const up = a.slice(i).map(() => "..");
  const spec = [...up, ...b.slice(i)].join("/");
  return up.length === 0 ? `./${spec}` : spec;
}

function moduleText(c: number, f: number): string {
  const self = filePath(c, f);
  const lines: string[] = [];
  for (let k = 0; k < 3; k++) {
    const target = random(FILES_PER_COMPONENT);
    if (target !== f) lines.push(`import { fn${target} } from "${relative(self, filePath(c, target))}";`);
  }
  if (c > 0) {
    const lower = random(c);
    const target = random(FILES_PER_COMPONENT);
    lines.push(`import type { Shape${target} } from "@/${component(lower)}/f${target % FOLDERS_PER_COMPONENT}/m${target}";`);
  }
  if (random(4) === 0) lines.push(`import { useState } from "react";`);
  if (random(10) === 0) lines.push(`import { readFile } from "node:fs/promises";`);
  if (random(25) === 0) lines.push(`const lazy = () => import("./m${f}.js");`);
  lines.push(
    "",
    `export interface Shape${f} { id: string; value: number; tags: string[] }`,
    "",
    `export function fn${f}(input: Shape${f}): number {`,
    "  let total = input.value;",
    "  for (const tag of input.tags) total += tag.length;",
    "  return total;",
    "}",
    "",
    `export class Service${f} {`,
    "  private cache = new Map<string, number>();",
    `  run(shape: Shape${f}): number {`,
    `    const hit = this.cache.get(shape.id);`,
    `    if (hit !== undefined) return hit;`,
    `    const out = fn${f}(shape);`,
    "    this.cache.set(shape.id, out);",
    "    return out;",
    "  }",
    "}",
  );
  return `${lines.join("\n")}\n`;
}

async function generate(root: string): Promise<void> {
  const files = new Map<string, string>();
  files.set("package.json", JSON.stringify({ name: "bench", private: true, dependencies: { react: "19.0.0" } }, null, 2));
  files.set(
    "tsconfig.json",
    JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", baseUrl: ".", paths: { "@/*": ["src/*"] } } }, null, 2),
  );
  for (let c = 0; c < COMPONENTS; c++) for (let f = 0; f < FILES_PER_COMPONENT; f++) files.set(filePath(c, f), moduleText(c, f));
  for (const [path, text] of files) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: root });
  if (init.exitCode !== 0) throw new Error("git init failed");
}

function contract(): Map<string, string> {
  const ids = Array.from({ length: COMPONENTS }, (_, c) => component(c));
  const architecture = ["version: 1", "name: bench", "components:", ...ids.flatMap((id) => [`  - id: ${id}`, `    paths: [src/${id}]`])];
  const rules = [
    "version: 1",
    "rules:",
    "  - id: no-cycles",
    "    kind: acyclic",
    '    because: ["0001"]',
    "  - id: layering",
    "    kind: layers",
    `    layers: [${[...ids].reverse().join(", ")}]`,
    '    because: ["0001"]',
  ];
  const decision = ["---", "status: accepted", "date: 2026-09-01", "---", "", "# Components depend only on lower components", ""];
  return new Map([
    [".architect/architecture.yaml", `${architecture.join("\n")}\n`],
    [".architect/rules.yaml", `${rules.join("\n")}\n`],
    [".architect/decisions/0001-components-depend-downward.md", decision.join("\n")],
    [".architect/.gitignore", "cache/\n"],
  ]);
}

function git(root: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=bench", "-c", "user.email=bench@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

/** Runs the CLI as a separate process and returns its wall time in milliseconds. */
function run(root: string, args: string[], stdin?: string): { ms: number; exitCode: number; stdout: string } {
  const started = performance.now();
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: root,
    env: { ...process.env, ARCHITECT_TODAY: TODAY },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
  });
  const ms = performance.now() - started;
  const stderr = result.stderr.toString();
  if (stderr.includes("failed") || result.exitCode === 2) throw new Error(`architect ${args.join(" ")} failed (exit ${result.exitCode}): ${stderr}`);
  return { ms, exitCode: result.exitCode, stdout: result.stdout.toString() };
}

function hookPayload(root: string, event: "SessionStart" | "PostToolUse", path?: string): string {
  const base = { session_id: "bench", transcript_path: join(root, "transcript.jsonl"), cwd: root, hook_event_name: event, model: "bench", permission_mode: "default" };
  if (event === "SessionStart") return JSON.stringify({ ...base, source: "startup" });
  const patch = `*** Begin Patch\n*** Update File: ${path}\n@@\n+export const edited = 1;\n*** End Patch\n`;
  return JSON.stringify({ ...base, turn_id: "t", tool_name: "apply_patch", tool_input: { command: patch }, tool_response: "Success.", tool_use_id: "u" });
}

interface Measure {
  name: string;
  ms: number;
  target?: number;
}

async function main(): Promise<void> {
  const assert = process.argv.includes("--assert");
  const root = await mkdtemp(join(tmpdir(), "architect-bench-"));
  const measures: Measure[] = [];
  try {
    await generate(root);
    for (const [path, text] of contract()) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "bench");

    const cold = run(root, ["check", "--format", "json"]);
    const report = JSON.parse(cold.stdout) as { coverage: { files_analyzed: number } };
    measures.push({ name: `check, cold cache (${report.coverage.files_analyzed} files)`, ms: cold.ms, target: 30_000 });

    measures.push({ name: "SessionStart hook", ms: run(root, ["hook", "SessionStart", "--agent", "codex"], hookPayload(root, "SessionStart")).ms });

    const times: number[] = [];
    for (let i = 0; i < HOOK_RUNS; i++) {
      const c = i % COMPONENTS;
      const f = (i * 37) % FILES_PER_COMPONENT;
      const target = filePath(c, f);
      await writeFile(join(root, target), `${moduleText(c, f)}export const edited = 1;\n`);
      times.push(run(root, ["hook", "PostToolUse", "--agent", "codex"], hookPayload(root, "PostToolUse", target)).ms);
    }
    measures.push({ name: `PostToolUse hook p50 (${HOOK_RUNS} edits)`, ms: percentile(times, 50) });
    measures.push({ name: `PostToolUse hook p95 (${HOOK_RUNS} edits)`, ms: percentile(times, 95), target: 500 });

    const changed = [0, 1, 2].map(() => run(root, ["check", "--changed"]).ms);
    measures.push({ name: `check --changed, warm cache (${HOOK_RUNS} edited files, median of 3)`, ms: percentile(changed, 50), target: 2_000 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  let over = 0;
  for (const m of measures) {
    const limit = m.target === undefined ? "" : `  target ${m.target} ms`;
    const flag = m.target !== undefined && m.ms > 2 * m.target ? "  OVER 2x TARGET" : "";
    if (flag) over++;
    console.log(`${m.name.padEnd(62)} ${m.ms.toFixed(0).padStart(6)} ms${limit}${flag}`);
  }
  if (assert && over > 0) {
    console.error(`${over} measurement(s) over twice the target.`);
    process.exit(1);
  }
}

await main();

