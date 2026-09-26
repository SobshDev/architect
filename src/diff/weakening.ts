// Weakening detection: every way head's contract lets through code that base's contract blocked.
import {
  type BaselineEntry,
  type Decision,
  type Finding,
  type LayersRule,
  normalizeDecisionId,
  type Rule,
  type RuleLevel,
  type Waiver,
  type Weakening,
  type WeakeningType,
  type WorkspaceState,
} from "../model/index.ts";
import { evaluateRules } from "../rules/index.ts";

const LEVEL_RANK: Record<RuleLevel, number> = { off: 0, warn: 1, error: 2 };
const SEMANTIC_SAMPLES = 10;
const SEMANTIC_SKIP: readonly Rule["kind"][] = ["api-stability", "deprecated"];

/** Finds syntactic and semantic loosening between base and head, marking each with the head decision that approves it. */
export function detectWeakenings(base: WorkspaceState, head: WorkspaceState, options: { today: string }): Weakening[] {
  const found: Weakening[] = [...ruleWeakenings(base, head), ...waiverWeakenings(base, head, options.today), ...baselineWeakenings(base, head)];
  sortWeakenings(found);

  for (const semantic of semanticWeakenings(base, head, options.today)) {
    const first = found.find((w) => w.rule === semantic.rule);
    if (first) first.details.push(...semantic.details);
    else found.push(semantic);
  }
  sortWeakenings(found);

  const approvals = approvingDecisions(base.decisions, head.decisions);
  for (const w of found) {
    const approver = approvals.find((a) => a.weakens.has(w.rule) || (w.type === "baseline-grown" && a.weakens.has("baseline")));
    if (approver) w.approved_by = approver.id;
  }
  return found;
}

