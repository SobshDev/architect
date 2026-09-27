import { createHash } from "node:crypto";
import { z } from "zod";
import { UsageError } from "../engine/index.ts";
import {
  ApiChangeSchema,
  ConfigIssueSchema,
  CoverageSchema,
  FindingSchema,
  LocationSchema,
  normalizeDecisionId,
  ReportSummarySchema,
  WeakeningSchema,
  type Finding,
  type Report,
  type Rule,
} from "../model/index.ts";

export type Detail = "concise" | "full";

export const PAGE_SIZE: Record<Detail, number> = { concise: 20, full: 100 };
const LINK_CAP = 20;
const TEXT_FINDINGS = 5;

export const ConciseFindingSchema = z.object({
  rule: z.string(),
  level: z.enum(["error", "warn", "info"]),
  message: z.string(),
  location: LocationSchema.optional(),
  because: z.array(z.string()),
  fix_hint: z.string().optional(),
});
type ConciseFinding = z.infer<typeof ConciseFindingSchema>;

const CoverageCountsSchema = z.object({
  files_analyzed: z.number().int(),
  unmapped_files: z.number().int(),
  unresolved_imports: z.number().int(),
  dynamic_imports: z.number().int(),
  parse_errors: z.number().int(),
});

export const CheckOutputSchema = z.object({
  scope: z.enum(["all", "changed", "files"]),
  base: z.string().optional(),
  exit_code: z.number().int(),
  summary: ReportSummarySchema,
  /** Findings in the paged list, across all pages. */
  total: z.number().int(),
  findings: z.array(z.union([FindingSchema, ConciseFindingSchema])),
  next_cursor: z.string().optional(),
  config_issues: z.array(ConfigIssueSchema),
  coverage: z.union([CoverageSchema, CoverageCountsSchema]),
});
export type CheckOutput = z.infer<typeof CheckOutputSchema>;

export const DiffOutputSchema = CheckOutputSchema.extend({
  head: z.string().optional(),
  /** Unapproved first; concise lists only the unapproved ones. */
  weakenings: z.array(WeakeningSchema),
  approved_weakenings: z.number().int(),
  /** full only. */
  api_changes: z.array(ApiChangeSchema).optional(),
  /** concise only. */
  api_change_counts: z.array(z.object({ component: z.string(), change: z.string(), count: z.number().int() })).optional(),
});
export type DiffOutput = z.infer<typeof DiffOutputSchema>;

export type ResourceKind = "decisions" | "rules" | "components" | "cards";

export interface ResourceLink {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType: "text/markdown";
}

export function resourceUri(kind: ResourceKind, id: string): string {
  return `architect://${kind}/${encodeURIComponent(id)}`;
}

export function resourceLink(kind: ResourceKind, id: string): ResourceLink {
  return { type: "resource_link", uri: resourceUri(kind, id), name: `${kind.slice(0, -1)}:${id}`, mimeType: "text/markdown" };
}

export function capLinks(links: readonly ResourceLink[]): ResourceLink[] {
  const unique = new Map<string, ResourceLink>();
  for (const link of links) if (!unique.has(link.uri)) unique.set(link.uri, link);
  return [...unique.values()].slice(0, LINK_CAP);
}

/** Links for the rules and decisions that findings cite. Built-in ids such as contract-changed are not rules. */
export function citationLinks(findings: readonly Finding[], rules: readonly Rule[]): ResourceLink[] {
  const ruleIds = new Set(rules.map((rule) => rule.id));
  const links: ResourceLink[] = [];
  for (const finding of findings) {
    if (ruleIds.has(finding.rule)) links.push(resourceLink("rules", finding.rule));
    for (const ref of finding.because) {
      const id = normalizeDecisionId(ref);
      if (id !== null) links.push(resourceLink("decisions", id));
    }
  }
  return capLinks(links);
}

// ---------------------------------------------------------------- cursors

/** Short hash of the ordered fingerprints, so a cursor fails once the list it pages has changed. */
function listHash(findings: readonly Finding[]): string {
  return createHash("sha256")
    .update(findings.map((finding) => finding.fingerprint).join("\n"))
    .digest("hex")
    .slice(0, 12);
}

function encodeCursor(offset: number, findings: readonly Finding[]): string {
  return Buffer.from(JSON.stringify({ o: offset, h: listHash(findings) })).toString("base64url");
}

const STALE = "The cursor is stale or invalid: the findings changed since it was issued. Call again without a cursor to start over.";
const CursorSchema = z.object({ o: z.number().int().nonnegative(), h: z.string() });

function decodeCursor(cursor: string, findings: readonly Finding[]): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new UsageError(STALE);
  }
  const value = CursorSchema.safeParse(parsed);
  if (!value.success || value.data.h !== listHash(findings) || value.data.o > findings.length) throw new UsageError(STALE);
  return value.data.o;
}

interface Page {
  findings: Finding[];
  total: number;
  next_cursor?: string;
}

function page(findings: readonly Finding[], detail: Detail, cursor: string | undefined): Page {
  const offset = cursor === undefined ? 0 : decodeCursor(cursor, findings);
  const end = offset + PAGE_SIZE[detail];
  const result: Page = { findings: findings.slice(offset, end), total: findings.length };
  if (end < findings.length) result.next_cursor = encodeCursor(end, findings);
  return result;
}

