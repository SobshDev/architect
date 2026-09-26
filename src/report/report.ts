import { compareText, exitCodeFor, sortFindings, summarize, VERSION } from "../model/index.ts";
import type { ApiChange, BaselineEntry, ConfigIssue, Coverage, Finding, Report, Weakening } from "../model/index.ts";

export interface ReportInput {
  command: Report["command"];
  scope: Report["scope"];
  base?: string;
  head?: string;
  findings: readonly Finding[];
  fixed?: readonly BaselineEntry[];
  weakenings?: readonly Weakening[];
  apiChanges?: readonly ApiChange[];
  configIssues?: readonly ConfigIssue[];
  coverage?: Coverage;
}

export { compareText };

function byKeys<T>(...keys: ((item: T) => string | number)[]): (a: T, b: T) => number {
  return (a, b) => {
    for (const key of keys) {
      const x = key(a);
      const y = key(b);
      const order = typeof x === "number" && typeof y === "number" ? x - y : compareText(String(x), String(y));
      if (order !== 0) return order;
    }
    return 0;
  };
}

export function emptyCoverage(): Coverage {
  return { files_analyzed: 0, languages: {}, unmapped_files: [], unresolved_imports: [], dynamic_imports: [], parse_errors: [] };
}

/** Unapproved first, then by rule, type, and message. */
export function sortWeakenings(weakenings: readonly Weakening[]): Weakening[] {
  return [...weakenings].sort(
    byKeys<Weakening>(
      (w) => (w.approved_by === undefined ? 0 : 1),
      (w) => w.rule,
      (w) => w.type,
      (w) => w.message,
      (w) => w.approved_by ?? "",
    ),
  );
}

function sortCoverage(coverage: Coverage): Coverage {
  const languages: Record<string, number> = {};
  for (const key of Object.keys(coverage.languages).sort(compareText)) languages[key] = coverage.languages[key] ?? 0;
  return {
    files_analyzed: coverage.files_analyzed,
    languages,
    unmapped_files: [...coverage.unmapped_files].sort(compareText),
    unresolved_imports: [...coverage.unresolved_imports].sort(byKeys((i) => i.file, (i) => i.line, (i) => i.specifier)),
    dynamic_imports: [...coverage.dynamic_imports].sort(byKeys((i) => i.file, (i) => i.line, (i) => i.expression)),
    parse_errors: [...coverage.parse_errors].sort(byKeys((e) => e.file, (e) => e.message)),
  };
}

export function createReport(input: ReportInput): Report {
  const findings = sortFindings(input.findings);
  const fixed = [...(input.fixed ?? [])].sort(
    byKeys<BaselineEntry>((e) => e.rule, (e) => e.file ?? "", (e) => e.from ?? "", (e) => e.to ?? "", (e) => e.fingerprint),
  );
  const weakenings = sortWeakenings(input.weakenings ?? []).map((w) => ({ ...w, details: [...w.details].sort(compareText) }));
  const apiChanges = [...(input.apiChanges ?? [])].sort(
    byKeys<ApiChange>((c) => c.component, (c) => c.file, (c) => c.symbol, (c) => c.change),
  );
  const configIssues = [...(input.configIssues ?? [])].sort(
    byKeys<ConfigIssue>((i) => (i.level === "error" ? 0 : 1), (i) => i.file, (i) => i.path ?? "", (i) => i.message),
  );
  const summary = summarize(
    findings,
    fixed.reduce((sum, e) => sum + e.count, 0),
    weakenings,
  );
  const report: Report = {
    schema_version: 1,
    tool: { name: "architect", version: VERSION },
    command: input.command,
    scope: input.scope,
    summary,
    findings,
    fixed,
    weakenings,
    api_changes: apiChanges,
    config_issues: configIssues,
    coverage: sortCoverage(input.coverage ?? emptyCoverage()),
    exit_code: exitCodeFor(summary, configIssues),
  };
  if (input.base !== undefined) report.base = input.base;
  if (input.head !== undefined) report.head = input.head;
  return report;
}

/** 2-space JSON with a trailing newline. */
export function formatJson(report: Report): string {
  return JSON.stringify(report, null, 2) + "\n";
}

export function plural(count: number, word: string, many = word + "s"): string {
  return `${count} ${count === 1 ? word : many}`;
}
