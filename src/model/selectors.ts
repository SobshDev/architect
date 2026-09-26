import picomatch from "picomatch";
import { type ComponentIndex, globMatcher, type PathMatcher } from "./components.ts";
import type { Edge } from "./graph.ts";

/** A parsed selector: "*", a component id, "path:<glob>", or "pkg:<name glob>". */
export type Selector =
  | { type: "all"; raw: string }
  | { type: "component"; raw: string; id: string }
  | { type: "path"; raw: string; glob: string; match: PathMatcher }
  | { type: "pkg"; raw: string; glob: string; match: PathMatcher };

/** One side of an edge. Internal files carry file and component; external packages carry package only. */
export interface Endpoint {
  file?: string;
  component: string | null;
  /** External package name, or the workspace package of an internal file. */
  package?: string;
  external: boolean;
}

const cache = new Map<string, Selector>();

export function parseSelector(raw: string): Selector {
  const cached = cache.get(raw);
  if (cached) return cached;
  let selector: Selector;
  if (raw === "*") selector = { type: "all", raw };
  else if (raw.startsWith("path:")) selector = { type: "path", raw, glob: raw.slice(5), match: globMatcher([raw.slice(5)]) };
  else if (raw.startsWith("pkg:")) {
    const glob = raw.slice(4);
    const match = picomatch(glob, { dot: true });
    // "pkg:lodash" also matches subpath packages recorded as "lodash".
    selector = { type: "pkg", raw, glob, match };
  } else selector = { type: "component", raw, id: raw };
  cache.set(raw, selector);
  return selector;
}

export function selectorMatches(selector: Selector, endpoint: Endpoint): boolean {
  switch (selector.type) {
    case "all":
      return !endpoint.external;
    case "component":
      return endpoint.component === selector.id;
    case "path":
      return endpoint.file !== undefined && selector.match(endpoint.file);
    case "pkg":
      return endpoint.package !== undefined && selector.match(endpoint.package);
  }
}

export function anySelectorMatches(selectors: readonly string[], endpoint: Endpoint): boolean {
  return selectors.some((raw) => selectorMatches(parseSelector(raw), endpoint));
}

/** Component ids named directly by selectors, for validation. */
export function referencedComponents(selectors: readonly string[]): string[] {
  return selectors.map(parseSelector).flatMap((s) => (s.type === "component" ? [s.id] : []));
}

export function sourceEndpoint(file: string, index: ComponentIndex): Endpoint {
  const pkg = index.packageOfFile(file);
  return pkg === undefined ? { file, component: index.of(file), external: false } : { file, component: index.of(file), package: pkg, external: false };
}

/** The target side of an edge, or null for unresolved imports. */
export function targetEndpoint(edge: Edge, index: ComponentIndex): Endpoint | null {
  if (edge.to !== undefined) {
    const base = { file: edge.to, component: index.of(edge.to), external: false };
    return edge.workspace === undefined ? base : { ...base, package: edge.workspace };
  }
  if (edge.workspace !== undefined) return { component: index.ofPackage(edge.workspace), package: edge.workspace, external: false };
  if (edge.package !== undefined) return { component: null, package: edge.package, external: true };
  return null;
}

/** Stable identity of an edge's target for fingerprints: the file, the workspace package, or the external package. */
export function targetKey(edge: Edge): string {
  return edge.to ?? (edge.workspace !== undefined ? `workspace:${edge.workspace}` : edge.package !== undefined ? `pkg:${edge.package}` : `unresolved:${edge.specifier}`);
}
