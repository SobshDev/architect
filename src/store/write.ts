import { mkdir } from "node:fs/promises";
import { isAbsolute, posix, resolve, sep, win32 } from "node:path";
import { stringify } from "yaml";
import type { z } from "zod";
import { ArchitectureSchema, type Baseline, type BaselineEntry, RulesFileSchema } from "../model/index.ts";
import { cmp } from "./parse.ts";

const ENTRY_KEYS = ["fingerprint", "rule", "count", "file", "from", "to", "message"] as const;

function compareEntries(a: BaselineEntry, b: BaselineEntry): number {
  if (a.rule !== b.rule) return cmp(a.rule, b.rule);
  if (a.file !== b.file) {
    if (a.file === undefined) return 1;
    if (b.file === undefined) return -1;
    return cmp(a.file, b.file);
  }
  return cmp(a.fingerprint, b.fingerprint);
}

export function serializeBaseline(baseline: Baseline): string {
  const entries = [...baseline.entries].sort(compareEntries).map((entry) => {
    const out: Record<string, unknown> = {};
    for (const key of ENTRY_KEYS) if (entry[key] !== undefined) out[key] = entry[key];
    return out;
  });
  return `${JSON.stringify({ schema_version: baseline.schema_version, entries }, null, 2)}\n`;
}

/** Drops undefined values and empty arrays, keeping key order. */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined || (Array.isArray(inner) && inner.length === 0)) continue;
    out[key] = prune(inner);
  }
  return out;
}

function serializeYaml(schema: z.ZodType, input: unknown, header: string): string {
  schema.parse(input);
  return `# ${header}\n${stringify(prune(input), { lineWidth: 0 })}`;
}

export function serializeArchitecture(input: z.input<typeof ArchitectureSchema>): string {
  return serializeYaml(ArchitectureSchema, input, "Architect architecture: components, resources, and settings.");
}

export function serializeRules(input: z.input<typeof RulesFileSchema>): string {
  return serializeYaml(RulesFileSchema, input, "Architect rules: structural constraints, each citing the decisions behind it.");
}

/** Writes text to a repo-relative posix path under root, creating parent directories. */
export async function writeRepoFile(root: string, path: string, text: string): Promise<void> {
  if (path === "" || isAbsolute(path) || posix.isAbsolute(path) || win32.isAbsolute(path) || path.includes("\\")) {
    throw new Error(`expected a repo-relative posix path: ${path}`);
  }
  const normalized = posix.normalize(path);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`path escapes the repository root: ${path}`);
  }
  const base = resolve(root);
  const target = resolve(base, normalized);
  if (!target.startsWith(base + sep)) throw new Error(`path escapes the repository root: ${path}`);
  await mkdir(resolve(target, ".."), { recursive: true });
  await Bun.write(target, text);
}
