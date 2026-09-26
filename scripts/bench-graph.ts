// Benchmarks buildGraph on a synthetic 5,000-file TypeScript repo: cold, warm, and hook mode.
// Run manually with "bun scripts/bench-graph.ts". Targets: cold <= 30 s, warm (check --changed) <= 2 s, hook p95 <= 500 ms.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { WorktreeSource, buildGraph } from "../src/analysis/index.ts";
import { ArchitectureSchema } from "../src/model/index.ts";

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

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "architect-bench-"));
  try {
    await generate(root);
    const architecture = ArchitectureSchema.parse({
      components: Array.from({ length: COMPONENTS }, (_, c) => ({ id: component(c), paths: [`src/${component(c)}`] })),
    });
    const cacheDir = join(root, ".architect", "cache");
    const source = new WorktreeSource(root);

    const cold = await buildGraph(source, architecture, { cacheDir });
    console.log(`cold:  ${cold.stats.ms} ms  files=${cold.stats.files} parsed=${cold.stats.parsed} edges=${cold.graph.edges.length} unresolved=${cold.coverage.unresolved_imports.length}`);

    const warm = await buildGraph(source, architecture, { cacheDir });
    console.log(`warm:  ${warm.stats.ms} ms  parsed=${warm.stats.parsed} (no changes)`);

    const edited = filePath(3, 7);
    await writeFile(join(root, edited), `${moduleText(3, 7)}export const touched = 1;\n`);
    const changed = await buildGraph(new WorktreeSource(root), architecture, { cacheDir });
    console.log(`warm:  ${changed.stats.ms} ms  parsed=${changed.stats.parsed} (one file edited)`);

    const times: number[] = [];
    for (let i = 0; i < HOOK_RUNS; i++) {
      const target = filePath(i % COMPONENTS, (i * 37) % FILES_PER_COMPONENT);
      await writeFile(join(root, target), `${moduleText(i % COMPONENTS, (i * 37) % FILES_PER_COMPONENT)}export const edit${i} = ${i};\n`);
      const started = performance.now();
      await buildGraph(new WorktreeSource(root), architecture, { cacheDir, only: [target] });
      times.push(performance.now() - started);
    }
    console.log(`hook:  p50=${percentile(times, 50).toFixed(0)} ms  p95=${percentile(times, 95).toFixed(0)} ms  (${HOOK_RUNS} runs, one file each)`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
