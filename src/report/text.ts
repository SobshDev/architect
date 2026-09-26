import type { ApiChange, ConfigIssue, Finding, Report, Weakening } from "../model/index.ts";
import { plural, sortWeakenings } from "./report.ts";

// Plain text for terminals and hook messages: compact, no colors.

export function configIssueLine(issue: ConfigIssue): string {
  return `config ${issue.level} ${issue.file}${issue.path ? " " + issue.path : ""}: ${issue.message}`;
}

function findingBlock(finding: Finding, tag?: string): string[] {
  const head = `${finding.level.padEnd(5)}  ${finding.rule}  ${finding.message}${tag ? `  [${tag}]` : ""}`;
  const lines = [head];
  if (finding.location) lines.push(`  at ${finding.location.file}${finding.location.line ? ":" + finding.location.line : ""}`);
  if (finding.because.length > 0) lines.push(`  because: decision ${finding.because.join(", ")}`);
  if (finding.fix_hint) lines.push(`  fix: ${finding.fix_hint}`);
  return lines;
}

function weakeningBlock(w: Weakening): string[] {
  const state = w.approved_by === undefined ? "unapproved" : "approved";
  const lines = [`${state} weakening  ${w.rule}  ${w.type}: ${w.message}`];
  for (const detail of w.details) lines.push(`  - ${detail}`);
  if (w.approved_by !== undefined) lines.push(`  approved by decision ${w.approved_by}`);
  return lines;
}

function apiChangeBlocks(changes: readonly ApiChange[]): string[] {
  const lines: string[] = [];
  let component: string | undefined;
  for (const change of changes) {
    if (change.component !== component) {
      component = change.component;
      lines.push(`API changes in ${component}:`);
    }
    lines.push(`  ${change.change.padEnd(7)}  ${change.file}  ${change.symbol}`);
    if (change.before !== undefined && change.change !== "added") lines.push(`    - ${change.before}`);
    if (change.after !== undefined && change.change !== "removed") lines.push(`    + ${change.after}`);
  }
  return lines;
}

export function summaryLine(report: Report): string {
  const s = report.summary;
  const configErrors = report.config_issues.filter((i) => i.level === "error").length;
  const parts: string[] = [];
  if (configErrors > 0) parts.push(plural(configErrors, "config error"));
  if (s.errors > 0) parts.push(plural(s.errors, "error"));
  if (s.warnings > 0) parts.push(plural(s.warnings, "warning"));
  if (s.info > 0) parts.push(`${s.info} info`);
  if (s.existing > 0) parts.push(`${s.existing} existing`);
  if (s.baselined > 0) parts.push(`${s.baselined} baselined`);
  if (s.waived > 0) parts.push(`${s.waived} waived`);
  if (s.fixed > 0) parts.push(`${s.fixed} fixed (run architect baseline update to lock in progress)`);
  if (s.unapproved_weakenings > 0) parts.push(plural(s.unapproved_weakenings, "unapproved weakening"));
  const approved = s.weakenings - s.unapproved_weakenings;
  if (approved > 0) parts.push(plural(approved, "approved weakening"));
  if (report.api_changes.length > 0) parts.push(plural(report.api_changes.length, "API change"));
  if (s.errors === 0 && configErrors === 0) return ["No new errors.", parts.join(", ")].filter(Boolean).join(" ");
  return parts.join(", ");
}

export function coverageLine(report: Report): string | null {
  const c = report.coverage;
  const parts: string[] = [];
  if (c.unmapped_files.length > 0) parts.push(`${c.unmapped_files.length} unmapped`);
  if (c.unresolved_imports.length > 0) parts.push(plural(c.unresolved_imports.length, "unresolved import"));
  if (c.dynamic_imports.length > 0) parts.push(plural(c.dynamic_imports.length, "dynamic import"));
  if (c.parse_errors.length > 0) parts.push(plural(c.parse_errors.length, "parse error"));
  if (c.files_analyzed === 0 && parts.length === 0) return null;
  const analyzed = `Analyzed ${plural(c.files_analyzed, "file")}`;
  return parts.length > 0 ? `${analyzed}; ${parts.join(", ")}` : `${analyzed}.`;
}

export function formatText(report: Report, options: { verbose?: boolean } = {}): string {
  const blocks: string[][] = [];
  for (const issue of report.config_issues) blocks.push([configIssueLine(issue)]);
  const isNew = (f: Finding) => f.status === "new";
  for (const f of report.findings.filter((f) => isNew(f) && f.level === "error")) blocks.push(findingBlock(f));
  for (const f of report.findings.filter((f) => isNew(f) && f.level === "warn")) blocks.push(findingBlock(f));
  // A decision approved these in this change; they stay visible next to the weakenings.
  for (const f of report.findings.filter((f) => f.approved_by !== undefined)) blocks.push(findingBlock(f, `approved by decision ${f.approved_by}`));
  if (options.verbose) {
    for (const f of report.findings.filter((f) => isNew(f) && f.level === "info")) blocks.push(findingBlock(f));
    for (const f of report.findings.filter((f) => !isNew(f) && f.approved_by === undefined)) blocks.push(findingBlock(f, f.status));
  }
  for (const w of sortWeakenings(report.weakenings)) blocks.push(weakeningBlock(w));
  if (report.api_changes.length > 0) blocks.push(apiChangeBlocks(report.api_changes));
  if (options.verbose) {
    const c = report.coverage;
    if (report.fixed.length > 0) {
      blocks.push(["fixed baseline entries:", ...report.fixed.map((e) => `  ${e.rule}  ${e.file ?? e.from ?? ""}${e.to ? " -> " + e.to : ""}  x${e.count}`)]);
    }
    if (c.unmapped_files.length > 0) blocks.push(["unmapped files:", ...c.unmapped_files.map((f) => `  ${f}`)]);
    if (c.unresolved_imports.length > 0) {
      blocks.push(["unresolved imports:", ...c.unresolved_imports.map((i) => `  ${i.file}:${i.line}  ${i.specifier}`)]);
    }
    if (c.dynamic_imports.length > 0) {
      blocks.push(["dynamic imports:", ...c.dynamic_imports.map((i) => `  ${i.file}:${i.line}  ${i.expression}`)]);
    }
    if (c.parse_errors.length > 0) blocks.push(["parse errors:", ...c.parse_errors.map((e) => `  ${e.file}  ${e.message}`)]);
  }
  const footer = [summaryLine(report)];
  const coverage = coverageLine(report);
  if (coverage) footer.push(coverage);
  blocks.push(footer);
  return blocks.map((b) => b.join("\n")).join("\n\n") + "\n";
}
