import { contentId } from "./fingerprint.ts";

/**
 * One version of a repository's files: the working tree, or a commit read from git objects.
 * Paths are repo-relative, posix, without a leading "./".
 */
export interface FileSource {
  /** "worktree" or "<ref>@<short sha>". */
  readonly label: string;
  /** Absolute path of the repository root. */
  readonly root: string;
  /** Full commit sha for sources read from git objects. Their content never changes, so caches may key on it. */
  readonly revision?: string;
  /** Every file in this version, sorted. The worktree lists tracked and untracked files that git does not ignore. */
  listFiles(): Promise<string[]>;
  /** File text, or null when the file is missing or binary. */
  readFile(path: string): Promise<string | null>;
  /** Reads many files at once. Missing or binary files are absent from the result. */
  readFiles(paths: readonly string[]): Promise<Map<string, string>>;
  /**
   * Cheap change detector: equal stamps mean equal content. The worktree uses size and mtime;
   * git sources use the blob sha. Returns null for missing files.
   */
  stamp(path: string): Promise<string | null>;
}

/** Files held in memory. Used by tests and by callers that analyze content that is not on disk. */
export class MemorySource implements FileSource {
  readonly label: string;
  readonly root: string;
  private readonly files: Map<string, string>;

  constructor(files: Record<string, string> | ReadonlyMap<string, string>, options: { label?: string; root?: string } = {}) {
    this.files = new Map(files instanceof Map ? files : Object.entries(files));
    this.label = options.label ?? "memory";
    this.root = options.root ?? "/memory";
  }

  async listFiles(): Promise<string[]> {
    return [...this.files.keys()].sort();
  }

  async readFile(path: string): Promise<string | null> {
    return this.files.get(path) ?? null;
  }

  async readFiles(paths: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const path of paths) {
      const text = this.files.get(path);
      if (text !== undefined) out.set(path, text);
    }
    return out;
  }

  async stamp(path: string): Promise<string | null> {
    const text = this.files.get(path);
    return text === undefined ? null : contentId(text);
  }
}
