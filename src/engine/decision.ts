import { existsSync } from "node:fs";
import { join } from "node:path";
import { openGitSource, type GitSource } from "../analysis/index.ts";
import { compareText, DecisionStatusSchema, normalizeDecisionId, type Assumption, type Decision, type DecisionStatus, type Evidence } from "../model/index.ts";
import {
  checkEvidence,
  CONTRACT_PATHS,
  decisionPath,
  lintDecisions,
  nextDecisionId,
  parseDecision,
  renderDecision,
  writeRepoFile,
  type DecisionLintIssue,
  type EvidenceCheck,
  type EvidenceReader,
} from "../store/index.ts";
import { UsageError } from "./errors.ts";
import { openWorkspace, type Workspace } from "./workspace.ts";

export interface DecisionSummary {
  id: string;
  title: string;
  status: DecisionStatus;
  date?: string;
  governs: string[];
  weakens: string[];
  file: string;
  imported: boolean;
}

function summary(decision: Decision): DecisionSummary {
  const result: DecisionSummary = {
    id: decision.id,
    title: decision.title,
    status: decision.status,
    governs: decision.governs,
    weakens: decision.weakens,
    file: decision.file,
    imported: decision.imported,
  };
  if (decision.date !== undefined) result.date = decision.date;
  return result;
}

export async function runDecisionList(cwd: string, options: { status?: string; today?: string } = {}): Promise<DecisionSummary[]> {
  const ws = await openWorkspace(cwd, { today: options.today });
  let status: DecisionStatus | undefined;
  if (options.status !== undefined) {
    const parsed = DecisionStatusSchema.safeParse(options.status);
    if (!parsed.success) throw new UsageError(`--status must be one of: ${DecisionStatusSchema.options.join(", ")}.`);
    status = parsed.data;
  }
  return ws.contract.decisions
    .filter((decision) => status === undefined || decision.status === status)
    .map(summary)
    .sort((a, b) => compareText(a.id, b.id));
}

export function formatDecisionList(decisions: readonly DecisionSummary[]): string {
  if (decisions.length === 0) return "No decisions.";
  return decisions
    .map((d) => {
      const scope = d.governs.length > 0 ? `  (governs ${d.governs.join(", ")})` : "";
      return `${d.id}  ${d.status.padEnd(10)}  ${d.title}${scope}`;
    })
    .join("\n");
}

/** Reads evidence sources from the working tree and from git objects, opening each revision once. */
function evidenceReader(ws: Workspace): { read: EvidenceReader; close: () => void } {
  const revisions = new Map<string, Promise<GitSource | null>>();
  const read: EvidenceReader = async (ref) => {
    if (ref.kind === "path") return ws.source.readFile(ref.path);
    let source = revisions.get(ref.revision);
    if (source === undefined) {
      source = openGitSource(ws.root, ref.revision).catch(() => null);
      revisions.set(ref.revision, source);
    }
    const git = await source;
    return git === null ? null : git.readFile(ref.path);
  };
  const close = () => {
    for (const source of revisions.values()) void source.then((git) => git?.close());
  };
  return { read, close };
}

async function checkAll(ws: Workspace, decisions: readonly Decision[]): Promise<Map<string, EvidenceCheck[]>> {
  const reader = evidenceReader(ws);
  try {
    const checks = new Map<string, EvidenceCheck[]>();
    for (const decision of decisions) checks.set(decision.id, await checkEvidence(decision.evidence, reader.read));
    return checks;
  } finally {
    reader.close();
  }
}

export interface DecisionLintResult {
  checked: number;
  issues: DecisionLintIssue[];
  /** Evidence checks by decision id. */
  evidence: Record<string, EvidenceCheck[]>;
  exit_code: 0 | 1;
}

function isDecisionFile(ws: Workspace, file: string): boolean {
  const dirs = [`${CONTRACT_PATHS.dir}/decisions/`, ...(ws.contract.architecture.settings.adr_dirs ?? []).map((dir) => `${dir.replace(/\/$/, "")}/`)];
  return dirs.some((dir) => file.startsWith(dir));
}

