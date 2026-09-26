import type { ConfigIssue, Finding, FindingLevel, ReportSummary, Weakening } from "./schema.ts";
import { compareText } from "./order.ts";

const LEVEL_ORDER: Record<FindingLevel, number> = { error: 0, warn: 1, info: 2 };

/** Deterministic order: level, rule, file, line, message, fingerprint. */
export function compareFindings(a: Finding, b: Finding): number {
  return (
    LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
    compareText(a.rule, b.rule) ||
    compareText(a.location?.file ?? "", b.location?.file ?? "") ||
    (a.location?.line ?? 0) - (b.location?.line ?? 0) ||
    compareText(a.message, b.message) ||
    compareText(a.fingerprint, b.fingerprint)
  );
}

export function sortFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(compareFindings);
}

export function summarize(findings: readonly Finding[], fixed: number, weakenings: readonly Weakening[]): ReportSummary {
  const count = (pred: (f: Finding) => boolean) => findings.filter(pred).length;
  const unapproved = weakenings.filter((w) => w.approved_by === undefined).length;
  return {
    errors: count((f) => f.status === "new" && f.level === "error"),
    warnings: count((f) => f.status === "new" && f.level === "warn"),
    info: count((f) => f.status === "new" && f.level === "info"),
    baselined: count((f) => f.status === "baselined"),
    waived: count((f) => f.status === "waived"),
    existing: count((f) => f.status === "existing"),
    fixed,
    weakenings: weakenings.length,
    unapproved_weakenings: unapproved,
  };
}

/** 2 for configuration errors, 1 for new error findings or unapproved weakenings, else 0. */
export function exitCodeFor(summary: ReportSummary, issues: readonly ConfigIssue[]): 0 | 1 | 2 {
  if (issues.some((i) => i.level === "error")) return 2;
  if (summary.errors > 0 || summary.unapproved_weakenings > 0) return 1;
  return 0;
}
