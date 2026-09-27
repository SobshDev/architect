import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { changedFiles, headSha } from "../analysis/index.ts";
import { matchPrompt, promptBrief, sessionBrief } from "../context/index.ts";
import {
  formatHookOutput,
  HookInputError,
  isEditTool,
  parseHookInput,
  type HookAgent,
  type HookEvent,
  type HookInput,
  type HookResult,
} from "../integrations/index.ts";
import { ARCHITECT_DIR, compareText, normalizeDecisionId, toRepoPath, type Finding } from "../model/index.ts";
import { CONTRACT_PATHS } from "../store/index.ts";
import { openFindings } from "./context.ts";
import { analyze, contractIssues, hasConfigErrors, openWorkspace, type Workspace } from "./workspace.ts";

export interface HookRun {
  /** JSON for the host, or "" when Architect has nothing to say. */
  stdout: string;
  /** Always 0: a failing hook must never break the host session. Problems go to stderr. */
  exitCode: 0;
  /** Diagnostics for stderr. */
  stderr: string;
}

/** Error findings present when the session started, so edits are judged only by what they add. */
interface SessionSnapshot {
  version: 1;
  head: string | null;
  counts: Record<string, number>;
}

const MAX_LISTED = 5;

/** Runs one hook event: reads the host payload, checks the edit or session, and returns the host's JSON. */
export async function runHook(event: HookEvent, agent: HookAgent, stdin: string, options: { today?: string } = {}): Promise<HookRun> {
  let input: HookInput;
  try {
    input = parseHookInput(agent, event, JSON.parse(stdin));
  } catch (error) {
    const reason = error instanceof HookInputError || error instanceof SyntaxError ? error.message : String(error);
    return { stdout: "", exitCode: 0, stderr: `architect hook: ignored an unreadable ${event} payload: ${reason}\n` };
  }
  try {
    const ws = await openWorkspace(input.cwd, { today: options.today });
    if (!ws.contract.present.architecture) return { stdout: "", exitCode: 0, stderr: "" };
    const result = await handle(ws, input);
    return { stdout: formatHookOutput(agent, event, result, input), exitCode: 0, stderr: "" };
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return { stdout: "", exitCode: 0, stderr: `architect hook: ${event} failed: ${detail}\n` };
  }
}

async function handle(ws: Workspace, input: HookInput): Promise<HookResult> {
  const issues = contractIssues(ws);
  if (hasConfigErrors(issues)) {
    const list = issues.filter((issue) => issue.level === "error").map((issue) => `- ${issue.file}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`);
    const message = `Architect's contract in .architect/ has errors, so edits are not checked until they are fixed:\n${list.join("\n")}`;
    if (input.event === "Stop") return { block: message };
    return { context: message };
  }
  switch (input.event) {
    case "SessionStart":
      return sessionStart(ws, input);
    case "UserPromptSubmit":
      return userPrompt(ws, input);
    case "PostToolUse":
      return postToolUse(ws, input);
    case "Stop":
      return stop(ws, input);
  }
}

// ---------------------------------------------------------------- session snapshot

function snapshotPath(ws: Workspace, sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "session";
  return join(ws.cacheDir, "sessions", `${safe}.json`);
}

async function readSnapshot(ws: Workspace, sessionId: string): Promise<SessionSnapshot | null> {
  try {
    const parsed = JSON.parse(await readFile(snapshotPath(ws, sessionId), "utf8")) as SessionSnapshot;
    return parsed.version === 1 && typeof parsed.counts === "object" ? parsed : null;
  } catch {
    return null;
  }
}

async function writeSnapshot(ws: Workspace, sessionId: string, snapshot: SessionSnapshot): Promise<void> {
  const path = snapshotPath(ws, sessionId);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(snapshot));
}

function errorCounts(findings: readonly Finding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    if (finding.status !== "new" || finding.level !== "error") continue;
    counts[finding.fingerprint] = (counts[finding.fingerprint] ?? 0) + 1;
  }
  return counts;
}

/** New findings beyond what the session started with (or, without a snapshot, beyond the baseline alone). */
function introduced(findings: readonly Finding[], snapshot: SessionSnapshot | null): Finding[] {
  const left = new Map(Object.entries(snapshot?.counts ?? {}));
  const result: Finding[] = [];
  for (const finding of findings) {
    if (finding.status !== "new") continue;
    const allowance = left.get(finding.fingerprint) ?? 0;
    if (finding.level === "error" && allowance > 0) {
      left.set(finding.fingerprint, allowance - 1);
      continue;
    }
    result.push(finding);
  }
  return result;
}

// ---------------------------------------------------------------- events

async function sessionStart(ws: Workspace, input: HookInput): Promise<HookResult> {
  const { graph } = await analyze(ws);
  const findings = openFindings(ws, graph);
  // Only a fresh session takes a snapshot; resume, clear, and compaction keep the original so earlier edits stay visible.
  const existing = await readSnapshot(ws, input.sessionId);
  if (existing === null || input.source === "startup") {
    await writeSnapshot(ws, input.sessionId, { version: 1, head: await headSha(ws.root), counts: errorCounts(findings) });
  }
  const { architecture, rules, decisions } = ws.contract;
  const brief = sessionBrief({ architecture, rules, decisions, graph, findings });
  return brief.markdown === "" ? {} : { context: brief.markdown };
}

