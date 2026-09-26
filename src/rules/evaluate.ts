import {
  anySelectorMatches,
  type Architecture,
  ComponentIndex,
  cycleFingerprint,
  DIFF_ONLY_RULE_KINDS,
  type Edge,
  edgeFingerprint,
  type Endpoint,
  type Finding,
  globMatcher,
  type Graph,
  keyFingerprint,
  type Location,
  parseSelector,
  type Rule,
  type RulesFile,
  selectorMatches,
  sortFindings,
  sourceEndpoint,
  targetEndpoint,
  targetKey,
  type Waiver,
} from "../model/index.ts";
import picomatch from "picomatch";
import { componentGraph, cyclePath, findCycles } from "./graph.ts";

export interface EvaluateInput {
  graph: Graph;
  architecture: Architecture;
  rules: RulesFile;
  /** ISO date; waivers that expired before it are ignored. */
  today: string;
  /** Limit edge and state rules to edges from these source files (hook and --changed mode). Cycle rules always use the whole graph. */
  files?: ReadonlySet<string>;
}

const WEAKEN_HINT = "If the rule itself is wrong, change it with a decision that lists it in weakens.";

type EdgeRule = Exclude<Rule, { kind: "acyclic" | "state-owner" | "api-stability" | "deprecated" }>;

/** What an edge rule reports for one offending edge. */
interface Violation {
  message: string;
  hint: string;
}

interface EdgeContext {
  edge: Edge;
  source: Endpoint;
  target: Endpoint;
  fromLabel: string;
  toLabel: string;
  /** How the target reads in a sentence: a file path or "package x". */
  targetText: string;
  index: ComponentIndex;
}

export function evaluateRules(input: EvaluateInput): Finding[] {
  const { graph, architecture, rules, today, files } = input;
  const index = new ComponentIndex(architecture.components, graph.workspaces);
  const waivers = rules.waivers.filter((w) => w.expires >= today);
  const findings: Finding[] = [];

  for (const rule of rules.rules) {
    if (rule.level === "off" || DIFF_ONLY_RULE_KINDS.includes(rule.kind)) continue;
    const ruleWaivers = waivers.filter((w) => w.rule === rule.id);
    if (rule.kind === "acyclic") {
      findings.push(...acyclicFindings(rule, graph, index, ruleWaivers));
      continue;
    }
    if (rule.kind === "state-owner") {
      findings.push(...stateFindings(rule, graph, architecture, index, ruleWaivers, files));
      continue;
    }
    if (rule.kind === "api-stability" || rule.kind === "deprecated") continue;
    const check = edgeChecker(rule, index);
    for (const edge of graph.edges) {
      if (edge.unresolved) continue;
      if (files && !files.has(edge.from)) continue;
      if (!rule.include_type_imports && edge.kind === "type") continue;
      const target = targetEndpoint(edge, index);
      if (target === null) continue;
      const source = sourceEndpoint(edge.from, index);
      const ctx: EdgeContext = {
        edge,
        source,
        target,
        index,
        fromLabel: source.component ?? edge.from,
        toLabel: target.component ?? target.package ?? target.file ?? edge.specifier,
        targetText: edge.to ?? (edge.package !== undefined ? `package ${edge.package}` : `workspace package ${edge.workspace}`),
      };
      const violation = check(ctx);
      if (!violation) continue;
      findings.push({
        rule: rule.id,
        kind: rule.kind,
        level: rule.level,
        message: violation.message,
        from: ctx.fromLabel,
        to: ctx.toLabel,
        location: { file: edge.from, line: edge.line },
        because: rule.because,
        fix_hint: hint(rule.description, violation.hint),
        fingerprint: edgeFingerprint(rule.id, edge.from, targetKey(edge), edge.kind),
        status: ruleWaivers.some((w) => waiverMatches(w, [source], target)) ? "waived" : "new",
      });
    }
  }
  return sortFindings(findings);
}

function hint(description: string | undefined, text: string): string {
  const prefix = description === undefined || description.trim() === "" ? "" : `${description.trim().replace(/\.?$/, ".")} `;
  return `${prefix}${text} ${WEAKEN_HINT}`;
}

function waiverMatches(waiver: Waiver, sources: readonly Endpoint[], target: Endpoint | null): boolean {
  const from = parseSelector(waiver.from);
  if (!sources.some((s) => selectorMatches(from, s))) return false;
  if (waiver.to === undefined) return true;
  return target !== null && selectorMatches(parseSelector(waiver.to), target);
}

function packageMatcher(globs: readonly string[] | undefined): ((name: string) => boolean) | null {
  if (globs === undefined) return null;
  if (globs.length === 0) return () => false;
  return picomatch([...globs], { dot: true });
}

function layerLabel(entry: string | string[]): string {
  return Array.isArray(entry) ? entry.join(", ") : entry;
}

