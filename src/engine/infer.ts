// Infers a first architecture map from the repository layout and the current imports. The layout counts every
// source file, in any language, so folders of Rust or Swift shape the map even where no analyzer reads them.
import { basename } from "node:path";
import { globMatcher, type CoChangePair, type Component, type ComponentGraph } from "../model/index.ts";
import { findCycles } from "../rules/index.ts";
import { compareText } from "../model/index.ts";

/** Test and fixture code that the first map leaves out, including Swift's Tests/ and Fixtures/ folders. */
const TEST_GLOBS = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/test/**",
  "**/tests/**",
  "**/Tests/**",
  "**/e2e/**",
  "**/fixtures/**",
  "**/Fixtures/**",
];

/**
 * Folder names that hold one unit per child: api/modules/chats, Sources/ChatCore, crates/store. Each child with
 * code becomes a component of its own.
 */
const CONTAINERS = new Set(["apps", "components", "crates", "domains", "features", "libs", "modules", "packages", "plugins", "services", "sources", "targets"]);

/** A package the layout declares: a workspace package (package.json, pnpm) or a crate (Cargo.toml). */
export interface DeclaredPackage {
  name: string;
  /** Repo-relative directory without a trailing slash. */
  dir: string;
  /** True for JavaScript workspace packages, which components can name through their package field. */
  workspace?: boolean;
}

export interface InferredMap {
  components: Component[];
  /** Test globs that matched at least one file; init adds them to settings.exclude. */
  exclude: string[];
}

/**
 * One component per declared package (workspace package or crate), then one per folder of the main source root
 * (the folder that holds most of the code), then one per other top-level folder. A folder that only wraps a single
 * subfolder is skipped over, and a container folder (modules, packages, Sources, ...) yields one component per
 * child. Order matters: a file belongs to the first match, so nested components come before their parents.
 */
export function inferComponents(files: readonly string[], workspaces: readonly DeclaredPackage[]): InferredMap {
  const exclude = TEST_GLOBS.filter((glob) => files.some(globMatcher([glob])));
  const isTest = globMatcher(exclude);
  const source = files.filter((file) => !isTest(file));
  const taken = new Set<string>();
  const components: Component[] = [];
  const add = (name: string, paths: string[], extra: Partial<Component> = {}) => components.push({ id: uniqueId(name, taken), paths, ...extra });

  // Innermost package first, so nested packages win the first-match rule.
  const packages = workspaces.filter((w) => w.dir !== "").sort((a, b) => b.dir.length - a.dir.length || compareText(a.dir, b.dir));
  const packageOf = (file: string) => packages.find((w) => file.startsWith(`${w.dir}/`));
  const used = new Set<string>();
  const loose: string[] = [];
  for (const file of source) {
    const owner = packageOf(file);
    if (owner) used.add(owner.dir);
    else loose.push(file);
  }
  const ordered = packages.filter((w) => used.has(w.dir)).sort((a, b) => compareNested(a.dir, b.dir));
  for (const w of ordered) add(w.name.replace(/^@[^/]+\//, ""), [w.dir], w.workspace ? { package: w.name } : {});

  if (loose.length > 0) {
    const root = sourceRoot(loose);
    const prefix = root === "" ? "" : `${root}/`;
    const folders: { name: string; path: string }[] = [];
    const tops = new Set<string>();
    let direct = 0;
    for (const file of loose) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash === -1) direct++;
      else tops.add(rest.slice(0, slash));
    }
    for (const folder of [...tops].sort()) folders.push(...unitsOf(`${prefix}${folder}`, loose));
    if (root !== "" && direct > 0) folders.push({ name: basename(root), path: root });
    if (root !== "") {
      const others = new Set<string>();
      for (const file of loose) {
        if (file.startsWith(prefix) || !file.includes("/")) continue;
        others.add(file.slice(0, file.indexOf("/")));
      }
      for (const folder of [...others].sort()) folders.push(...unitsOf(folder, loose));
    }
    const order = new Map(folders.map((f, i) => [f.path, i]));
    folders.sort((a, b) => (a.path.startsWith(`${b.path}/`) ? -1 : b.path.startsWith(`${a.path}/`) ? 1 : (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0)));
    for (const folder of folders) add(folder.name, [folder.path]);
  }
  return { components, exclude };
}

