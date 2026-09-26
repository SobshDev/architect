import type { ConfigIssue, DecisionStatus, ReportSummary, RuleLevel } from "../model/index.ts";
import { checkWorkspace } from "./check.ts";
import { openWorkspace } from "./workspace.ts";

export interface StatusResult {
  root: string;
  contract: {
    components: number;
    resources: number;
    rules: Record<RuleLevel, number>;
    decisions: Partial<Record<DecisionStatus, number>>;
    waivers: number;
  };
  baseline: { entries: number; occurrences: number; fixed: number; remaining: number };
  summary: ReportSummary;
  coverage: { files: number; unmapped: number; unresolved: number; dynamic: number; parseErrors: number };
  issues: ConfigIssue[];
}

export async function runStatus(cwd: string, options: { today?: string } = {}): Promise<StatusResult> {
  const ws = await openWorkspace(cwd, options);
  const report = await checkWorkspace(ws, { scope: "all" });
  const { architecture, rules, decisions, baseline } = ws.contract;
  const levels: Record<RuleLevel, number> = { error: 0, warn: 0, off: 0 };
  for (const rule of rules.rules) levels[rule.level]++;
  const statuses: Partial<Record<DecisionStatus, number>> = {};
  for (const decision of decisions) statuses[decision.status] = (statuses[decision.status] ?? 0) + 1;
  const occurrences = baseline.entries.reduce((sum, entry) => sum + entry.count, 0);
  return {
    root: ws.root,
    contract: { components: architecture.components.length, resources: architecture.resources.length, rules: levels, decisions: statuses, waivers: rules.waivers.length },
    baseline: { entries: baseline.entries.length, occurrences, fixed: report.summary.fixed, remaining: occurrences - report.summary.fixed },
    summary: report.summary,
    coverage: {
      files: report.coverage.files_analyzed,
      unmapped: report.coverage.unmapped_files.length,
      unresolved: report.coverage.unresolved_imports.length,
      dynamic: report.coverage.dynamic_imports.length,
      parseErrors: report.coverage.parse_errors.length,
    },
    issues: report.config_issues,
  };
}

export function formatStatus(status: StatusResult): string {
  const { contract, baseline, summary, coverage } = status;
  const decisions = Object.entries(contract.decisions)
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");
  const lines = [
    `Contract: ${contract.components} components, ${contract.rules.error + contract.rules.warn + contract.rules.off} rules (${contract.rules.error} error, ${contract.rules.warn} warn, ${contract.rules.off} off), ${decisions || "no decisions"}, ${contract.waivers} waivers`,
  ];
  if (baseline.occurrences === 0) {
    lines.push("Baseline: empty.");
  } else {
    const percent = Math.round((100 * baseline.fixed) / baseline.occurrences);
    lines.push(`Baseline: ${baseline.occurrences} accepted violations in ${baseline.entries} entries; ${baseline.fixed} fixed (${percent}%), ${baseline.remaining} remaining.`);
    if (baseline.fixed > 0) lines.push("  Run `architect baseline update` to lock in the progress.");
  }
  lines.push(`Check: ${summary.errors} new errors, ${summary.warnings} new warnings, ${summary.info} notes.`);
  lines.push(
    `Coverage: ${coverage.files} files analyzed, ${coverage.unmapped} unmapped, ${coverage.unresolved} unresolved imports, ${coverage.dynamic} dynamic imports, ${coverage.parseErrors} parse errors.`,
  );
  for (const issue of status.issues) lines.push(`${issue.level === "error" ? "config error" : "config warning"} ${issue.file}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`);
  return lines.join("\n");
}