function edgeChecker(rule: EdgeRule, index: ComponentIndex): (ctx: EdgeContext) => Violation | null {
  const arrow = (c: EdgeContext) => `${c.edge.from} imports ${c.targetText} (${c.fromLabel} → ${c.toLabel})`;
  switch (rule.kind) {
    case "forbid":
      return (c) => {
        if (!anySelectorMatches(rule.from, c.source) || !anySelectorMatches(rule.to, c.target)) return null;
        return {
          message: `${arrow(c)}, which rule ${rule.id} forbids.`,
          hint: `Remove this dependency: depend on a port owned by ${c.fromLabel} and implement it outside, or move the code to a component the rule allows.`,
        };
      };
    case "allow-only":
      return (c) => {
        if (!anySelectorMatches(rule.from, c.source)) return null;
        if (c.target.external && rule.scope === "internal") return null;
        if (!c.target.external && c.target.component !== null && c.target.component === c.source.component) return null;
        if (anySelectorMatches(rule.to, c.target)) return null;
        const allowed = rule.to.length > 0 ? rule.to.join(", ") : "nothing else";
        return {
          message: `${arrow(c)}, which rule ${rule.id} does not allow (allowed besides its own component: ${allowed}).`,
          hint: c.target.external
            ? `Use an allowed package, or wrap ${c.toLabel} behind an adapter in a component the rule allows.`
            : `Depend only on the allowed targets (${allowed}); if you need ${c.toLabel}, add a port in an allowed component or move the code.`,
        };
      };
    case "layers": {
      const layers = rule.layers.map((entry) => (Array.isArray(entry) ? entry : [entry]));
      const layerOf = (e: Endpoint) => layers.findIndex((selectors) => anySelectorMatches(selectors, e));
      return (c) => {
        const from = layerOf(c.source);
        const to = layerOf(c.target);
        if (from < 0 || to < 0) return null;
        const fromName = layerLabel(rule.layers[from]!);
        const toName = layerLabel(rule.layers[to]!);
        if (to < from) {
          return {
            message: `${arrow(c)}, which breaks rule ${rule.id}: layer ${fromName} must not depend on the higher layer ${toName}.`,
            hint: `Invert the dependency with an interface owned by ${fromName} that ${toName} implements, or move the shared code down to ${fromName} or below.`,
          };
        }
        if (!rule.allow_skip && to > from + 1) {
          const next = layerLabel(rule.layers[from + 1]!);
          return {
            message: `${arrow(c)}, which breaks rule ${rule.id}: layer ${fromName} may only depend on the layer directly below it (${next}), not on ${toName}.`,
            hint: `Go through layer ${next} instead of reaching ${toName} directly.`,
          };
        }
        return null;
      };
    }
    case "independent": {
      const memberOf = (e: Endpoint) => rule.members.find((raw) => selectorMatches(parseSelector(raw), e));
      return (c) => {
        const from = memberOf(c.source);
        const to = memberOf(c.target);
        if (from === undefined || to === undefined || from === to) return null;
        return {
          message: `${arrow(c)}, but rule ${rule.id} keeps ${from} and ${to} independent.`,
          hint: `Move the shared piece into a component both may depend on, or connect them through a port or event owned elsewhere.`,
        };
      };
    }
    case "entrypoints": {
      const override = rule.entrypoints !== undefined ? globMatcher(rule.entrypoints) : null;
      return (c) => {
        const component = c.target.component;
        if (component === null || c.target.external || c.source.component === component) return null;
        if (!anySelectorMatches(rule.targets, { component, external: false })) return null;
        if (c.edge.to === undefined) return null;
        const isEntry = override ? override(c.edge.to) : index.hasEntrypoints(component) ? index.isEntrypoint(component, c.edge.to) : true;
        if (isEntry) return null;
        const globs = rule.entrypoints ?? index.get(component)?.entrypoints ?? [];
        return {
          message: `${arrow(c)}, which is not an entrypoint of ${component}, as rule ${rule.id} requires.`,
          hint: `Import from ${component}'s entrypoint (${globs.join(", ")}) instead, and export what you need there if it is missing.`,
        };
      };
    }
    case "external-imports": {
      const allow = packageMatcher(rule.allow);
      const forbid = packageMatcher(rule.forbid);
      const packages = packageMatcher(rule.packages);
      return (c) => {
        const edge = c.edge;
        if (edge.package === undefined || edge.to !== undefined || edge.workspace !== undefined) return null;
        const name = edge.package;
        if (packages) {
          if (!packages(name) || anySelectorMatches(rule.allow_from ?? [], c.source)) return null;
          return {
            message: `${edge.from} imports package ${name} (${c.fromLabel}), which rule ${rule.id} allows only from ${(rule.allow_from ?? []).join(", ")}.`,
            hint: `Use ${name} only from ${(rule.allow_from ?? []).join(", ")}, and call that code through its API from here.`,
          };
        }
        if (!anySelectorMatches(rule.from ?? [], c.source)) return null;
        if (edge.builtin && rule.allow_builtins) return null;
        const bad = (allow !== null && !allow(name)) || (forbid !== null && forbid(name));
        if (!bad) return null;
        return {
          message: `${edge.from} imports package ${name} (${c.fromLabel}), which rule ${rule.id} does not allow there.`,
          hint: `Use an allowed package, or wrap ${name} behind an adapter in a component the rule does not restrict.`,
        };
      };
    }
  }
}

