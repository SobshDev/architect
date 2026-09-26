import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { FileSource } from "../../model/index.ts";
import { regularFiles, splitNul, tryGit } from "./git.ts";
import { decodeText, mapLimit } from "./text.ts";

const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/** The files on disk. Inside git it lists tracked and untracked files that git does not ignore. */
export class WorktreeSource implements FileSource {
  readonly label = "worktree";
  readonly root: string;
  readonly revision: string | undefined = undefined;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async listFiles(): Promise<string[]> {
    const listed = await tryGit(this.root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (listed.code !== 0) return (await walk(this.root, "")).sort();
    const deleted = await tryGit(this.root, ["ls-files", "-z", "--deleted"]);
    const gone = new Set(deleted.code === 0 ? splitNul(deleted.stdout) : []);
    const paths = [...new Set(splitNul(listed.stdout))].filter((path) => !gone.has(path)).sort();
    return regularFiles(this.root, paths);
  }

  /** Text of the file, or null when it is missing or binary. Throws when it exists but cannot be read (EACCES). */
  async readFile(path: string): Promise<string | null> {
    const absolute = this.resolvePath(path);
    try {
      return decodeText(await readFile(absolute));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  /** Texts of the readable text files among paths; missing, binary, and unreadable files are left out. */
  async readFiles(paths: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(paths)];
    const texts = await mapLimit(unique, 64, (path) => this.readFile(path).catch(() => null));
    const out = new Map<string, string>();
    unique.forEach((path, i) => {
      const text = texts[i];
      if (text !== null && text !== undefined) out.set(path, text);
    });
    return out;
  }

  async stamp(path: string): Promise<string | null> {
    try {
      const info = await stat(this.resolvePath(path));
      return info.isFile() ? `${info.size}:${info.mtimeMs}` : null;
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  }

  private resolvePath(path: string): string {
    const absolute = resolve(this.root, path);
    const rel = relative(this.root, absolute);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
      throw new Error(`Path escapes the repository root: ${path}`);
    }
    return absolute;
  }
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR";
}

/** Regular files under dir, skipping .git, node_modules, and symlinks. */
async function walk(root: string, dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(join(root, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const path = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) out.push(...(await walk(root, path)));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}
