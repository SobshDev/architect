// Rules that cannot report anything on the current graph. A rule over components without analyzed files, or over
// a graph without edges, passes by construction; saying so keeps a clean check from reading as a safe one.
import {
  anySelectorMatches,
  type Architecture,
  ComponentIndex,
  DIFF_ONLY_RULE_KINDS,
  type Edge,
  type Endpoint,
  type Graph,
  parseSelector,
  type Rule,
  type RulesFile,
  sourceEndpoint,
  targetEndpoint,
} from "../model/index.ts";
import { componentGraph } from "./graph.ts";

export interface InertRule {
  rule: string;
  reason: string;
}

/** Selectors of a rule that choose the code it checks, as opposed to the packages it names. */
function codeSelectors(rule: Rule): string[] {
  switch (rule.kind) {
    case "forbid":
    case "allow-only":
      return [...rule.from, ...rule.to];
    case "layers":
      return rule.layers.flat();
    case "acyclic":
      return rule.within ?? [];
    case "independent":
      return rule.members;
    case "entrypoints":
      return rule.targets;
    case "external-imports":
      return [...(rule.from ?? []), ...(rule.allow_from ?? [])];
    default:
      return [];
  }
}

/**
 * Edges the rule looks at: every import leaving the code on its source side, whatever the target. A rule whose
 * source side imports nothing at all has nothing to judge; one whose imports all point the right way is working.
 */
function inScope(rule: Rule): ((edge: Edge, source: Endpoint, target: Endpoint) => boolean) | null {
  switch (rule.kind) {
    case "forbid":
    case "allow-only":
      return (_e, s) => anySelectorMatches(rule.from, s);
    case "layers": {
      const layers = rule.layers.map((entry) => (Array.isArray(entry) ? entry : [entry]));
      return (_e, s) => layers.some((selectors) => anySelectorMatches(selectors, s));
    }
    case "independent":
      return (_e, s) => anySelectorMatches(rule.members, s);
    case "entrypoints":
      return (_e, s, t) => !t.external && t.component !== null && t.component !== s.component && anySelectorMatches(rule.targets, { component: t.component, external: false });
    case "external-imports":
      if (rule.packages !== undefined) return () => true;
      return (_e, s) => anySelectorMatches(rule.from ?? [], s);
    default:
      return null;
  }
}

function edgeCount(rule: Rule, graph: Graph, index: ComponentIndex): number | null {
  if (rule.kind === "acyclic") {
    if (rule.scope === "files") return graph.edges.filter((e) => !e.unresolved && e.to !== undefined && e.to !== e.from).length;
    const within = rule.within;
    const member = (id: string) => within === undefined || anySelectorMatches(within, { component: id, external: false });
    return componentGraph(graph, index, { includeTypeImports: rule.include_type_imports }).edges.filter((e) => member(e.from) && member(e.to)).length;
  }
  const check = inScope(rule);
  if (check === null) return null;
  const withTypes = "include_type_imports" in rule ? rule.include_type_imports !== false : true;
  let count = 0;
  for (const edge of graph.edges) {
    if (edge.unresolved || (!withTypes && edge.kind === "type")) continue;
    const target = targetEndpoint(edge, index);
    if (target === null) continue;
    if (check(edge, sourceEndpoint(edge.from, index), target)) count++;
  }
  return count;
}

/**
 * Active rules that cannot fire on this graph, each with the reason: selectors that match no analyzed file, and
 * rules that inspected no edge at all. Sorted by rule id.
 */
export function inertRules(graph: Graph, architecture: Architecture, rules: RulesFile): InertRule[] {
  const index = new ComponentIndex(architecture.components, graph.workspaces);
  const owned = new Set<string>();
  for (const file of graph.files) {
    const component = index.of(file.path);
    if (component !== null) owned.add(component);
  }
  const out: InertRule[] = [];
  for (const rule of rules.rules) {
    if (rule.level === "off" || DIFF_ONLY_RULE_KINDS.includes(rule.kind) || rule.kind === "state-owner") continue;
    const empty = [...new Set(codeSelectors(rule))].filter((raw) => {
      const selector = parseSelector(raw);
      if (selector.type === "component") return !owned.has(selector.id);
      if (selector.type === "path") return !graph.files.some((f) => selector.match(f.path));
      return false;
    });
    const edges = edgeCount(rule, graph, index);
    const parts: string[] = [];
    if (edges === 0) parts.push("it evaluated 0 edges");
    if (empty.length > 0) parts.push(`${empty.length === 1 ? "selector" : "selectors"} ${empty.sort().join(", ")} ${empty.length === 1 ? "matches" : "match"} no analyzed file`);
    if (parts.length > 0) out.push({ rule: rule.id, reason: parts.join("; ") });
  }
  return out.sort((a, b) => (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));
}