function acyclicFindings(rule: Extract<Rule, { kind: "acyclic" }>, graph: Graph, index: ComponentIndex, waivers: readonly Waiver[]): Finding[] {
  const within = rule.within;
  let nodes: string[];
  let edges: { from: string; to: string; location: Location }[];
  let endpoint: (member: string) => Endpoint;
  let noun: string;

  if (rule.scope === "components") {
    nodes = index.ids().filter((id) => within === undefined || anySelectorMatches(within, { component: id, external: false }));
    edges = componentGraph(graph, index, { includeTypeImports: rule.include_type_imports }).edges.map((e) => ({
      from: e.from,
      to: e.to,
      location: { file: e.samples[0]!.file, line: e.samples[0]!.line },
    }));
    endpoint = (id) => ({ component: id, external: false });
    noun = "Components";
  } else {
    nodes = graph.files.map((f) => f.path).filter((p) => within === undefined || anySelectorMatches(within, sourceEndpoint(p, index)));
    const first = new Map<string, { from: string; to: string; location: Location }>();
    for (const edge of graph.edges) {
      if (edge.unresolved || edge.to === undefined || edge.to === edge.from) continue;
      if (!rule.include_type_imports && edge.kind === "type") continue;
      const key = `${edge.from}\u0000${edge.to}`;
      const seen = first.get(key);
      if (!seen || edge.line < (seen.location.line ?? 0)) first.set(key, { from: edge.from, to: edge.to, location: { file: edge.from, line: edge.line } });
    }
    edges = [...first.values()];
    endpoint = (file) => sourceEndpoint(file, index);
    noun = "Files";
  }

  const byPair = new Map(edges.map((e) => [`${e.from}\u0000${e.to}`, e.location]));
  return findCycles(nodes, edges).map((members) => {
    const path = cyclePath(members[0]!, new Set(members), edges);
    const related = path.slice(1).map((to, i) => byPair.get(`${path[i]}\u0000${to}`)!);
    const all = members.length > path.length - 1 ? `; all members: ${members.join(", ")}` : "";
    return {
      rule: rule.id,
      kind: rule.kind,
      level: rule.level as "error" | "warn",
      message: `${noun} ${path.join(" → ")} form a dependency cycle${all}, which rule ${rule.id} forbids.`,
      from: members[0]!,
      location: related[0],
      because: rule.because,
      fix_hint: hint(
        rule.description,
        "Break the cycle by moving the shared piece down into a component both sides can depend on, or invert one dependency with an interface.",
      ),
      fingerprint: cycleFingerprint(rule.id, members),
      status: waivers.some((w) => cycleWaived(w, members.map(endpoint))) ? "waived" : "new",
      related,
    } satisfies Finding;
  });
}

/** A cycle waiver matches when its from selector matches some member and its to selector, when present, matches some member. */
function cycleWaived(waiver: Waiver, members: readonly Endpoint[]): boolean {
  if (!members.some((m) => selectorMatches(parseSelector(waiver.from), m))) return false;
  return waiver.to === undefined || members.some((m) => selectorMatches(parseSelector(waiver.to!), m));
}

function stateFindings(
  rule: Extract<Rule, { kind: "state-owner" }>,
  graph: Graph,
  architecture: Architecture,
  index: ComponentIndex,
  waivers: readonly Waiver[],
  files: ReadonlySet<string> | undefined,
): Finding[] {
  const resources = new Map(architecture.resources.filter((r) => rule.resources === undefined || rule.resources.includes(r.id)).map((r) => [r.id, r]));
  const findings: Finding[] = [];
  for (const file of graph.files) {
    if (files && !files.has(file.path)) continue;
    for (const write of file.writes) {
      const resource = resources.get(write.resource);
      if (!resource) continue;
      const source = sourceEndpoint(file.path, index);
      if (source.component === resource.owner) continue;
      const target: Endpoint = { component: resource.owner, external: false };
      const fromLabel = source.component ?? file.path;
      findings.push({
        rule: rule.id,
        kind: rule.kind,
        level: rule.level as "error" | "warn",
        message: `${file.path} (${fromLabel}) writes resource ${resource.id}, which rule ${rule.id} reserves for its owner ${resource.owner}.`,
        from: fromLabel,
        to: resource.owner,
        location: { file: file.path, line: write.line },
        because: rule.because,
        fix_hint: hint(rule.description, `Route this write through an operation exposed by ${resource.owner} instead of writing ${resource.id} directly.`),
        fingerprint: keyFingerprint(rule.id, file.path, resource.id),
        status: waivers.some((w) => waiverMatches(w, [source], target)) ? "waived" : "new",
        heuristic: true,
      });
    }
  }
  return findings;
}
