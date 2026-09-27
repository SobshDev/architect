// Commits from `git log --numstat` over a window anchored to HEAD's committer date, so the result depends only on
// HEAD and the settings. Paths are reported under their newest name: git lists commits newest first, so a rename
// seen in one commit maps its old path to the new one for every older commit.
import type { HistorySettings } from "../../model/index.ts";
import { GIT_ENV, tryGit } from "../source/git.ts";

export interface CommitFile {
  path: string;
  /** Lines added and deleted; zero for binary files. */
  added: number;
  deleted: number;
}

export interface CommitRecord {
  sha: string;
  /** Sorted by path, one entry per newest path. */
  files: CommitFile[];
}

export interface HistoryWindow {
  head: string;
  /** Start of the window: HEAD's committer date minus settings.months, as an ISO 8601 UTC timestamp. */
  since: string;
}

/** HEAD and the window start, or null outside git or in a repository without commits. */
export async function historyWindow(root: string, months: number): Promise<HistoryWindow | null> {
  const result = await tryGit(root, ["log", "-1", "--format=%H %ct", "HEAD", "--"]);
  if (result.code !== 0) return null;
  const [head, seconds] = new TextDecoder().decode(result.stdout).trim().split(" ");
  if (!head || !seconds) return null;
  const start = new Date(Number(seconds) * 1000);
  start.setUTCMonth(start.getUTCMonth() - months);
  return { head, since: start.toISOString().replace(/\.\d{3}Z$/, "Z") };
}

/** Commits of the history window, newest first, without merges and without commits touching more than max_files_per_commit files. */
export async function readCommits(root: string, settings: HistorySettings): Promise<CommitRecord[]> {
  const window = await historyWindow(root, settings.months);
  return window ? logCommits(root, window, settings) : [];
}

const LOG_ARGS = [
  "-c",
  "core.quotePath=false",
  "log",
  "--numstat",
  "-M",
  "--no-color",
  "--no-ext-diff",
  "--no-show-signature",
  "--format=%x00%H",
  "--no-walk=unsorted",
  "--stdin",
  "--",
];

/**
 * Line counts need a diff per commit, which dominates the cost, so the window's commits are split into
 * contiguous chunks logged by parallel git processes and joined back newest first.
 */
export async function logCommits(root: string, window: HistoryWindow, settings: HistorySettings): Promise<CommitRecord[]> {
  const listed = await tryGit(root, ["rev-list", "--no-merges", `--since=${window.since}`, window.head, "--"]);
  if (listed.code !== 0) return failed(listed.stderr, listed.code);
  const shas = new TextDecoder().decode(listed.stdout).split("\n").filter((s) => s !== "");
  if (shas.length === 0) return [];
  const workers = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4, Math.ceil(shas.length / 200)));
  const size = Math.ceil(shas.length / workers);
  const chunks = Array.from({ length: workers }, (_, i) => shas.slice(i * size, (i + 1) * size)).filter((c) => c.length > 0);
  const outputs = await Promise.all(chunks.map((chunk) => gitWithInput(root, LOG_ARGS, `${chunk.join("\n")}\n`)));
  const bad = outputs.find((o) => o.code !== 0);
  if (bad) return failed(bad.stderr, bad.code);
  return parseNumstatLog(outputs.map((o) => o.stdout).join(""), settings.max_files_per_commit);
}

function failed(stderr: string, code: number): CommitRecord[] {
  console.error(`architect: git log failed, history skipped: ${stderr.trim() || `exit ${code}`}`);
  return [];
}

async function gitWithInput(cwd: string, args: readonly string[], input: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, env: GIT_ENV, stdin: new Blob([input]), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  } catch (error) {
    return { code: 127, stdout: "", stderr: `git could not start: ${(error as Error).message}` };
  }
}

interface RawEntry {
  path: string;
  old?: string;
  added: number;
  deleted: number;
}

/** Parses `git log --numstat --format=%x00%H` output (newest commit first). */
export function parseNumstatLog(output: string, maxFiles: number): CommitRecord[] {
  const newest = new Map<string, string>();
  const commits: CommitRecord[] = [];
  let sha: string | null = null;
  let entries: RawEntry[] = [];

  const flush = () => {
    if (sha === null) return;
    const resolved = entries.map((e) => ({ ...e, path: newest.get(e.path) ?? e.path }));
    // Renames apply to older commits only, so aliases are recorded after this commit's paths are resolved.
    for (const e of resolved) if (e.old !== undefined && e.old !== e.path) newest.set(e.old, e.path);
    // Oversized commits still teach renames (bulk moves are typical) but do not count.
    if (entries.length > 0 && entries.length <= maxFiles) {
      const files = new Map<string, CommitFile>();
      for (const e of resolved) {
        const file = files.get(e.path) ?? { path: e.path, added: 0, deleted: 0 };
        file.added += e.added;
        file.deleted += e.deleted;
        files.set(e.path, file);
      }
      commits.push({ sha, files: [...files.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) });
    }
    entries = [];
  };

  for (const line of output.split("\n")) {
    if (line.startsWith("\0")) {
      flush();
      sha = line.slice(1).trim();
      continue;
    }
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!match || sha === null) continue;
    const [, added, deleted, raw] = match as unknown as [string, string, string, string];
    entries.push({ ...parseNumstatPath(raw), added: added === "-" ? 0 : Number(added), deleted: deleted === "-" ? 0 : Number(deleted) });
  }
  flush();
  return commits;
}

/** Splits a numstat path into the new path and, for renames, the old one: "a => b" or "src/{old => new}/f.ts". */
export function parseNumstatPath(raw: string): { path: string; old?: string } {
  const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(raw);
  if (brace) {
    const [, pre, from, to, post] = brace as unknown as [string, string, string, string, string];
    return { path: tidy(pre + to + post), old: tidy(pre + from + post) };
  }
  const arrow = raw.indexOf(" => ");
  if (arrow >= 0) return { path: unquote(raw.slice(arrow + 4)), old: unquote(raw.slice(0, arrow)) };
  return { path: unquote(raw) };
}

/** Joins brace parts: "src/{ => sub}/f.ts" gives "src//f.ts" for the old side. */
function tidy(path: string): string {
  return unquote(path).replace(/\/{2,}/g, "/").replace(/^\//, "");
}

/** Git C-quotes paths with control characters or quotes even with core.quotePath=false. */
function unquote(path: string): string {
  if (path.length < 2 || !path.startsWith('"') || !path.endsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path;
  }
}