async function userPrompt(ws: Workspace, input: HookInput): Promise<HookResult> {
  const { architecture, rules, decisions } = ws.contract;
  const match = matchPrompt(input.prompt ?? "", architecture, decisions);
  if (match === null) return {};
  const { graph } = await analyze(ws);
  const brief = promptBrief({ architecture, rules, decisions, graph, findings: openFindings(ws, graph) }, match);
  return brief.markdown === "" ? {} : { context: brief.markdown };
}

async function postToolUse(ws: Workspace, input: HookInput): Promise<HookResult> {
  if (input.toolName === undefined || !isEditTool(input.agent, input.toolName)) return {};
  const changed = inRepo(ws, input.changed);
  const deleted = inRepo(ws, input.deleted);
  const contractEdits = [...changed, ...deleted].filter(isContractFile);
  const code = changed.filter((path) => !isContractFile(path));
  const notes: string[] = [];
  if (contractEdits.length > 0) {
    notes.push(
      `You edited ${contractEdits.join(", ")}. Loosening a rule (removing it, lowering its level, narrowing it, adding a waiver, or growing the baseline) needs an accepted decision that lists it in weakens. Propose one with architect decision new or the architect_propose_decision tool; a person accepts it.`,
    );
  }
  let findings: Finding[] = [];
  if (code.length > 0 || deleted.length > 0) {
    const files = new Set(code);
    const { graph } = await analyze(ws, { only: code, deleted: deleted.filter((path) => !isContractFile(path)) });
    findings = introduced(openFindings(ws, graph, files), await readSnapshot(ws, input.sessionId));
  }
  const errors = findings.filter((finding) => finding.level === "error");
  const warnings = findings.filter((finding) => finding.level === "warn");
  if (warnings.length > 0) notes.push(`Architect warnings for this edit:\n${describe(ws, warnings)}`);
  const result: HookResult = {};
  if (errors.length > 0) {
    result.block = [
      `Architect: this edit breaks ${errors.length === 1 ? "a rule" : `${errors.length} rules`} of the design contract.`,
      describe(ws, errors),
      "The change is already on disk. Fix it so the check passes. If the rule itself should change, propose a decision (architect decision new, or the architect_propose_decision tool) and let a person accept it. Details: architect explain rule:<id>.",
    ].join("\n\n");
  }
  if (notes.length > 0) result.context = notes.join("\n\n");
  return result;
}

async function stop(ws: Workspace, input: HookInput): Promise<HookResult> {
  const snapshot = await readSnapshot(ws, input.sessionId);
  const changes = await changedFiles(ws.root, snapshot?.head ?? "HEAD").catch(() => null);
  if (changes === null) return {};
  const code = changes.changed.filter((path) => !isContractFile(path));
  if (code.length === 0 && changes.deleted.length === 0) return {};
  const { graph } = await analyze(ws);
  const errors = introduced(openFindings(ws, graph, new Set(code)), snapshot).filter((finding) => finding.level === "error");
  if (errors.length === 0) return {};
  return {
    block: [
      `Architect: files changed in this session still break ${errors.length === 1 ? "a rule" : `${errors.length} rules`} of the design contract.`,
      describe(ws, errors),
      "Fix them before finishing, or explain in your final message which decision a person should accept (architect decision new) and why.",
    ].join("\n\n"),
  };
}

// ---------------------------------------------------------------- helpers

function isContractFile(path: string): boolean {
  return (path === ARCHITECT_DIR || path.startsWith(`${ARCHITECT_DIR}/`)) && !path.startsWith(`${CONTRACT_PATHS.cache}/`);
}

/** The real path of a file, or of its nearest existing ancestor joined with the rest (for deleted files). */
function realPath(path: string): string {
  const missing: string[] = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

/** Absolute host paths as repo paths, dropping any outside the repository. */
function inRepo(ws: Workspace, paths: readonly string[]): string[] {
  const root = realPath(ws.root);
  const result = new Set<string>();
  for (const path of paths) {
    const rel = relative(root, realPath(path));
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) continue;
    result.add(toRepoPath(rel));
  }
  return [...result].sort(compareText);
}

function describe(ws: Workspace, findings: readonly Finding[]): string {
  // Rules may cite "2" for decision 0002, so ids are normalized before the lookup.
  const decisions = new Map(ws.contract.decisions.map((decision) => [decision.id, decision]));
  const lines: string[] = [];
  for (const finding of findings.slice(0, MAX_LISTED)) {
    const where = finding.location ? `${finding.location.file}${finding.location.line ? `:${finding.location.line}` : ""} ` : "";
    lines.push(`- ${finding.rule} (${finding.level}) ${where}${finding.message}`);
    if (finding.because.length > 0) {
      const why = finding.because.map((ref) => {
        const decision = decisions.get(normalizeDecisionId(ref) ?? ref);
        return decision === undefined ? `decision ${ref}` : `decision ${decision.id} "${decision.title}" (${decision.file})`;
      });
      lines.push(`  Why: ${why.join(", ")}.`);
    }
    if (finding.fix_hint) lines.push(`  Fix: ${finding.fix_hint}`);
  }
  if (findings.length > MAX_LISTED) lines.push(`- and ${findings.length - MAX_LISTED} more (architect check --changed lists them all).`);
  return lines.join("\n");
}