/** Lints decisions (all, or the given ids): front matter, references, assumptions, and verbatim evidence. */
export async function runDecisionLint(cwd: string, options: { ids?: readonly string[]; today?: string } = {}): Promise<DecisionLintResult> {
  const ws = await openWorkspace(cwd, { today: options.today });
  const all = ws.contract.decisions;
  let selected = all;
  if (options.ids !== undefined && options.ids.length > 0) {
    const wanted = new Set<string>();
    for (const ref of options.ids) {
      const id = normalizeDecisionId(ref);
      if (id === null || !all.some((decision) => decision.id === id)) throw new UsageError(`Unknown decision "${ref}".`);
      wanted.add(id);
    }
    selected = all.filter((decision) => wanted.has(decision.id));
  }
  const evidence = await checkAll(ws, selected);
  const files = await ws.source.listFiles();
  const selectedIds = new Set(selected.map((decision) => decision.id));
  const selectedFiles = new Set(selected.map((decision) => decision.file));
  const issues = lintDecisions({ decisions: all, architecture: ws.contract.architecture, rules: ws.contract.rules, files, today: ws.today, evidence }).filter(
    (issue) => selectedIds.has(issue.decision),
  );
  for (const issue of ws.contract.issues) {
    if (!isDecisionFile(ws, issue.file)) continue;
    if (options.ids !== undefined && options.ids.length > 0 && !selectedFiles.has(issue.file)) continue;
    const id = all.find((decision) => decision.file === issue.file)?.id ?? issue.file;
    issues.push({ decision: id, file: issue.file, level: issue.level, message: issue.path ? `${issue.path}: ${issue.message}` : issue.message });
  }
  issues.sort((a, b) => compareText(a.decision, b.decision) || compareText(a.level, b.level) || compareText(a.message, b.message));
  return {
    checked: selected.length,
    issues,
    evidence: Object.fromEntries([...evidence].sort((a, b) => compareText(a[0], b[0]))),
    exit_code: issues.some((issue) => issue.level === "error") ? 1 : 0,
  };
}

export function formatDecisionLint(result: DecisionLintResult): string {
  const lines = result.issues.map((issue) => `${issue.level === "error" ? "error" : "warn "}  ${issue.decision}  ${issue.message}`);
  const errors = result.issues.filter((issue) => issue.level === "error").length;
  const verified = Object.values(result.evidence).flat().filter((check) => check.status === "verified").length;
  lines.push(
    `Checked ${result.checked} decision${result.checked === 1 ? "" : "s"}: ${errors} error${errors === 1 ? "" : "s"}, ${result.issues.length - errors} warning${result.issues.length - errors === 1 ? "" : "s"}, ${verified} verified quote${verified === 1 ? "" : "s"}.`,
  );
  return lines.join("\n");
}

export interface NewDecisionOptions {
  title: string;
  governs?: readonly string[];
  weakens?: readonly string[];
  supersedes?: readonly string[];
  today?: string;
}

/** Writes a proposed MADR skeleton with TODO: placeholders for a person or agent to fill in. */
export async function runDecisionNew(cwd: string, options: NewDecisionOptions): Promise<{ id: string; path: string }> {
  const title = options.title.trim();
  if (title === "") throw new UsageError("A decision needs a title.");
  const ws = await openWorkspace(cwd, { today: options.today });
  const id = freeId(ws);
  const path = decisionPath(id, title);
  const text = renderDecision({
    id,
    title,
    status: "proposed",
    date: ws.today,
    governs: [...(options.governs ?? [])],
    weakens: [...(options.weakens ?? [])],
    supersedes: (options.supersedes ?? []).map((ref) => normalizeDecisionId(ref) ?? ref),
    context: "TODO: Describe the problem, the forces at play, and the quality scenario at stake. Cite evidence in the front matter.",
    options: ["TODO: the option you recommend", "TODO: the strongest alternative"],
    outcome: "TODO: explain why it beats the alternatives.",
    consequences: ["Good, because TODO: what gets easier.", "Bad, because TODO: what it costs."],
  });
  await writeRepoFile(ws.root, path, text);
  return { id, path };
}

