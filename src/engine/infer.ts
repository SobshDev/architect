// Infers a first architecture map from the repository layout and the current imports.
import { basename } from "node:path";
import { globMatcher, type Component, type ComponentGraph, type WorkspacePackage } from "../model/index.ts";
import { findCycles } from "../rules/index.ts";

/** Test and fixture code that the first map leaves out. */
const TEST_GLOBS = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**", "**/__mocks__/**", "**/test/**", "**/tests/**", "**/e2e/**", "**/fixtures/**"];

export interface InferredMap {
  components: Component[];
  /** Test globs that matched at least one file; init adds them to settings.exclude. */
  exclude: string[];
}

/**
 * One component per workspace package, then one per folder of the main source root (the folder that holds
 * most of the code), then one per other top-level folder. Order matters: a file belongs to the first match.
 */
export function inferComponents(files: readonly string[], workspaces: readonly WorkspacePackage[]): InferredMap {
  const exclude = TEST_GLOBS.filter((glob) => files.some(globMatcher([glob])));
  const isTest = globMatcher(exclude);
  const source = files.filter((file) => !isTest(file));
  const taken = new Set<string>();
  const components: Component[] = [];
  const add = (name: string, paths: string[], extra: Partial<Component> = {}) => components.push({ id: uniqueId(name, taken), paths, ...extra });

  // Innermost package first, so nested packages win the first-match rule.
  const packages = workspaces.filter((w) => w.dir !== "").sort((a, b) => b.dir.length - a.dir.length || a.dir.localeCompare(b.dir));
  const packageOf = (file: string) => packages.find((w) => file.startsWith(`${w.dir}/`));
  const used = new Set<string>();
  const loose: string[] = [];
  for (const file of source) {
    const owner = packageOf(file);
    if (owner) used.add(owner.dir);
    else loose.push(file);
  }
  const ordered = packages.filter((w) => used.has(w.dir)).sort((a, b) => compareNested(a.dir, b.dir));
  for (const w of ordered) add(w.name.replace(/^@[^/]+\//, ""), [w.dir], { package: w.name });

  if (loose.length > 0) {
    const root = sourceRoot(loose);
    const prefix = root === "" ? "" : `${root}/`;
    const folders = new Set<string>();
    let direct = 0;
    for (const file of loose) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) direct++;
      else folders.add(rest.slice(0, slash));
    }
    for (const folder of [...folders].sort()) add(folder, [`${prefix}${folder}`]);
    if (root !== "" && direct > 0) add(basename(root), [root]);
    if (root !== "") {
      const others = new Set<string>();
      for (const file of loose) {
        if (file.startsWith(prefix) || !file.includes("/")) continue;
        others.add(file.slice(0, file.indexOf("/")));
      }
      for (const folder of [...others].sort()) add(folder, [folder]);
    }
  }
  return { components, exclude };
}

/** Sorts alphabetically, except that a folder always comes before the folders that contain it. */
function compareNested(a: string, b: string): number {
  if (a.startsWith(`${b}/`)) return -1;
  if (b.startsWith(`${a}/`)) return 1;
  return a.localeCompare(b);
}

/** Descends while one folder holds at least 80% of the files and has two or more subfolders with code. */
function sourceRoot(files: readonly string[]): string {
  let root = "";
  for (let depth = 0; depth < 3; depth++) {
    const prefix = root === "" ? "" : `${root}/`;
    const inside = files.filter((file) => file.startsWith(prefix));
    const counts = new Map<string, number>();
    for (const file of inside) {
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash > 0) counts.set(rest.slice(0, slash), (counts.get(rest.slice(0, slash)) ?? 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (top === undefined || top[1] < 0.8 * inside.length) break;
    const childPrefix = `${prefix}${top[0]}/`;
    const subfolders = new Set<string>();
    for (const file of inside) {
      if (!file.startsWith(childPrefix)) continue;
      const rest = file.slice(childPrefix.length);
      if (rest.includes("/")) subfolders.add(rest.slice(0, rest.indexOf("/")));
    }
    if (subfolders.size < 2) break;
    root = `${prefix}${top[0]}`;
  }
  return root;
}

function uniqueId(name: string, taken: Set<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/^\./, "dot-")
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .replace(/-+$/, "") || "component";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

/**
 * Layers implied by the current dependencies, highest first. Each component sits one level above the deepest
 * component it depends on; components in a cycle share a layer; components without any edge are left out.
 */
export function inferLayers(graph: ComponentGraph): string[][] {
  const connected = new Set<string>();
  for (const edge of graph.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  const nodes = graph.components.filter((id) => connected.has(id));
  const groupOf = new Map<string, string>();
  for (const cycle of findCycles(nodes, graph.edges)) for (const member of cycle) groupOf.set(member, cycle[0] ?? member);
  const group = (id: string) => groupOf.get(id) ?? id;
  const deps = new Map<string, Set<string>>();
  for (const id of nodes) deps.set(group(id), deps.get(group(id)) ?? new Set());
  for (const edge of graph.edges) {
    const from = group(edge.from);
    const to = group(edge.to);
    if (from !== to) deps.get(from)?.add(to);
  }
  const height = new Map<string, number>();
  const heightOf = (id: string): number => {
    const known = height.get(id);
    if (known !== undefined) return known;
    let value = 0;
    for (const dep of deps.get(id) ?? []) value = Math.max(value, heightOf(dep) + 1);
    height.set(id, value);
    return value;
  };
  const layers = new Map<number, string[]>();
  for (const id of nodes) {
    const level = heightOf(group(id));
    layers.set(level, [...(layers.get(level) ?? []), id]);
  }
  return [...layers.keys()].sort((a, b) => b - a).map((level) => (layers.get(level) ?? []).sort());
}
