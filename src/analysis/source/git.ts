import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { mapLimit } from "./text.ts";

export const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };

export interface GitResult {
  code: number;
  stdout: Uint8Array;
  stderr: string;
}

/** Exit code reported when git cannot start (missing binary or directory), as a shell would for a missing command. */
export const GIT_UNAVAILABLE = 127;

/** Runs git in `cwd` without a shell. Never throws: when git cannot start, the result has code GIT_UNAVAILABLE. */
export async function tryGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["git", ...args], { cwd, env: GIT_ENV, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  } catch (error) {
    return { code: GIT_UNAVAILABLE, stdout: new Uint8Array(), stderr: `git could not start: ${(error as Error).message}` };
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).bytes(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

/** Runs git and returns stdout; throws an Error carrying git's stderr on a nonzero exit. */
export async function git(cwd: string, args: readonly string[]): Promise<Uint8Array> {
  const result = await tryGit(cwd, args);
  if (result.code !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${result.code}): ${result.stderr.trim() || "no output"}`);
  }
  return result.stdout;
}

/** Splits NUL-terminated git output (-z) into strings. */
export function splitNul(bytes: Uint8Array): string[] {
  const text = new TextDecoder().decode(bytes);
  const parts = text.split("\0");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

function firstLine(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim();
}

/** Top level of the git work tree containing `start`, or null outside git. */
export async function findRepoRoot(start: string): Promise<string | null> {
  const result = await tryGit(start, ["rev-parse", "--show-toplevel"]);
  const root = firstLine(result.stdout);
  return result.code === 0 && root ? root : null;
}

/** Full sha of the commit `ref` names, or null when it does not resolve to a commit. */
export async function resolveRef(root: string, ref: string): Promise<string | null> {
  const result = await tryGit(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const sha = firstLine(result.stdout);
  return result.code === 0 && sha ? sha : null;
}

/** Sha of HEAD, or null in a repository without commits. */
export function headSha(root: string): Promise<string | null> {
  return resolveRef(root, "HEAD");
}

/** Best common ancestor of two commits, or null when they share none or either does not resolve. */
export async function mergeBase(root: string, a: string, b: string): Promise<string | null> {
  const result = await tryGit(root, ["merge-base", "--end-of-options", a, b]);
  const sha = firstLine(result.stdout);
  return result.code === 0 && sha ? sha : null;
}

/** Keeps the paths that are regular files on disk under `root` (drops deleted files, directories, gitlinks, symlinks). */
export async function regularFiles(root: string, paths: readonly string[]): Promise<string[]> {
  const kept = await mapLimit(paths, 64, async (path) => {
    try {
      return (await lstat(join(root, path))).isFile() ? path : null;
    } catch {
      return null;
    }
  });
  return kept.filter((path): path is string => path !== null);
}

export interface ChangedFiles {
  /** Added or modified files that exist now as regular files, including untracked files git does not ignore. */
  changed: string[];
  /** Files present in `against` and gone from the working tree. */
  deleted: string[];
}

/**
 * Files that differ between the commit `against` and the working tree (staged or not), plus untracked
 * files git does not ignore. `root` must be the top of the work tree. In a repository without commits,
 * every listed file counts as changed.
 */
export async function changedFiles(root: string, against = "HEAD"): Promise<ChangedFiles> {
  const untracked = splitNul(await git(root, ["ls-files", "-z", "--others", "--exclude-standard"]));
  const base = await resolveRef(root, against);
  if (base === null) {
    if ((await headSha(root)) !== null) throw new Error(`"${against}" does not resolve to a commit in ${root}`);
    const listed = splitNul(await git(root, ["ls-files", "-z", "--cached"]));
    return { changed: await regularFiles(root, [...new Set([...listed, ...untracked])].sort()), deleted: [] };
  }
  const fields = splitNul(await git(root, ["diff", "--name-status", "-z", "--no-renames", base, "--"]));
  const modified: string[] = [...untracked];
  const deleted: string[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const status = fields[i] as string;
    const path = fields[i + 1] as string;
    if (status.startsWith("D")) deleted.push(path);
    else modified.push(path);
  }
  const changed = await regularFiles(root, [...new Set(modified)].sort());
  return { changed, deleted: [...new Set(deleted)].sort() };
}