// ---------------------------------------------------------------- shaping

const LEVEL_RANK = { error: 0, warn: 1, info: 2 } as const;

/** concise: new errors, then new warnings. full: every finding in report order. */
function selectFindings(report: Report, detail: Detail): Finding[] {
  if (detail === "full") return report.findings;
  return report.findings.filter((f) => f.status === "new" && f.level !== "info").sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level]);
}

function concise(finding: Finding): ConciseFinding {
  const result: ConciseFinding = { rule: finding.rule, level: finding.level, message: finding.message, because: finding.because };
  if (finding.location !== undefined) result.location = finding.location;
  if (finding.fix_hint !== undefined) result.fix_hint = finding.fix_hint;
  return result;
}

function coverage(report: Report, detail: Detail): CheckOutput["coverage"] {
  if (detail === "full") return report.coverage;
  const c = report.coverage;
  return {
    files_analyzed: c.files_analyzed,
    unmapped_files: c.unmapped_files.length,
    unresolved_imports: c.unresolved_imports.length,
    dynamic_imports: c.dynamic_imports.length,
    parse_errors: c.parse_errors.length,
  };
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function findingLine(finding: Finding): string {
  const where = finding.location ? finding.location.file + (finding.location.line ? `:${finding.location.line}` : "") : (finding.from ?? "");
  return `${finding.level} ${finding.rule} ${where}: ${finding.message}`;
}

function textLines(report: Report, shown: Page, title: string): string[] {
  const s = report.summary;
  const counts = [plural(s.errors, "error"), plural(s.warnings, "warning"), `${s.baselined} baselined`];
  if (report.command !== "check") counts.push(plural(s.unapproved_weakenings, "unapproved weakening"));
  const lines = [`${title}: ${counts.join(", ")}; exit code ${report.exit_code}.`];
  for (const issue of report.config_issues) lines.push(`config ${issue.level} ${issue.file}${issue.path ? " " + issue.path : ""}: ${issue.message}`);
  lines.push(...shown.findings.slice(0, TEXT_FINDINGS).map(findingLine));
  const rest = shown.total - Math.min(shown.findings.length, TEXT_FINDINGS);
  if (rest > 0) lines.push(`${rest} more listed in structuredContent${shown.next_cursor ? " and later pages (pass next_cursor as cursor)" : ""}.`);
  return lines;
}

export interface Shaped<T> {
  text: string;
  structured: T;
  links: ResourceLink[];
}

function shapePage(report: Report, rules: readonly Rule[], detail: Detail, cursor: string | undefined, title: string): Shaped<CheckOutput> {
  const shown = page(selectFindings(report, detail), detail, cursor);
  const structured: CheckOutput = {
    scope: report.scope,
    exit_code: report.exit_code,
    summary: report.summary,
    total: shown.total,
    findings: detail === "full" ? shown.findings : shown.findings.map(concise),
    config_issues: report.config_issues,
    coverage: coverage(report, detail),
  };
  if (report.base !== undefined) structured.base = report.base;
  if (shown.next_cursor !== undefined) structured.next_cursor = shown.next_cursor;
  return { text: textLines(report, shown, title).join("\n"), structured, links: citationLinks(shown.findings, rules) };
}

export function shapeCheck(report: Report, rules: readonly Rule[], detail: Detail, cursor?: string): Shaped<CheckOutput> {
  return shapePage(report, rules, detail, cursor, `architect check (${report.scope})`);
}

export function shapeDiff(report: Report, rules: readonly Rule[], detail: Detail, cursor?: string): Shaped<DiffOutput> {
  const title = `architect diff ${report.base ?? ""}..${report.head ?? "worktree"}`;
  const base = shapePage(report, rules, detail, cursor, title);
  const unapproved = report.weakenings.filter((w) => w.approved_by === undefined);
  const approved = report.weakenings.filter((w) => w.approved_by !== undefined);
  const structured: DiffOutput = {
    ...base.structured,
    weakenings: detail === "full" ? [...unapproved, ...approved] : unapproved,
    approved_weakenings: approved.length,
  };
  if (report.head !== undefined) structured.head = report.head;
  if (detail === "full") {
    structured.api_changes = report.api_changes;
  } else {
    const counts = new Map<string, { component: string; change: string; count: number }>();
    for (const change of report.api_changes) {
      const key = change.component + "\u0000" + change.change;
      const entry = counts.get(key) ?? { component: change.component, change: change.change, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    structured.api_change_counts = [...counts.values()];
  }
  const lines = [base.text];
  for (const w of unapproved.slice(0, TEXT_FINDINGS)) lines.push(`unapproved weakening ${w.rule} (${w.type}): ${w.message}`);
  if (unapproved.length > TEXT_FINDINGS) lines.push(`${unapproved.length - TEXT_FINDINGS} more unapproved weakenings in structuredContent.`);
  if (approved.length > 0) lines.push(plural(approved.length, "approved weakening") + ".");
  if (report.api_changes.length > 0) lines.push(plural(report.api_changes.length, "API change") + ".");
  return { text: lines.join("\n"), structured, links: base.links };
}
