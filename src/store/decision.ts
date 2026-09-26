import { posix } from "node:path";
import { stringify } from "yaml";
import {
  type Assumption,
  type ConfigIssue,
  type Decision,
  DecisionFrontMatterSchema,
  type DecisionStatus,
  DecisionStatusSchema,
  decisionFileName,
  type Evidence,
  firstHeading,
  markdownSections,
  normalizeDecisionId,
  splitFrontMatter,
} from "../model/index.ts";
import { issue, readYaml, salvage } from "./parse.ts";

const DECISIONS_DIR = ".architect/decisions";

/** Id from the leading digits of a file name, or null when it has none. */
export function fileDecisionId(file: string): string | null {
  const match = /^\d+/.exec(posix.basename(file));
  return match ? normalizeDecisionId(match[0]) : null;
}

function normalizeStatus(raw: string): { status: DecisionStatus; supersededBy?: string } | null {
  const text = raw.replace(/[*_\u0060]/g, "").trim().toLowerCase();
  const superseded = /^superseded(?:\s+by\s+([\s\S]*))?$/.exec(text);
  if (superseded) {
    const by = superseded[1] === undefined ? null : normalizeDecisionId(superseded[1]);
    return by === null ? { status: "superseded" } : { status: "superseded", supersededBy: by };
  }
  if (text === "draft") return { status: "proposed" };
  const known = DecisionStatusSchema.safeParse(text);
  return known.success ? { status: known.data } : null;
}

/** A field written in the body: a "## Name" section's first line, or a MADR 2 bullet such as "* Status: accepted". */
function bodyField(body: string, name: string): string | undefined {
  const section = markdownSections(body).find((s) => s.heading.toLowerCase() === name);
  const line = section?.text.split("\n").find((l) => l.trim() !== "");
  if (line !== undefined) return line.replace(/^\s*[*-]\s+/, "").trim();
  const bullet = new RegExp(`^\\s*[*-]\\s+${name}:\\s*(.+?)\\s*$`, "im").exec(body);
  return bullet?.[1];
}

function titleFrom(frontTitle: string | undefined, body: string, file: string): string {
  if (frontTitle !== undefined && frontTitle.trim() !== "") return frontTitle.trim();
  const heading = firstHeading(body);
  if (heading !== null) {
    const stripped = heading.replace(/^(?:ADR[-_ ]?)?\d+(?:\s*[:.)\u2013\u2014-]\s*|\s+)/i, "").trim();
    return stripped === "" ? heading : stripped;
  }
  const name = posix.basename(file, ".md");
  return name.replace(/^\d+[-_ ]*/, "") || name;
}

function stringList(value: unknown): string[] | null {
  if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.map((v) => v.trim()).filter((v) => v !== "");
  return null;
}

/** Parses and normalizes one decision file. Imported (existing MADR) files report front matter problems as warnings. */
export function parseDecision(file: string, text: string, options: { imported?: boolean } = {}): { decision: Decision; issues: ConfigIssue[] } {
  const imported = options.imported ?? false;
  const level = imported ? "warn" : "error";
  const issues: ConfigIssue[] = [];
  const { frontMatter, body } = splitFrontMatter(text);

  let raw: unknown = {};
  if (frontMatter !== null) {
    const yaml = readYaml(file, frontMatter, level);
    issues.push(...yaml.issues);
    raw = yaml.value ?? {};
  }
  const front = salvage(DecisionFrontMatterSchema, raw, file, level);
  issues.push(...front.issues);
  const fm = front.value;

  let status: DecisionStatus = "proposed";
  let supersededBy = fm["superseded-by"] === undefined ? null : normalizeDecisionId(fm["superseded-by"]);
  const rawStatus = fm.status ?? bodyField(body, "status");
  if (rawStatus === undefined) {
    if (!imported) issues.push(issue("warn", file, "no status found; treating the decision as proposed", "status"));
  } else {
    const normalized = normalizeStatus(rawStatus);
    if (normalized === null) {
      issues.push(issue("warn", file, `unknown status "${rawStatus}"; treating the decision as proposed`, "status"));
    } else {
      status = normalized.status;
      supersededBy ??= normalized.supersededBy ?? null;
    }
  }

  let makers = fm["decision-makers"] === undefined ? null : stringList(fm["decision-makers"]);
  if (fm["decision-makers"] === undefined && fm.deciders !== undefined) {
    makers = stringList(fm.deciders);
    if (makers === null) issues.push(issue(level, file, "expected a string or a list of strings", "deciders"));
  }

  const date = (fm.date ?? bodyField(body, "date"))?.trim();
  const decision: Decision = {
    id: fileDecisionId(file) ?? posix.basename(file, ".md"),
    file,
    title: titleFrom(fm.title, body, file),
    status,
    ...(supersededBy === null ? {} : { superseded_by: supersededBy }),
    ...(date === undefined || date === "" ? {} : { date }),
    decision_makers: makers ?? [],
    governs: fm.governs,
    supersedes: fm.supersedes,
    weakens: fm.weakens,
    assumptions: fm.assumptions,
    evidence: fm.evidence,
    body,
    imported,
  };
  return { decision, issues };
}

/** The next native decision id: the highest one plus one, as four digits. "0001" when there is none. */
export function nextDecisionId(decisions: readonly Decision[]): string {
  let highest = 0;
  for (const d of decisions) {
    if (d.imported || !/^\d+$/.test(d.id)) continue;
    highest = Math.max(highest, Number.parseInt(d.id, 10));
  }
  return String(highest + 1).padStart(4, "0");
}

export function decisionPath(id: string, title: string): string {
  return `${DECISIONS_DIR}/${decisionFileName(id, title)}`;
}

export interface DecisionDraft {
  id: string;
  title: string;
  status: DecisionStatus;
  date: string;
  decisionMakers?: string[];
  governs?: string[];
  supersedes?: string[];
  weakens?: string[];
  assumptions?: Assumption[];
  evidence?: Evidence[];
  context: string;
  drivers?: string[];
  options: string[];
  chosen?: string;
  outcome: string;
  consequences?: string[];
  moreInformation?: string;
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `* ${item}`).join("\n");
}

/** Renders a MADR 4.0 decision record. */
export function renderDecision(draft: DecisionDraft): string {
  const front: Record<string, unknown> = { status: draft.status, date: draft.date };
  const lists: [string, readonly unknown[] | undefined][] = [
    ["decision-makers", draft.decisionMakers],
    ["governs", draft.governs],
    ["supersedes", draft.supersedes],
    ["weakens", draft.weakens],
    ["assumptions", draft.assumptions],
    ["evidence", draft.evidence],
  ];
  for (const [key, list] of lists) if (list !== undefined && list.length > 0) front[key] = list;

  const parts = [`---\n${stringify(front, { lineWidth: 0 })}---`, `# ${draft.title}`, "## Context and Problem Statement", draft.context.trim()];
  if (draft.drivers !== undefined && draft.drivers.length > 0) parts.push("## Decision Drivers", bullets(draft.drivers));
  parts.push("## Considered Options", bullets(draft.options));
  const chosen = draft.chosen ?? draft.options[0] ?? "";
  parts.push("## Decision Outcome", `Chosen option: "${chosen}", because ${draft.outcome.trim()}`);
  if (draft.consequences !== undefined && draft.consequences.length > 0) parts.push("### Consequences", bullets(draft.consequences));
  if (draft.moreInformation !== undefined && draft.moreInformation.trim() !== "") parts.push("## More Information", draft.moreInformation.trim());
  return `${parts.join("\n\n")}\n`;
}
