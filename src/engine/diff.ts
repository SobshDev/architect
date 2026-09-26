import { realpathSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildGraph, findRepoRoot, mergeBase, openGitSource, resolveRef, type GitSource } from "../analysis/index.ts";
import { diffStates } from "../diff/index.ts";
import { keyFingerprint, type FileSource, type Finding, type Graph, type Report, type Rule, type WorkspaceState } from "../model/index.ts";
import { createReport, formatMarkdown, formatSarif } from "../report/index.ts";
import { CONTRACT_PATHS, loadContract, type Contract } from "../store/index.ts";
import { UsageError } from "./errors.ts";
import { hasConfigErrors, openWorkspace, type Workspace } from "./workspace.ts";

export interface DiffOptions {
  /** Git ref to compare against; the comparison starts at its merge base with head. */
  base: string;
  /** Git ref of the new version. Defaults to the working tree. */
  head?: string;
  today?: string;
}

export interface DiffOutcome {
  report: Report;
  rules: readonly Rule[];
}

export async function runDiff(cwd: string, options: DiffOptions, command: "diff" | "ci" = "diff"): Promise<DiffOutcome> {
  const ws = await openWorkspace(cwd, { today: options.today });
  await requireRepositoryRoot(ws);
  const baseSha = await resolveRef(ws.root, options.base);
  if (baseSha === null) throw new UsageError(`Unknown git ref "${options.base}". Fetch it first; CI checkouts need fetch-depth: 0.`);
  const headRef = options.head ?? "HEAD";
  if (options.head !== undefined && (await resolveRef(ws.root, options.head)) === null) throw new UsageError(`Unknown git ref "${options.head}".`);
  const start = (await resolveRef(ws.root, headRef)) === null ? baseSha : ((await mergeBase(ws.root, baseSha, headRef)) ?? baseSha);

  const baseSource = await openGitSource(ws.root, start);
  const headSource: GitSource | null = options.head === undefined ? null : await openGitSource(ws.root, options.head);
  try {
    const headContract = headSource === null ? ws.contract : await loadContract(headSource, { today: ws.today });
    const headLabel = headSource?.label ?? "worktree";
    const issues = [...headContract.issues];
    if (!headContract.present.architecture) {
      issues.push({ level: "error", file: CONTRACT_PATHS.architecture, message: "No architecture file. Run `architect init` to create one." });
    }
    if (hasConfigErrors(issues)) {
      return { report: createReport({ command, scope: "all", base: options.base, head: headLabel, findings: [], configIssues: issues }), rules: headContract.rules.rules };
    }
    const baseContract = await loadContract(baseSource, { today: ws.today });
    // Sequential on purpose: both builds share the cache directory.
    const baseBuild = await buildGraph(baseSource, baseContract.architecture, { cacheDir: ws.cacheDir });
    const headBuild = await buildGraph(headSource ?? ws.source, headContract.architecture, { cacheDir: ws.cacheDir });
    const result = diffStates({
      base: state(baseSource.label, baseContract, baseBuild.graph),
      head: state(headLabel, headContract, headBuild.graph),
      today: ws.today,
    });
    const report = createReport({
      command,
      scope: "all",
      base: options.base,
      head: headLabel,
      findings: [...result.findings, ...(await contractChanges(baseSource, headSource ?? ws.source))],
      fixed: result.fixed,
      weakenings: result.weakenings,
      apiChanges: result.apiChanges,
      configIssues: issues,
      coverage: headBuild.coverage,
    });
    return { report, rules: headContract.rules.rules };
  } finally {
    baseSource.close();
    headSource?.close();
  }
}

function state(label: string, contract: Contract, graph: Graph): WorkspaceState {
  return { label, graph, architecture: contract.architecture, rules: contract.rules, decisions: contract.decisions, baseline: contract.baseline };
}

/** diff and ci read git objects by repository path, so .architect/ has to sit at the repository root. */
async function requireRepositoryRoot(ws: Workspace): Promise<void> {
  const top = await findRepoRoot(ws.root);
  if (top === null) throw new UsageError("architect diff and ci need a git repository.");
  if (realpathSync(top) !== realpathSync(ws.root)) throw new UsageError(`architect diff and ci need .architect/ at the repository root (${top}).`);
}

/** One informational finding per contract file added, removed, or modified. */
async function contractChanges(base: FileSource, head: FileSource): Promise<Finding[]> {
  const contract = (files: string[]) => files.filter((file) => file.startsWith(`${CONTRACT_PATHS.dir}/`) && !file.startsWith(`${CONTRACT_PATHS.cache}/`));
  const before = new Set(contract(await base.listFiles()));
  const after = new Set(contract(await head.listFiles()));
  const findings: Finding[] = [];
  for (const path of [...new Set([...before, ...after])].sort()) {
    let change: "added" | "removed" | "modified" | null = null;
    if (!before.has(path)) change = "added";
    else if (!after.has(path)) change = "removed";
    else if ((await base.readFile(path)) !== (await head.readFile(path))) change = "modified";
    if (change === null) continue;
    findings.push({
      rule: "contract-changed",
      kind: "diff",
      level: "info",
      message: `${path} was ${change}.`,
      location: { file: path },
      because: [],
      fingerprint: keyFingerprint("contract-changed", path, change),
      status: "new",
    });
  }
  return findings;
}

export interface CiOptions {
  base?: string;
  head?: string;
  /** SARIF output path. Defaults to architect.sarif inside GitHub Actions, else none. */
  sarif?: string;
  /** Markdown summary path. Defaults to $GITHUB_STEP_SUMMARY. */
  summary?: string;
  today?: string;
}

export interface CiOutcome extends DiffOutcome {
  written: string[];
}

/** The diff as a CI gate: writes the Markdown step summary and a SARIF file. */
export async function runCi(cwd: string, options: CiOptions = {}): Promise<CiOutcome> {
  const base = options.base ?? (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : undefined);
  if (base === undefined) throw new UsageError("architect ci needs --base <ref>, or GITHUB_BASE_REF in a pull request build.");
  const outcome = await runDiff(cwd, { base, head: options.head, today: options.today }, "ci");
  const written: string[] = [];
  const summary = options.summary ?? process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== "") {
    await appendFile(summary, formatMarkdown(outcome.report));
    written.push(summary);
  }
  const sarif = options.sarif ?? (process.env.GITHUB_ACTIONS === "true" ? "architect.sarif" : undefined);
  if (sarif !== undefined) {
    const path = resolve(cwd, sarif);
    await Bun.write(path, formatSarif(outcome.report, { rules: outcome.rules }));
    written.push(path);
  }
  return { ...outcome, written };
}
