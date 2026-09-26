import picomatch from "picomatch";
import { parse as parseYaml } from "yaml";
import type { FileSource, WorkspacePackage } from "../../model/index.ts";

/** Workspace packages declared by the root package.json ("workspaces") and pnpm-workspace.yaml ("packages"). */
export async function discoverWorkspaces(source: FileSource, files: readonly string[]): Promise<WorkspacePackage[]> {
  const listed = new Set(files);
  const patterns: string[] = [];
  if (listed.has("package.json")) patterns.push(...fromPackageJson(await source.readFile("package.json")));
  if (listed.has("pnpm-workspace.yaml")) patterns.push(...fromPnpm(await source.readFile("pnpm-workspace.yaml")));

  const positive: string[] = [];
  const negative: string[] = [];
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = normalize(negated ? raw.slice(1) : raw);
    if (pattern !== "") (negated ? negative : positive).push(pattern);
  }
  if (positive.length === 0) return [];
  const include = picomatch(positive);
  const exclude = negative.length > 0 ? picomatch(negative) : () => false;

  const dirs = files
    .filter((f) => f.endsWith("/package.json"))
    .map((f) => f.slice(0, -"/package.json".length))
    .filter((dir) => !dir.split("/").includes("node_modules") && include(dir) && !exclude(dir));
  const manifests = await source.readFiles(dirs.map((d) => `${d}/package.json`));

  const out: WorkspacePackage[] = [];
  for (const dir of dirs) {
    const name = packageName(manifests.get(`${dir}/package.json`));
    if (name) out.push({ name, dir });
  }
  return out.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

function normalize(pattern: string): string {
  let p = pattern.trim();
  while (p.startsWith("./")) p = p.slice(2);
  while (p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function fromPackageJson(text: string | null): string[] {
  const workspaces = parseJson(text)?.workspaces;
  if (Array.isArray(workspaces)) return strings(workspaces);
  if (workspaces && typeof workspaces === "object") return strings((workspaces as Record<string, unknown>).packages);
  return [];
}

function fromPnpm(text: string | null): string[] {
  if (text === null) return [];
  try {
    const doc: unknown = parseYaml(text);
    return doc && typeof doc === "object" ? strings((doc as Record<string, unknown>).packages) : [];
  } catch {
    return [];
  }
}

function packageName(text: string | undefined): string | null {
  const name = parseJson(text ?? null)?.name;
  return typeof name === "string" && name !== "" ? name : null;
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
