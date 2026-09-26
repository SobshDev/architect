import { sortFindings, type ApiChange, type BaselineEntry, type Finding, type Weakening, type WorkspaceState } from "../model/index.ts";
import { applyBaseline, decisionFindings, evaluateRules } from "../rules/index.ts";
import { apiStabilityFindings, diffApi } from "./api.ts";
import { deprecatedFindings, structureFindings } from "./structure.ts";
import { type Approval, approverOf, approvingDecisions, detectWeakenings } from "./weakening.ts";

export interface DiffInput {
  base: WorkspaceState;
  head: WorkspaceState;
  today: string;
}

export interface DiffResult {
  findings: Finding[];
  fixed: BaselineEntry[];
  weakenings: Weakening[];
  apiChanges: ApiChange[];
}

/**
 * Compares two versions of a repository. Head findings covered by the head baseline are baselined; occurrences
 * that already existed at base beyond what the baseline covers are existing; the rest are new. Diff-only rules,
 * structural changes, new decision problems, and weakenings are added on top.
 * An api-stability or deprecated finding whose rule an approving decision lists in weakens (see detectWeakenings)
 * is waived and names that decision in approved_by.
 */
export function diffStates({ base, head, today }: DiffInput): DiffResult {
  const evaluate = (state: WorkspaceState) => evaluateRules({ graph: state.graph, architecture: state.architecture, rules: state.rules, today });
  const { findings: afterBaseline, fixed } = applyBaseline(evaluate(head), head.baseline);

  const baselined = new Map<string, number>();
  for (const entry of head.baseline.entries) baselined.set(entry.fingerprint, (baselined.get(entry.fingerprint) ?? 0) + entry.count);
  const budget = new Map<string, number>();
  for (const finding of evaluate(base)) budget.set(finding.fingerprint, (budget.get(finding.fingerprint) ?? 0) + 1);
  for (const [fingerprint, count] of budget) budget.set(fingerprint, Math.max(0, count - (baselined.get(fingerprint) ?? 0)));
  const ruleFindings = afterBaseline.map((finding): Finding => {
    const left = budget.get(finding.fingerprint) ?? 0;
    if (finding.status !== "new" || left === 0) return finding;
    budget.set(finding.fingerprint, left - 1);
    return { ...finding, status: "existing" };
  });

  const apiChanges = diffApi(base, head);
  const approvals = approvingDecisions(base.decisions, head.decisions);
  const known = new Set(decisionFindings({ ...base, today }).map((finding) => finding.fingerprint));
  const decisions = decisionFindings({ ...head, today }).filter((finding) => !known.has(finding.fingerprint));
  return {
    findings: sortFindings([
      ...ruleFindings,
      ...approve(apiStabilityFindings(apiChanges, head), approvals),
      ...approve(deprecatedFindings(base, head), approvals),
      ...structureFindings(base, head),
      ...decisions,
    ]),
    fixed,
    weakenings: detectWeakenings(base, head, { today }),
    apiChanges,
  };
}

function approve(findings: readonly Finding[], approvals: readonly Approval[]): Finding[] {
  return findings.map((finding) => {
    const approver = approverOf(approvals, finding.rule);
    return approver ? { ...finding, status: "waived", approved_by: approver.id } : finding;
  });
}