/** The next free id, skipping any file that already uses it. */
function freeId(ws: Workspace): string {
  let id = nextDecisionId(ws.contract.decisions);
  const taken = (candidate: string) => existsSync(join(ws.root, `${CONTRACT_PATHS.dir}/decisions`)) && ws.contract.decisions.some((d) => d.id === candidate);
  while (taken(id)) id = String(Number.parseInt(id, 10) + 1).padStart(4, "0");
  return id;
}

export interface ProposalInput {
  title: string;
  context: string;
  options: readonly string[];
  /** One of options; defaults to the first. */
  chosen?: string;
  outcome: string;
  drivers?: readonly string[];
  consequences?: readonly string[];
  governs?: readonly string[];
  weakens?: readonly string[];
  supersedes?: readonly string[];
  evidence?: readonly Evidence[];
  assumptions?: readonly Assumption[];
  decisionMakers?: readonly string[];
}

export interface ProposalResult {
  id: string;
  path: string;
  markdown: string;
  evidence: EvidenceCheck[];
  /** Lint warnings a reviewer should see, such as quotes from URLs that nobody verified. */
  warnings: string[];
}

/**
 * Writes a new decision with status proposed after checking it like decision lint does. Any error (an unknown component
 * or decision, an assumption checked by a missing rule, a quote not found verbatim in its source) rejects the proposal.
 */
export async function proposeDecision(cwd: string, input: ProposalInput, options: { today?: string } = {}): Promise<ProposalResult> {
  const problems: string[] = [];
  const title = input.title.trim();
  if (title === "") problems.push("title is empty.");
  if (input.context.trim() === "") problems.push("context is empty.");
  if (input.outcome.trim() === "") problems.push("outcome is empty.");
  const choices = input.options.map((option) => option.trim()).filter((option) => option !== "");
  if (choices.length === 0) problems.push("options needs at least one option.");
  if (input.chosen !== undefined && !choices.includes(input.chosen.trim())) problems.push(`chosen "${input.chosen}" is not one of the options.`);
  if (problems.length > 0) throw new UsageError(`The proposal was rejected:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

  const ws = await openWorkspace(cwd, { today: options.today });
  const id = freeId(ws);
  const path = decisionPath(id, title);
  const markdown = renderDecision({
    id,
    title,
    status: "proposed",
    date: ws.today,
    decisionMakers: input.decisionMakers ? [...input.decisionMakers] : undefined,
    governs: input.governs ? [...input.governs] : undefined,
    weakens: input.weakens ? [...input.weakens] : undefined,
    supersedes: input.supersedes?.map((ref) => normalizeDecisionId(ref) ?? ref),
    assumptions: input.assumptions ? [...input.assumptions] : undefined,
    evidence: input.evidence ? [...input.evidence] : undefined,
    context: input.context,
    drivers: input.drivers ? [...input.drivers] : undefined,
    options: choices,
    chosen: input.chosen?.trim(),
    outcome: input.outcome,
    consequences: input.consequences ? [...input.consequences] : undefined,
  });
  const parsed = parseDecision(path, markdown);
  for (const issue of parsed.issues) if (issue.level === "error") problems.push(issue.path ? `${issue.path}: ${issue.message}` : issue.message);
  const decision = parsed.decision;
  const evidence = await checkAll(ws, [decision]);
  const files = await ws.source.listFiles();
  const issues = lintDecisions({
    decisions: [...ws.contract.decisions, decision],
    architecture: ws.contract.architecture,
    rules: ws.contract.rules,
    files,
    today: ws.today,
    evidence,
  }).filter((issue) => issue.decision === id);
  problems.push(...issues.filter((issue) => issue.level === "error").map((issue) => issue.message));
  if (problems.length > 0) throw new UsageError(`The proposal was rejected:\n${problems.map((p) => `  - ${p}`).join("\n")}`);

  await writeRepoFile(ws.root, path, markdown);
  return {
    id,
    path,
    markdown,
    evidence: evidence.get(id) ?? [],
    warnings: issues.filter((issue) => issue.level === "warn").map((issue) => issue.message),
  };
}