/** Immediate subfolders of dir that hold files, and whether dir holds files directly. */
function childrenOf(dir: string, files: readonly string[]): { folders: string[]; direct: boolean } {
  const prefix = `${dir}/`;
  const folders = new Set<string>();
  let direct = false;
  for (const file of files) {
    if (!file.startsWith(prefix)) continue;
    const rest = file.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash === -1) direct = true;
    else folders.add(rest.slice(0, slash));
  }
  return { folders: [...folders].sort(compareText), direct };
}

/**
 * The components one top folder contributes. A folder that only wraps one subfolder is skipped over; container
 * folders found within three levels split into one component per child, listed before the folder that holds them.
 */
function unitsOf(folder: string, files: readonly string[]): { name: string; path: string }[] {
  let dir = folder;
  for (let depth = 0; depth < 4; depth++) {
    const { folders, direct } = childrenOf(dir, files);
    if (direct || folders.length !== 1) break;
    dir = `${dir}/${folders[0]}`;
  }
  const units: { name: string; path: string }[] = [];
  const visit = (path: string, depth: number) => {
    const { folders } = childrenOf(path, files);
    if (depth > 0 && CONTAINERS.has(basename(path).toLowerCase()) && folders.length >= 2) {
      for (const child of folders) units.push({ name: child, path: `${path}/${child}` });
      return;
    }
    if (depth < 3) for (const child of folders) visit(`${path}/${child}`, depth + 1);
  };
  if (CONTAINERS.has(basename(dir).toLowerCase()) && childrenOf(dir, files).folders.length >= 2) {
    const { folders, direct } = childrenOf(dir, files);
    for (const child of folders) units.push({ name: child, path: `${dir}/${child}` });
    if (direct) units.push({ name: basename(folder), path: dir });
    return units;
  }
  visit(dir, 0);
  units.push({ name: basename(folder), path: dir });
  return units;
}

/** Sorts alphabetically, except that a folder always comes before the folders that contain it. */
function compareNested(a: string, b: string): number {
  if (a.startsWith(`${b}/`)) return -1;
  if (b.startsWith(`${a}/`)) return 1;
  return compareText(a, b);
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
    const top = [...counts].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))[0];
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

export interface CoChangeCluster {
  /** Components the files belong to, sorted. */
  components: string[];
  /** Files linked through co-change pairs, sorted. */
  files: string[];
  /** The most commits that changed one pair of these files together. */
  support: number;
}

/**
 * Groups of files that change together (linked through co-change pairs) and fall in more than one component:
 * places where a boundary may cut through one reason to change. Highest support first.
 */
export function coChangeClusters(pairs: readonly CoChangePair[], componentOf: (file: string) => string | null, limit = 10): CoChangeCluster[] {
  const parent = new Map<string, string>();
  const find = (file: string): string => {
    let root = file;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root) as string;
    for (let node = file; node !== root; ) {
      const next = parent.get(node) as string;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  for (const pair of pairs) {
    const [a, b] = [find(pair.a), find(pair.b)].sort(compareText) as [string, string];
    if (a !== b) parent.set(b, a);
  }
  const groups = new Map<string, { files: Set<string>; support: number }>();
  for (const pair of pairs) {
    const root = find(pair.a);
    const group = groups.get(root) ?? { files: new Set<string>(), support: 0 };
    group.files.add(pair.a).add(pair.b);
    group.support = Math.max(group.support, pair.support);
    groups.set(root, group);
  }
  const clusters: CoChangeCluster[] = [];
  for (const group of groups.values()) {
    const files = [...group.files].sort(compareText);
    const components = [...new Set(files.map(componentOf).filter((id): id is string => id !== null))].sort(compareText);
    if (components.length >= 2) clusters.push({ components, files, support: group.support });
  }
  return clusters
    .sort((x, y) => y.support - x.support || y.files.length - x.files.length || compareText(x.files[0] ?? "", y.files[0] ?? ""))
    .slice(0, limit);
}

/** The first few files of a cluster, for one line of text. */
export function previewFiles(files: readonly string[], shown = 4): string {
  const head = files.slice(0, shown).join(", ");
  return files.length > shown ? `${head}, and ${files.length - shown} more` : head;
}
