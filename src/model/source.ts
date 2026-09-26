/**
 * One version of a repository's files: the working tree, or a commit read from git objects.
 * Paths are repo-relative, posix, without a leading "./".
 */
export interface FileSource {
  /** "worktree" or "<ref>@<short sha>". */
  readonly label: string;
  /** Absolute path of the repository root. */
  readonly root: string;
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
