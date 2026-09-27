// Cache files under <root>/.architect/cache. Every file is versioned JSON that callers treat as absent
// when it is missing, unreadable, or from another format. Writes go through a temp file and a rename
// because hooks can run concurrently. Paths inside are repo-relative.
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { FileFacts, Graph } from "../../model/index.ts";

export const CACHE_FORMAT = 1;

export type StoredFacts = Omit<FileFacts, "path">;

/** The last graph of the working tree, with what is needed to update it incrementally. */
export interface WorktreeCache {
  format: typeof CACHE_FORMAT;
  kind: "worktree";
  /** Analyzer id to version. */
  analyzers: Record<string, string>;
  /** Hash of architecture.settings. */
  settings: string;
  /** Every listed file (analyzed or not), sorted. */
  files: string[];
  /** FileSource stamps of the analyzed files. */
  stamps: Record<string, string>;
  /** Stamps of the files that influence import resolution. */
  configs: Record<string, string>;
  graph: Graph;
}

/** The finished graph of one commit. Commits never change, so the entry never goes stale. */
export interface CommitCache {
  format: typeof CACHE_FORMAT;
  kind: "commit";
  revision: string;
  analyzers: Record<string, string>;
  settings: string;
  graph: Graph;
}

export interface FactsCacheFile {
  format: typeof CACHE_FORMAT;
  kind: "facts";
  /** "<analyzer>@<version>[+w<resources hash>]:<contentId>" to facts without the path, most recently used first. */
  entries: Record<string, StoredFacts>;
}

export const worktreeCachePath = (dir: string) => `${dir}/graph/worktree.json`;
export const commitCachePath = (dir: string, revision: string) => `${dir}/graph/commits/${revision}.json`;
export const factsCachePath = (dir: string) => `${dir}/graph/facts.json`;
export const historyCachePath = (dir: string) => `${dir}/history.json`;

/** Parsed cache file of the given kind, or null when it is missing, corrupt, or from another format. */
export async function readCache<T extends { kind: string }>(path: string, kind: T["kind"]): Promise<T | null> {
  try {
    const value = JSON.parse(await Bun.file(path).text()) as Record<string, unknown> | null;
    if (!value || value.format !== CACHE_FORMAT || value.kind !== kind) return null;
    return value as unknown as T;
  } catch {
    return null;
  }
}

/** Writes JSON atomically. A failed write only costs speed, so it is reported on stderr and ignored. */
export async function writeCache(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(temp, JSON.stringify(value));
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    console.error(`architect: could not write cache ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** JSON with object keys sorted, so equal values always hash the same. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Content-addressed facts shared by worktree and git builds. Loaded on first use and saved only when it grew. */
export class FactsStore {
  private old: Map<string, StoredFacts> | null = null;
  private readonly used = new Map<string, StoredFacts>();
  private added = false;

  constructor(private readonly path: string) {}

  async get(key: string): Promise<StoredFacts | undefined> {
    this.old ??= new Map(Object.entries((await readCache<FactsCacheFile>(this.path, "facts"))?.entries ?? {}));
    const hit = this.used.get(key) ?? this.old.get(key);
    if (hit) this.used.set(key, hit);
    return hit;
  }

  set(key: string, facts: StoredFacts): void {
    this.used.set(key, facts);
    this.added = true;
  }

  /** Keeps every entry this build used, then older ones up to a bound so the file cannot grow forever. */
  async save(): Promise<void> {
    if (!this.added) return;
    const limit = Math.max(20_000, this.used.size * 2);
    const entries: Record<string, StoredFacts> = {};
    let count = 0;
    for (const [key, facts] of this.used) {
      entries[key] = facts;
      count++;
    }
    for (const [key, facts] of this.old ?? []) {
      if (count >= limit) break;
      if (this.used.has(key)) continue;
      entries[key] = facts;
      count++;
    }
    const file: FactsCacheFile = { format: CACHE_FORMAT, kind: "facts", entries };
    await writeCache(this.path, file);
  }
}
