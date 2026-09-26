// Tolerant readers for user files: never throw, report issues, keep whatever validated.
import { parseDocument } from "yaml";
import type { z } from "zod";
import type { ConfigIssue } from "../model/index.ts";

type Level = ConfigIssue["level"];

/** Renders a zod path like rules[3].because. */
export function renderPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const part of path) {
    if (typeof part === "number") out += `[${part}]`;
    else out += out === "" ? String(part) : `.${String(part)}`;
  }
  return out;
}

export function issue(level: Level, file: string, message: string, path?: string): ConfigIssue {
  return path === undefined || path === "" ? { level, file, message } : { level, file, path, message };
}

/** Parses YAML text. Syntax errors become issues and yield null. An empty document yields null too. */
export function readYaml(file: string, text: string, level: Level): { value: unknown; issues: ConfigIssue[] } {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    const issues = doc.errors.map((err) => {
      const first = err.message.split("\n")[0] ?? err.message;
      const message = first.replace(/ at line \d+, column \d+:?$/, "");
      const line = err.linePos?.[0]?.line;
      return issue(level, file, line === undefined ? `YAML syntax error: ${message}` : `YAML syntax error at line ${line}: ${message}`);
    });
    return { value: null, issues };
  }
  return { value: doc.toJS(), issues: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates raw data with a schema. On failure, reports every zod issue, then drops the offending
 * array elements or keys and retries, so the parts that validated survive and defaults fill the rest.
 */
export function salvage<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  file: string,
  level: Level,
): { value: z.output<S>; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  let current: Record<string, unknown> = {};
  if (isRecord(raw)) current = structuredClone(raw);
  else if (raw !== undefined && raw !== null) issues.push(issue(level, file, "expected a mapping at the top level"));

  let result = schema.safeParse(current);
  if (!result.success) {
    for (const zodIssue of result.error.issues) issues.push(issue(level, file, zodIssue.message, renderPath(zodIssue.path)));
  }
  for (let attempt = 0; attempt < 100 && !result.success; attempt++) {
    const drops = new Map<string, Set<number> | "key">();
    for (const zodIssue of result.error.issues) {
      const [key, index] = zodIssue.path;
      if (key === undefined) {
        current = {};
        drops.clear();
        break;
      }
      const name = String(key);
      const existing = drops.get(name);
      if (typeof index === "number" && Array.isArray(current[name]) && existing !== "key") {
        drops.set(name, (existing ?? new Set<number>()).add(index));
      } else {
        drops.set(name, "key");
      }
    }
    for (const [name, drop] of drops) {
      if (drop === "key") delete current[name];
      else current[name] = (current[name] as unknown[]).filter((_, i) => !drop.has(i));
    }
    result = schema.safeParse(current);
  }
  if (result.success) return { value: result.data, issues };
  return { value: schema.parse({}), issues };
}

export function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareIssues(a: ConfigIssue, b: ConfigIssue): number {
  return cmp(a.file, b.file) || cmp(a.path ?? "", b.path ?? "") || cmp(a.message, b.message);
}
