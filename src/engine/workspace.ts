import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  buildGraph,
  changedFiles,
  findRepoRoot,
  mergeBase,
  resolveRef,
  WorktreeSource,
  type BuildGraphOptions,
  type BuildGraphResult,
} from "../analysis/index.ts";
import { ARCHITECT_DIR, toRepoPath, type ConfigIssue } from "../model/index.ts";
import { CONTRACT_PATHS, loadContract, type Contract } from "../store/index.ts";
import { UsageError } from "./errors.ts";

/** One repository opened in its working tree, with its contract loaded. */
export interface Workspace {
  /** Absolute repository root. */
  root: string;
  /** ISO date used for waiver expiry and review dates. */
  today: string;
  source: WorktreeSource;
  contract: Contract;
  cacheDir: string;
}

export interface OpenOptions {
  today?: string;
}

export function localDate(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The explicit date, else ARCHITECT_TODAY (for reproducible runs), else the local date. */
export function resolveToday(explicit?: string): string {
  for (const value of [explicit, process.env.ARCHITECT_TODAY]) {
    if (value === undefined || value === "") continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new UsageError(`Invalid date "${value}". Use YYYY-MM-DD.`);
    return value;
  }
  return localDate();
}

/** The nearest ancestor holding .architect/, else the git top level, else cwd. */
export async function findRoot(cwd: string): Promise<string> {
  const start = resolve(cwd);
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ARCHITECT_DIR))) return dir;
    if (dirname(dir) === dir) break;
  }
  return (await findRepoRoot(start)) ?? start;
}

export async function openWorkspace(cwd: string, options: OpenOptions = {}): Promise<Workspace> {
  const root = await findRoot(cwd);
  const today = resolveToday(options.today);
  const source = new WorktreeSource(root);
  const contract = await loadContract(source, { today });
  return { root, today, source, contract, cacheDir: join(root, CONTRACT_PATHS.cache) };
}

/** The contract's issues, plus an error when the repository has no architecture file yet. */
export function contractIssues(ws: Workspace): ConfigIssue[] {
  const issues = [...ws.contract.issues];
  if (!ws.contract.present.architecture) {
    issues.push({ level: "error", file: CONTRACT_PATHS.architecture, message: "No architecture file. Run `architect init` to create one." });
  }
  return issues;
}

export function hasConfigErrors(issues: readonly ConfigIssue[]): boolean {
  return issues.some((issue) => issue.level === "error");
}

/** Throws a UsageError listing the contract's errors, for commands that cannot run without a valid contract. */
export function requireValidContract(ws: Workspace): void {
  const errors = contractIssues(ws).filter((issue) => issue.level === "error");
  if (errors.length === 0) return;
  const lines = errors.map((issue) => `  ${issue.file}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`);
  throw new UsageError(`The architecture contract has errors:\n${lines.join("\n")}`);
}

export function analyze(ws: Workspace, options: Omit<BuildGraphOptions, "cacheDir"> = {}): Promise<BuildGraphResult> {
  return buildGraph(ws.source, ws.contract.architecture, { ...options, cacheDir: ws.cacheDir });
}

export interface Changes {
  changed: string[];
  deleted: string[];
  /** The commit the working tree was compared with. */
  against: string;
}

/** Files changed in the working tree against HEAD, or against the merge base with base. Null outside git. */
export async function changedSince(ws: Workspace, base?: string): Promise<Changes | null> {
  if ((await findRepoRoot(ws.root)) === null) return null;
  let against = "HEAD";
  if (base !== undefined) {
    const baseSha = await resolveRef(ws.root, base);
    if (baseSha === null) throw new UsageError(`Unknown git ref "${base}". Fetch it first; CI needs fetch-depth: 0.`);
    against = (await mergeBase(ws.root, baseSha, "HEAD")) ?? baseSha;
  }
  return { ...(await changedFiles(ws.root, against)), against };
}

/** Converts paths given on the command line (absolute or relative to cwd) to repo paths. */
export function repoPaths(ws: Workspace, cwd: string, paths: readonly string[]): string[] {
  return paths.map((path) => toRepoPath(relative(ws.root, resolve(cwd, path))));
}
