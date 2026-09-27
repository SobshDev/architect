// The ranked task brief: decisions, rules, component contracts, change partners, violations, cards.
import {
  type Architecture,
  Bm25Index,
  type Card,
  ComponentIndex,
  type Decision,
  type Finding,
  type Graph,
  markdownSections,
  normalizeDecisionId,
  type Rule,
  sortFindings,
  toRepoPath,
} from "../model/index.ts";
import { constraintsFor, describeRule, governsMatch, ruleInvolves } from "./rules.ts";
import { assemble, code, codeList, headerWith, makeItem, quote, quoteLine, unanalyzedWarning, uriFor } from "./text.ts";
import type { ContextBrief, ContextInput, ContextItem } from "./types.ts";
import { compareText } from "../model/index.ts";

const MIN_SCORE = 0.2;
const MAX_TASK_DECISIONS = 5;
const MAX_PARTNERS = 5;
const MAX_VIOLATIONS = 10;
const MAX_CARDS = 3;

export interface BuildOptions {
  /** Upper bound on the budget. */
  cap?: number;
  /** Extra touched components. */
  components?: readonly string[];
  /** Decisions that rank first. */
  pinned?: readonly string[];
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Component ids named as whole words (case-insensitive). Ids shorter than 3 characters never match. */
export function namedComponents(text: string, architecture: Architecture): string[] {
  const found = architecture.components
    .filter((c) => c.id.length >= 3 && new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(c.id)}(?![A-Za-z0-9_-])`, "i").test(text))
    .map((c) => c.id);
  return [...new Set(found)].sort();
}

export function buildContext(input: ContextInput): ContextBrief {
  return build(input, {});
}

const ACTIVE = new Set(["accepted", "proposed", "rejected"]);
const byId = <T extends { id: string }>(a: T, b: T) => compareText(a.id, b.id);

export function build(input: ContextInput, options: BuildOptions): ContextBrief {
  const { architecture, rules } = input;
  const full = input.detail === "full";
  const budget = Math.min(input.budget ?? (full ? 6000 : 1500), options.cap ?? Number.POSITIVE_INFINITY);
  const index = new ComponentIndex(architecture.components, input.graph?.workspaces ?? []);
  const paths = [...new Set((input.paths ?? []).map(toRepoPath).filter((p) => p !== ""))].sort();
  const pathSet = new Set(paths);
  const task = input.task?.trim() ?? "";
  const pinned = (options.pinned ?? []).filter((id) => input.decisions.some((d) => d.id === id));

  const touched = new Set<string>();
  for (const p of paths) {
    const c = index.of(p);
    if (c !== null) touched.add(c);
  }
  for (const id of task === "" ? [] : namedComponents(task, architecture)) touched.add(id);
  for (const id of options.components ?? []) if (index.has(id)) touched.add(id);
  const components = [...touched].sort();
  const overview = paths.length === 0 && task === "" && touched.size === 0 && pinned.length === 0;

  const decisions = [...input.decisions].sort(byId);
  const decisionOf = (ref: string): Decision | undefined =>
    decisions.find((d) => d.id === ref) ?? decisions.find((d) => d.id === normalizeDecisionId(ref));
  const activeRules = rules.rules.filter((r) => r.level !== "off");
  const items: ContextItem[] = [];
  const listed = new Set<string>();

  // 1. Decisions.
  const pushDecision = (d: Decision, reason: string, why: string) => {
    if (listed.has(d.id)) return;
    listed.add(d.id);
    items.push(decisionItem(d, reason, why, full));
  };
  if (overview) {
    for (const d of decisions) {
      if (d.status === "accepted" && (d.governs.length === 0 || d.governs.includes("*"))) pushDecision(d, "applies to the whole repository", "applies everywhere");
    }
  } else {
    const retired: Decision[] = [];
    for (const id of pinned) {
      const d = decisionOf(id);
      if (d === undefined) continue;
      if (ACTIVE.has(d.status)) pushDecision(d, "named in the prompt", "named in the prompt");
      else retired.push(d);
    }
    const specific: { d: Decision; reason: string }[] = [];
    const wildcard: Decision[] = [];
    for (const d of decisions) {
      const match = governsMatch(d.governs, architecture, touched, paths);
      if (match.specific === null && !match.wildcard) continue;
      if (d.status === "superseded" || d.status === "deprecated") retired.push(d);
      else if (match.specific !== null) specific.push({ d, reason: match.specific });
      else if (d.status !== "rejected") wildcard.push(d);
    }
    const statusRank = { accepted: 0, proposed: 1, rejected: 2, superseded: 3, deprecated: 3 };
    specific.sort((a, b) => statusRank[a.d.status] - statusRank[b.d.status] || byId(a.d, b.d));
    wildcard.sort((a, b) => statusRank[a.status] - statusRank[b.status] || byId(a, b));
    for (const { d, reason } of specific) pushDecision(d, reason, reason.replace(/^governs (component )?(.*)$/, (_m, _c, what: string) => `governs ${code(what)}`));
    for (const d of wildcard) pushDecision(d, "governs *", "applies everywhere");

    const fromTask: Decision[] = [];
    if (task !== "") {
      const candidates = decisions.filter((d) => ACTIVE.has(d.status));
      const search = new Bm25Index(candidates.map((d) => ({ id: d.id, text: `${d.title}\n${d.body}` })));
      for (const hit of search.search(task, MAX_TASK_DECISIONS + listed.size)) {
        const d = decisionOf(hit.id);
        if (hit.score >= MIN_SCORE && d !== undefined && !listed.has(d.id) && fromTask.length < MAX_TASK_DECISIONS) fromTask.push(d);
      }
    }
    const pointed = new Set<string>();
    for (const d of retired.sort(byId)) {
      const replacement = d.superseded_by ?? decisions.find((other) => other.supersedes.includes(d.id))?.id;
      const target = replacement === undefined ? undefined : decisionOf(replacement);
      if (target === undefined || listed.has(target.id) || fromTask.includes(target) || pointed.has(target.id)) continue;
      pointed.add(target.id);
      const uri = uriFor("decisions", target.id);
      items.push(
        makeItem("decision", target.id, uri, `replaces ${d.status} ${d.id}`, [
          `Decision ${code(d.id)} is ${d.status}; follow ${code(target.id)} (${target.status}) instead: ${uri}`,
        ]),
      );
    }
    for (const d of fromTask) pushDecision(d, "matches the task", "matches the task");
  }

  // 2. Rules.
  const citesListed = (r: Rule) => r.because.some((ref) => {
    const d = decisionOf(ref);
    return d !== undefined && listed.has(d.id);
  });
  const chosenRules = activeRules
    .filter((r) => (overview ? r.level === "error" : ruleInvolves(r, architecture, touched, paths) || citesListed(r)))
    .sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1) || compareText(a.id, b.id));
  for (const rule of chosenRules) {
    const reason = overview ? "error-level rule" : ruleInvolves(rule, architecture, touched, paths) ? "involves a touched component or path" : "cites a listed decision";
    items.push(ruleItem(rule, reason, decisionOf, full));
  }

  // 3. Component contracts.
  const componentEdges = input.graph ? countComponentEdges(input.graph, index) : null;
  for (const id of components) {
    items.push(componentItem(id, index, activeRules, architecture, componentEdges, full));
  }

  // 4. Change partners.
  if (input.history && !overview) {
    const partners: { self: string; other: string; support: number; confidence: number; uri: string }[] = [];
    for (const p of input.history.filePairs) {
      const self = pathSet.has(p.a) ? p.a : pathSet.has(p.b) ? p.b : null;
      if (self === null) continue;
      const other = self === p.a ? p.b : p.a;
      const owner = index.of(other) ?? index.of(self);
      if (owner !== null) partners.push({ self, other, support: p.support, confidence: p.confidence, uri: uriFor("components", owner) });
    }
    for (const p of input.history.componentPairs) {
      const self = touched.has(p.a) ? p.a : touched.has(p.b) ? p.b : null;
      if (self === null) continue;
      const other = self === p.a ? p.b : p.a;
      partners.push({ self, other, support: p.support, confidence: p.confidence, uri: uriFor("components", other) });
    }
    partners.sort((a, b) => b.confidence - a.confidence || b.support - a.support || compareText(a.other, b.other) || compareText(a.self, b.self));
    for (const p of partners.slice(0, MAX_PARTNERS)) {
      items.push(
        makeItem("partner", p.other, p.uri, `changes with ${p.self}`, [
          `Change partner ${code(p.other)}: changed together with ${code(p.self)} in ${p.support} commits (confidence ${p.confidence.toFixed(2)}): ${p.uri}`,
        ]),
      );
    }
  }

  // 5. Open violations.
  if (input.findings && !overview) {
    const relevant = sortFindings(
      input.findings.filter(
        (f) =>
          f.status !== "waived" &&
          ((f.location !== undefined && pathSet.has(f.location.file)) || (f.from !== undefined && touched.has(f.from)) || (f.to !== undefined && touched.has(f.to))),
      ),
    );
    for (const f of relevant.slice(0, MAX_VIOLATIONS)) items.push(violationItem(f, index, touched));
  }

  // 6. Knowledge cards.
  if (input.cards && input.cards.length > 0 && task !== "") {
    const cards = [...input.cards].sort(byId);
    const search = new Bm25Index(cards.map((c) => ({ id: c.id, text: [c.title, c.summary, c.problem, ...c.code_signals].join("\n") })));
    for (const hit of search.search(task, MAX_CARDS)) {
      const card = cards.find((c) => c.id === hit.id);
      if (card !== undefined && hit.score >= MIN_SCORE) items.push(cardItem(card, full));
    }
  }

  const unseen = (input.unanalyzed ?? []).map(toRepoPath).filter((p) => pathSet.has(p));
  return assemble(headerWith(unanalyzedWarning(unseen)), items, [], budget, components);
}

function outcomeOf(body: string): string | null {
  const section = markdownSections(body).find((s) => s.heading.toLowerCase().startsWith("decision outcome"));
  const first = section?.text.split(/\n\s*\n/)[0]?.trim();
  return first === undefined || first === "" ? null : first;
}

function decisionItem(d: Decision, reason: string, why: string, full: boolean): ContextItem {
  const uri = uriFor("decisions", d.id);
  const status = d.status === "rejected" ? "rejected alternative, do not bring it back without a new decision" : d.status;
  const lines = [`Decision ${code(d.id)} (${status}), ${why}: ${uri}`, quoteLine(d.title)];
  if (full) {
    if (d.body.trim() !== "") lines.push(quote(d.body));
  } else {
    const outcome = outcomeOf(d.body);
    if (outcome !== null) lines.push(quote(`Outcome: ${outcome}`, 400));
  }
  for (const a of d.assumptions) {
    const check = a.check === undefined ? "" : ` (check: ${a.check})`;
    const review = a.review_by === undefined ? "" : ` (review by ${a.review_by})`;
    lines.push(quoteLine(`Assumption: ${a.text}${check}${review}`, 300));
  }
  return makeItem("decision", d.id, uri, reason, lines);
}

function ruleItem(rule: Rule, reason: string, decisionOf: (ref: string) => Decision | undefined, full: boolean): ContextItem {
  const uri = uriFor("rules", rule.id);
  const lines = [`Rule ${code(rule.id)} (${rule.kind}, ${rule.level}): ${uri}`];
  if (rule.description !== undefined) lines.push(quoteLine(rule.description, 300));
  if (rule.description === undefined || full) lines.push(`Requires: ${describeRule(rule)}`);
  if (rule.because.length > 0) {
    const cited = rule.because.map((ref) => ({ ref, d: decisionOf(ref) }));
    lines.push(`Because: ${cited.map(({ ref, d }) => (d ? `${code(d.id)} (${d.status})` : `${code(ref)} (not found)`)).join(", ")}`);
    const titles = cited.flatMap(({ d }) => (d ? [`${d.id}: ${d.title}`] : []));
    if (titles.length > 0) lines.push(titles.map((t) => quoteLine(t)).join("\n"));
  }
  return makeItem("rule", rule.id, uri, reason, lines);
}

type EdgeCounts = Map<string, Map<string, number>>;

function countComponentEdges(graph: Graph, index: ComponentIndex): { out: EdgeCounts; in: EdgeCounts } {
  const out: EdgeCounts = new Map();
  const inbound: EdgeCounts = new Map();
  const bump = (m: EdgeCounts, a: string, b: string) => {
    const inner = m.get(a) ?? new Map<string, number>();
    inner.set(b, (inner.get(b) ?? 0) + 1);
    m.set(a, inner);
  };
  for (const e of graph.edges) {
    const from = index.of(e.from);
    const to = e.to !== undefined ? index.of(e.to) : e.workspace !== undefined ? index.ofPackage(e.workspace) : null;
    if (from === null || to === null || from === to) continue;
    bump(out, from, to);
    bump(inbound, to, from);
  }
  return { out, in: inbound };
}

function topEdges(counts: Map<string, number> | undefined, max: number): string {
  const sorted = [...(counts ?? new Map<string, number>())].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]));
  if (sorted.length === 0) return "none";
  const shown = sorted.slice(0, max).map(([id, n]) => `${code(id)} (${n})`).join(", ");
  return sorted.length > max ? `${shown}, +${sorted.length - max} more` : shown;
}

function componentItem(
  id: string,
  index: ComponentIndex,
  rules: readonly Rule[],
  architecture: ContextInput["architecture"],
  edges: { out: EdgeCounts; in: EdgeCounts } | null,
  full: boolean,
): ContextItem {
  const c = index.get(id);
  const uri = uriFor("components", id);
  const lines = [`Component ${code(id)}: ${uri}`];
  if (c === undefined) return makeItem("component", id, uri, "touched component", lines);
  if (c.description !== undefined) lines.push(quoteLine(c.description, full ? 600 : 200));
  const facts = [`paths ${codeList(c.paths, full ? 20 : 5)}`];
  if (c.kind !== undefined) facts.push(`kind ${code(c.kind)}`);
  if (c.owner !== undefined) facts.push(`owner ${code(c.owner)}`);
  if (c.entrypoints !== undefined && c.entrypoints.length > 0) facts.push(`entrypoints ${codeList(c.entrypoints, full ? 20 : 5)}`);
  lines.push(`Contract: ${facts.join("; ")}.`);
  if (c.deprecated !== undefined && c.deprecated !== false) {
    const replacement = typeof c.deprecated === "object" && c.deprecated.replacement !== undefined ? `; use ${code(c.deprecated.replacement)} instead` : "";
    lines.push(`Deprecated${replacement}.`);
    if (typeof c.deprecated === "object") lines.push(quoteLine(c.deprecated.reason, 200));
  }
  const constraints = constraintsFor(id, rules, architecture);
  if (constraints.mayOnly.length > 0) lines.push(`May depend only on itself and: ${constraints.mayOnly.join("; ")}.`);
  if (constraints.may.length > 0) lines.push(`May depend on: ${constraints.may.join("; ")}.`);
  if (constraints.mustNot.length > 0) lines.push(`Must not depend on: ${constraints.mustNot.join("; ")}.`);
  if (edges !== null) {
    const max = full ? 20 : 6;
    lines.push(`Observed dependencies (imports): ${topEdges(edges.out.get(id), max)}.`);
    lines.push(`Observed dependents (imports): ${topEdges(edges.in.get(id), max)}.`);
  }
  return makeItem("component", id, uri, "touched component", lines);
}

function violationItem(f: Finding, index: ComponentIndex, touched: ReadonlySet<string>): ContextItem {
  const sides = [f.from, f.to, f.location === undefined ? undefined : (index.of(f.location.file) ?? undefined)].filter(
    (c): c is string => c !== undefined && index.has(c),
  );
  const component = sides.find((c) => touched.has(c)) ?? sides[0];
  const uri = component === undefined ? uriFor("rules", f.rule) : uriFor("components", component);
  const where = f.location === undefined ? "" : ` at ${code(f.location.line === undefined ? f.location.file : `${f.location.file}:${f.location.line}`)}`;
  const lines = [`Violation (${f.level}, ${f.status}) of ${code(f.rule)}${where}: ${uri}`, quoteLine(f.message, 300)];
  if (f.fix_hint !== undefined) lines.push(quoteLine(`Fix: ${f.fix_hint}`, 300));
  return makeItem("violation", f.fingerprint, uri, f.location === undefined ? "involves a touched component" : `in ${f.location.file}`, lines);
}

function cardItem(card: Card, full: boolean): ContextItem {
  const uri = uriFor("cards", card.id);
  const lines = [`Card ${code(card.id)} (${card.kind}): ${uri}`, quoteLine(`${card.title}: ${card.summary}`, 300)];
  if (full) {
    lines.push(quote(`Problem: ${card.problem}`));
    for (const w of card.use_when) lines.push(quoteLine(`Use when: ${w}`, 300));
    for (const w of card.avoid_when) lines.push(quoteLine(`Avoid when: ${w}`, 300));
  }
  return makeItem("card", card.id, uri, "matches the task", lines);
}
