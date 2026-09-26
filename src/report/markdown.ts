import type { Finding, Report } from "../model/index.ts";
import { plural } from "./report.ts";
import { configIssueLine } from "./text.ts";

// GitHub step summary for architect ci: a title, then exactly four sections, then optional details.
// Repository data (ids, paths, messages, signatures) goes through esc() or code(), so GitHub never reads it as HTML.

const TABLE_ROWS = 50;
const LIST_ITEMS = 100;

/** One table cell from Markdown built with esc() and code(): no pipes or newlines can break the row. */
export function cell(markdown: string): string {
  return inline(markdown).replaceAll("|", "\\|");
}

function inline(text: string): string {
  return text.replace(/\r?\n/g, " ").trim();
}

/** Plain text on one line, with &, <, and > escaped. */
export function esc(text: string): string {
  return inline(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** A code span whose fence is longer than any backtick run inside it. */
export function code(text: string): string {
  const content = inline(text);
  const longest = Math.max(0, ...(content.match(/\u0060+/g) ?? []).map((run) => run.length));
  const fence = "\u0060".repeat(longest + 1);
  const pad = content.startsWith("\u0060") || content.endsWith("\u0060") ? " " : "";
  return `${fence}${pad}${content}${pad}${fence}`;
}

function more(total: number, cap: number): string[] {
  return total > cap ? ["", `_…and ${total - cap} more._`] : [];
}

function location(f: Finding): string {
  if (!f.location) return "";
  return code(`${f.location.file}${f.location.line ? ":" + f.location.line : ""}`);
}

function findingTable(findings: readonly Finding[]): string[] {
  const rows = findings
    .slice(0, TABLE_ROWS)
    .map((f) => `| ${cell(esc(f.rule))} | ${cell(location(f))} | ${cell(esc(f.message))} | ${cell(esc(f.because.join(", ")))} |`);
  return ["| Rule | Location | Message | Because |", "|---|---|---|---|", ...rows, ...more(findings.length, TABLE_ROWS)];
}

function details(summary: string, body: string[]): string[] {
  return ["<details>", `<summary>${summary}</summary>`, "", ...body, "", "</details>"];
}

function capped<T>(items: readonly T[], line: (item: T) => string): string[] {
  return [...items.slice(0, LIST_ITEMS).map((item) => `- ${inline(line(item))}`), ...more(items.length, LIST_ITEMS)];
}

function title(report: Report): string {
  const configErrors = report.config_issues.filter((i) => i.level === "error").length;
  const parts: string[] = [];
  if (configErrors > 0) parts.push(plural(configErrors, "config error"));
  parts.push(report.summary.errors > 0 ? plural(report.summary.errors, "new error") : "no new errors");
  if (report.summary.unapproved_weakenings > 0) parts.push(plural(report.summary.unapproved_weakenings, "unapproved weakening"));
  return `### Architect: ${parts.join(", ")}`;
}

export function formatMarkdown(report: Report): string {
  const out: string[] = [title(report), ""];
  if (report.config_issues.length > 0) {
    out.push(...report.config_issues.map((i) => `- ${esc(configIssueLine(i))}`), "");
  }

  const errors = report.findings.filter((f) => f.status === "new" && f.level === "error");
  out.push("#### New errors", "", ...(errors.length > 0 ? findingTable(errors) : ["_None_"]), "");

  out.push("#### Weakenings that need human approval", "");
  const unapproved = report.weakenings.filter((w) => w.approved_by === undefined);
  const approved = report.weakenings.filter((w) => w.approved_by !== undefined);
  const approvedFindings = report.findings.filter((f) => f.approved_by !== undefined);
  if (unapproved.length === 0) out.push("_None_");
  for (const w of unapproved) {
    out.push(`- **${esc(w.rule)}** (${w.type}): ${esc(w.message)}`);
    for (const d of w.details) out.push(`  - ${esc(d)}`);
  }
  if (approved.length > 0 || approvedFindings.length > 0) {
    out.push("");
    for (const w of approved) out.push(`- **${esc(w.rule)}** (${w.type}): ${esc(w.message)} (Approved by decision ${esc(w.approved_by ?? "")})`);
    for (const f of approvedFindings) {
      const where = f.location ? ` ${location(f)}` : "";
      out.push(`- **${esc(f.rule)}** (${esc(f.kind)})${where}: ${esc(f.message)} (Approved by decision ${esc(f.approved_by ?? "")})`);
    }
  }
  out.push("");

  out.push("#### Fixed baseline entries", "");
  if (report.fixed.length === 0) out.push("_None_");
  else {
    out.push(
      ...capped(report.fixed, (e) => {
        const where = e.file ?? e.from ?? "";
        const target = e.to ? ` → ${e.to}` : "";
        const message = e.message ? `: ${e.message}` : "";
        return `${code(e.rule)} ${esc(where + target)} (×${e.count})${esc(message)}`;
      }),
      "",
      "Run \`architect baseline update\` to lock in progress.",
    );
  }
  out.push("");

  const c = report.coverage;
  const languages = Object.entries(c.languages).map(([lang, n]) => `${esc(lang)} ${n}`);
  out.push(
    "#### Coverage",
    "",
    `${plural(c.files_analyzed, "file")} analyzed${languages.length > 0 ? ` (${languages.join(", ")})` : ""}; ` +
      [
        plural(c.unmapped_files.length, "unmapped file"),
        plural(c.unresolved_imports.length, "unresolved import"),
        plural(c.dynamic_imports.length, "dynamic import"),
        plural(c.parse_errors.length, "parse error"),
      ].join(", ") +
      ".",
  );
  const coverageLists: [string, string[]][] = [
    ["Unmapped files", capped(c.unmapped_files, (f) => code(f))],
    ["Unresolved imports", capped(c.unresolved_imports, (i) => `${code(`${i.file}:${i.line}`)} ${code(i.specifier)}`)],
    ["Dynamic imports", capped(c.dynamic_imports, (i) => `${code(`${i.file}:${i.line}`)} ${code(i.expression)}`)],
    ["Parse errors", capped(c.parse_errors, (e) => `${code(e.file)} ${esc(e.message)}`)],
  ];
  const counts = [c.unmapped_files.length, c.unresolved_imports.length, c.dynamic_imports.length, c.parse_errors.length];
  coverageLists.forEach(([label, body], i) => {
    if ((counts[i] ?? 0) > 0) out.push("", ...details(`${label} (${counts[i]})`, body));
  });
  out.push("");

  const warnings = report.findings.filter((f) => f.status === "new" && f.level === "warn");
  if (warnings.length > 0) out.push(...details(plural(warnings.length, "new warning"), findingTable(warnings)), "");
  if (report.api_changes.length > 0) {
    const rows = report.api_changes
      .slice(0, LIST_ITEMS)
      .map((a) => `| ${cell(esc(a.component))} | ${a.change} | ${cell(code(a.symbol))} | ${cell(esc(a.file))} |`);
    const table = ["| Component | Change | Symbol | File |", "|---|---|---|---|", ...rows, ...more(report.api_changes.length, LIST_ITEMS)];
    out.push(...details(plural(report.api_changes.length, "API change"), table), "");
  }
  return out.join("\n");
}
