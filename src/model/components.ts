import picomatch from "picomatch";
import type { WorkspacePackage } from "./graph.ts";
import type { Component } from "./schema.ts";

export type PathMatcher = (path: string) => boolean;

/** Compiles globs. A pattern without glob characters also matches everything below it, so "src/model" works as a folder. */
export function globMatcher(patterns: readonly string[]): PathMatcher {
  const expanded: string[] = [];
  for (const raw of patterns) {
    const pattern = raw.startsWith("./") ? raw.slice(2) : raw;
    if (pattern.endsWith("/")) {
      expanded.push(`${pattern}**`);
    } else {
      expanded.push(pattern);
      if (!/[*?[\]{}()!]/.test(pattern)) expanded.push(`${pattern}/**`);
    }
  }
  if (expanded.length === 0) return () => false;
  return picomatch(expanded, { dot: true });
}

/** Maps files to components. Each file belongs to the first component whose globs match it. */
export class ComponentIndex {
  readonly components: readonly Component[];
  private readonly matchers: { id: string; match: PathMatcher; entry: PathMatcher | null }[];
  private readonly byId = new Map<string, Component>();
  private readonly cache = new Map<string, string | null>();
  private readonly workspaces: readonly WorkspacePackage[];

  constructor(components: readonly Component[], workspaces: readonly WorkspacePackage[] = []) {
    this.components = components;
    this.workspaces = [...workspaces].sort((a, b) => b.dir.length - a.dir.length);
    this.matchers = components.map((c) => ({
      id: c.id,
      match: globMatcher(c.paths),
      entry: c.entrypoints && c.entrypoints.length > 0 ? globMatcher(c.entrypoints) : null,
    }));
    for (const c of components) this.byId.set(c.id, c);
  }

  of(path: string): string | null {
    const cached = this.cache.get(path);
    if (cached !== undefined) return cached;
    const found = this.matchers.find((m) => m.match(path))?.id ?? null;
    this.cache.set(path, found);
    return found;
  }

  /** Component of a workspace package: the one declaring package: name, else the one owning its package.json. */
  ofPackage(name: string): string | null {
    const declared = this.components.find((c) => c.package === name);
    if (declared) return declared.id;
    const pkg = this.workspaces.find((w) => w.name === name);
    if (!pkg) return null;
    return this.of(pkg.dir === "" ? "package.json" : `${pkg.dir}/package.json`);
  }

  /** Workspace package whose directory contains the file (innermost wins). */
  packageOfFile(path: string): string | undefined {
    return this.workspaces.find((w) => w.dir === "" || path.startsWith(`${w.dir}/`))?.name;
  }

  get(id: string): Component | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  ids(): string[] {
    return this.components.map((c) => c.id);
  }

  hasEntrypoints(id: string): boolean {
    return this.matchers.find((m) => m.id === id)?.entry != null;
  }

  isEntrypoint(id: string, path: string): boolean {
    const entry = this.matchers.find((m) => m.id === id)?.entry;
    return entry ? entry(path) : false;
  }
}
