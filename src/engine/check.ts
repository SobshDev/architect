import type { Report, Rule } from "../model/index.ts";
import { createReport } from "../report/index.ts";
import { applyBaseline, decisionFindings, evaluateRules, metricFindings } from "../rules/index.ts";
import { driftFindings } from "./install.ts";
import { analyze, changedSince, contractIssues, hasConfigErrors, openWorkspace, repoPaths, type Workspace } from "./workspace.ts";

export interface CheckOptions {
  /** all (default), or changed: files changed against HEAD, or against the merge base with base. */
  scope?: "all" | "changed";
  base?: string;
  /** Explicit files, absolute or relative to cwd. Overrides scope. */
  files?: readonly string[];
  today?: string;
}

export interface CheckOutcome {
  report: Report;
  rules: readonly Rule[];
}

export async function runCheck(cwd: string, options: CheckOptions = {}): Promise<CheckOutcome> {
  const ws = await openWorkspace(cwd, { today: options.today });
  const files = options.files === undefined ? undefined : repoPaths(ws, cwd, options.files);
  return { report: await checkWorkspace(ws, { ...options, files }), rules: ws.contract.rules.rules };
}

/** options.files, when given, are repo paths. */
export async function checkWorkspace(ws: Workspace, options: CheckOptions = {}): Promise<Report> {
  let scope: Report["scope"] = options.files !== undefined ? "files" : (options.scope ?? "all");
  const issues = contractIssues(ws);
  if (hasConfigErrors(issues)) return createReport({ command: "check", scope, base: options.base, findings: [], configIssues: issues });

  let files: Set<string> | undefined;
  if (options.files !== undefined) {
    files = new Set(options.files);
  } else if (scope === "changed") {
    const changes = await changedSince(ws, options.base);
    if (changes === null) {
      issues.push({ level: "warn", file: ".", message: "Not a git repository, so every file was checked." });
      scope = "all";
    } else {
      files = new Set(changes.changed);
    }
  }

  const { graph, coverage } = await analyze(ws);
  const { architecture, rules, decisions, baseline } = ws.contract;
  const evaluated = evaluateRules({ graph, architecture, rules, today: ws.today, files });
  const informational =
    scope === "all" ? [...decisionFindings({ graph, architecture, rules, decisions, today: ws.today }), ...metricFindings(graph, architecture)] : [];
  const { findings, fixed } = applyBaseline([...evaluated, ...informational], baseline, { files });
  // Generated agent files that differ from what sync writes; never baselined, since sync fixes them.
  const drift = await driftFindings(ws);
  return createReport({ command: "check", scope, base: options.base, findings: [...findings, ...drift], fixed, configIssues: issues, coverage });
}