function sortWeakenings(list: Weakening[]): void {
  list.sort((a, b) => compare(a.rule, b.rule) || compare(a.type, b.type) || compare(a.message, b.message));
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function weakening(rule: string, type: WeakeningType, message: string, details: string[] = []): Weakening {
  return { rule, type, message, details };
}

// ---------------------------------------------------------------- rules.yaml

function ruleWeakenings(base: WorkspaceState, head: WorkspaceState): Weakening[] {
  const headRules = new Map(head.rules.rules.map((r) => [r.id, r]));
  const out: Weakening[] = [];
  for (const before of base.rules.rules) {
    if (before.level === "off") continue;
    const after = headRules.get(before.id);
    if (!after) {
      out.push(weakening(before.id, "rule-removed", `Rule ${before.id} was removed.`));
      continue;
    }
    if (LEVEL_RANK[after.level] < LEVEL_RANK[before.level]) {
      out.push(weakening(before.id, "level-lowered", `Rule ${before.id} was lowered from ${before.level} to ${after.level}.`));
    }
    if (before.include_type_imports && !after.include_type_imports) {
      out.push(weakening(before.id, "type-imports-excluded", `Rule ${before.id} no longer checks type imports.`));
    }
    const changed = kindChange(before, after);
    if (changed) {
      out.push(weakening(before.id, "rule-changed", `Rule ${before.id} ${changed}.`));
      continue;
    }
    const loosened = narrowings(before, after);
    if (loosened.length > 0) {
      out.push(weakening(before.id, "selector-narrowed", `Rule ${before.id} allows more: ${loosened.join("; ")}.`));
    }
  }
  return out;
}

/** A change that makes the two versions incomparable, described as a verb phrase, or null. */
function kindChange(before: Rule, after: Rule): string | null {
  if (before.kind !== after.kind) return `changed kind from ${before.kind} to ${after.kind}`;
  if (before.kind === "external-imports" && after.kind === "external-imports") {
    const form = (r: typeof before) => (r.packages !== undefined ? "packages + allow_from" : "from + allow/forbid");
    if (form(before) !== form(after)) return `changed form from ${form(before)} to ${form(after)}`;
  }
  if (before.kind === "acyclic" && after.kind === "acyclic" && before.scope !== after.scope) {
    return `changed scope from ${before.scope} to ${after.scope}`;
  }
  if (before.kind === "entrypoints" && after.kind === "entrypoints" && before.entrypoints !== undefined && after.entrypoints === undefined) {
    return "dropped its entrypoints override";
  }
  return null;
}

/** Phrases describing each selector change that lets more code through. Assumes kinds match. */
function narrowings(before: Rule, after: Rule): string[] {
  const out: string[] = [];
  const removed = (a: readonly string[] | undefined, b: readonly string[] | undefined, field: string) => {
    for (const s of minus(a ?? [], b ?? [])) out.push(`removed "${s}" from ${field}`);
  };
  const added = (a: readonly string[] | undefined, b: readonly string[] | undefined, field: string) => {
    for (const s of minus(b ?? [], a ?? [])) out.push(`added "${s}" to ${field}`);
  };
  const turnedOn = (a: boolean, b: boolean, field: string) => {
    if (!a && b) out.push(`${field} changed from false to true`);
  };

  switch (before.kind) {
    case "forbid": {
      const b = after as typeof before;
      removed(before.from, b.from, "from");
      removed(before.to, b.to, "to");
      break;
    }
    case "allow-only": {
      const b = after as typeof before;
      removed(before.from, b.from, "from");
      added(before.to, b.to, "to");
      if (before.scope === "all" && b.scope === "internal") out.push("scope changed from all to internal");
      break;
    }
    case "layers": {
      const b = after as typeof before;
      const headPairs = new Set(forbiddenPairs(b));
      for (const [x, y] of forbiddenPairs(before).map((p) => p.split("\u0000") as [string, string])) {
        if (!headPairs.has(`${x}\u0000${y}`)) out.push(`"${x}" may now depend on "${y}"`);
      }
      turnedOn(before.allow_skip, b.allow_skip, "allow_skip");
      break;
    }
    case "acyclic": {
      const b = after as typeof before;
      if (before.within === undefined && b.within !== undefined) out.push(`limited the check to within [${b.within.join(", ")}]`);
      else if (before.within !== undefined) removed(before.within, b.within, "within");
      break;
    }
    case "independent":
      removed(before.members, (after as typeof before).members, "members");
      break;
    case "entrypoints": {
      const b = after as typeof before;
      removed(before.targets, b.targets, "targets");
      added(before.entrypoints, b.entrypoints, "entrypoints");
      break;
    }
    case "external-imports": {
      const b = after as typeof before;
      if (before.packages !== undefined) {
        removed(before.packages, b.packages, "packages");
        added(before.allow_from, b.allow_from, "allow_from");
      } else {
        removed(before.from, b.from, "from");
        if (before.allow !== undefined && b.allow === undefined) out.push("removed the allow list");
        else if (before.allow !== undefined) added(before.allow, b.allow, "allow");
        removed(before.forbid, b.forbid, "forbid");
      }
      turnedOn(before.allow_builtins, b.allow_builtins, "allow_builtins");
      break;
    }
    case "state-owner": {
      const b = after as typeof before;
      if (before.resources === undefined && b.resources !== undefined) out.push(`limited resources to [${b.resources.join(", ")}]`);
      else if (before.resources !== undefined) removed(before.resources, b.resources, "resources");
      break;
    }
    case "api-stability": {
      const b = after as typeof before;
      removed(before.components, b.components, "components");
      turnedOn(before.allow_growth, b.allow_growth, "allow_growth");
      break;
    }
    case "deprecated": {
      const b = after as typeof before;
      if (before.components === undefined && b.components !== undefined) out.push(`limited components to [${b.components.join(", ")}]`);
      else if (before.components !== undefined) removed(before.components, b.components, "components");
      break;
    }
  }
  return out;
}

/** Sorted "x\0y" pairs where selector x may not depend on selector y. */
function forbiddenPairs(rule: LayersRule): string[] {
  const layers = rule.layers.map((l) => (typeof l === "string" ? [l] : l));
  const pairs = new Set<string>();
  layers.forEach((xs, i) => {
    layers.forEach((ys, j) => {
      if (j < i || (!rule.allow_skip && j > i + 1)) for (const x of xs) for (const y of ys) if (x !== y) pairs.add(`${x}\u0000${y}`);
    });
  });
  return [...pairs].sort(compare);
}

function minus(a: readonly string[], b: readonly string[]): string[] {
  const keep = new Set(b);
  return [...new Set(a)].filter((s) => !keep.has(s)).sort(compare);
}

// ---------------------------------------------------------------- waivers

function waiverWeakenings(base: WorkspaceState, head: WorkspaceState, today: string): Weakening[] {
  const key = (w: Waiver) => JSON.stringify([w.rule, w.from, w.to ?? null, w.expires, w.reason, w.decision ?? null]);
  const known = new Set(base.rules.waivers.map(key));
  return head.rules.waivers
    .filter((w) => w.expires >= today && !known.has(key(w)))
    .map((w) => {
      const scope = w.to === undefined ? `${w.from} (every target)` : `${w.from} → ${w.to}`;
      return weakening(w.rule, "waiver-added", `New waiver for rule ${w.rule}: ${scope} until ${w.expires}.`, [w.reason]);
    });
}

// ---------------------------------------------------------------- baseline.json

function baselineWeakenings(base: WorkspaceState, head: WorkspaceState): Weakening[] {
  const counts = (entries: readonly BaselineEntry[]) => {
    const map = new Map<string, { entry: BaselineEntry; count: number }>();
    for (const e of entries) {
      const prior = map.get(e.fingerprint);
      map.set(e.fingerprint, { entry: prior?.entry ?? e, count: (prior?.count ?? 0) + e.count });
    }
    return map;
  };
  const before = counts(base.baseline.entries);
  // Accepting existing violations of a rule that base did not enforce loosens nothing: adopting a new rule
  // usually means baselining what it finds on day one.
  const enforced = new Set(base.rules.rules.filter((rule) => rule.level !== "off").map((rule) => rule.id));
  const grown = new Map<string, string[]>();
  for (const [fp, { entry, count }] of counts(head.baseline.entries)) {
    if (!enforced.has(entry.rule)) continue;
    const was = before.get(fp)?.count ?? 0;
    if (count <= was) continue;
    const where = entry.file ?? entry.from ?? fp;
    const detail = `${entry.rule} ${where}${entry.to !== undefined ? ` → ${entry.to}` : ""}: base ${was}, head ${count}`;
    grown.set(entry.rule, [...(grown.get(entry.rule) ?? []), detail]);
  }
  return [...grown].map(([rule, details]) => {
    const n = details.length;
    return weakening(rule, "baseline-grown", `Baseline grew for rule ${rule}: ${n} ${n === 1 ? "entry" : "entries"}.`, details.sort(compare));
  });
}

// ---------------------------------------------------------------- semantic

function semanticWeakenings(base: WorkspaceState, head: WorkspaceState, today: string): Weakening[] {
  const run = (state: WorkspaceState) =>
    evaluateRules({
      graph: head.graph,
      architecture: state.architecture,
      rules: { ...state.rules, rules: state.rules.rules.filter((r) => !SEMANTIC_SKIP.includes(r.kind)), waivers: [] },
      today,
    });
  const byRule = (findings: Finding[]) => {
    const map = new Map<string, Finding[]>();
    for (const f of findings) map.set(f.rule, [...(map.get(f.rule) ?? []), f]);
    return map;
  };
  const baseFindings = byRule(run(base));
  const headFindings = byRule(run(head));

  const out: Weakening[] = [];
  for (const [rule, findings] of [...baseFindings].sort(([a], [b]) => compare(a, b))) {
    const remaining = new Map<string, number>();
    for (const f of headFindings.get(rule) ?? []) remaining.set(f.fingerprint, (remaining.get(f.fingerprint) ?? 0) + 1);
    const lost: Finding[] = [];
    for (const f of findings) {
      const left = remaining.get(f.fingerprint) ?? 0;
      if (left > 0) remaining.set(f.fingerprint, left - 1);
      else lost.push(f);
    }
    if (lost.length === 0) continue;
    const n = lost.length;
    const summary = `${n} ${n === 1 ? "violation" : "violations"} on the head graph that base's rule ${rule} reports and head's does not`;
    const samples = lost.slice(0, SEMANTIC_SAMPLES).map((f) => {
      const where = f.location ? `${f.location.file}${f.location.line !== undefined ? `:${f.location.line}` : ""}` : (f.from ?? "");
      return `${where} ${f.message}`;
    });
    out.push(weakening(rule, "semantic", `Rule ${rule} no longer reports ${n} ${n === 1 ? "violation" : "violations"} on the head graph.`, [summary, ...samples]));
  }
  return out;
}

// ---------------------------------------------------------------- approval

interface Approval {
  id: string;
  weakens: Set<string>;
}

/** Accepted head decisions that are new or changed their weakens list, lowest id first. */
function approvingDecisions(baseDecisions: readonly Decision[], headDecisions: readonly Decision[]): Approval[] {
  const norm = (id: string) => normalizeDecisionId(id) ?? id;
  const listKey = (d: Decision) => JSON.stringify([...new Set(d.weakens)].sort(compare));
  const before = new Map(baseDecisions.map((d) => [norm(d.id), listKey(d)]));
  return headDecisions
    .filter((d) => d.status === "accepted" && d.weakens.length > 0 && before.get(norm(d.id)) !== listKey(d))
    .sort((a, b) => compare(norm(a.id), norm(b.id)) || compare(a.id, b.id))
    .map((d) => ({ id: d.id, weakens: new Set(d.weakens) }));
}
