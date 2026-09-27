import { buildContext, type ContextBrief } from "../context/index.ts";
import { loadCards } from "../knowledge/index.ts";
import type { Finding, Graph } from "../model/index.ts";
import { applyBaseline, evaluateRules } from "../rules/index.ts";
import { UsageError } from "./errors.ts";
import { analyze, openWorkspace, repoPaths, requireValidContract, type Workspace } from "./workspace.ts";

export interface ContextOptions {
  /** Files the task touches, absolute or relative to cwd. */
  paths?: readonly string[];
  task?: string;
  /** Token budget (characters / 4). */
  budget?: number;
  detail?: "concise" | "full";
  today?: string;
}

/** Violations still open in the working tree: new and baselined findings, without waived or informational ones. */
export function openFindings(ws: Workspace, graph: Graph, files?: ReadonlySet<string>): Finding[] {
  const { architecture, rules, baseline } = ws.contract;
  const evaluated = evaluateRules({ graph, architecture, rules, today: ws.today, files });
  return applyBaseline(evaluated, baseline, { files }).findings.filter((finding) => finding.status !== "waived" && finding.level !== "info");
}

/** The brief an agent reads before editing: governing decisions, rules, component contracts, and open violations. */
export async function runContext(cwd: string, options: ContextOptions = {}): Promise<ContextBrief> {
  if (options.budget !== undefined && (!Number.isInteger(options.budget) || options.budget < 100)) {
    throw new UsageError("--budget must be a whole number of tokens, at least 100.");
  }
  const ws = await openWorkspace(cwd, { today: options.today });
  requireValidContract(ws);
  const paths = options.paths === undefined ? undefined : repoPaths(ws, cwd, options.paths);
  const { graph } = await analyze(ws);
  const { architecture, rules, decisions } = ws.contract;
  return buildContext({
    architecture,
    rules,
    decisions,
    graph,
    findings: openFindings(ws, graph),
    cards: loadCards(),
    paths,
    task: options.task,
    budget: options.budget,
    detail: options.detail,
  });
}
