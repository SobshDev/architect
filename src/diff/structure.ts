import {
  anySelectorMatches,
  type ComponentGraph,
  ComponentIndex,
  cycleFingerprint,
  type DeprecatedRule,
  type Edge,
  edgeFingerprint,
  type Endpoint,
  type Finding,
  type FindingLevel,
  type Graph,
  keyFingerprint,
  type Location,
  sortFindings,
  targetEndpoint,
  targetKey,
  type WorkspaceState,
} from "../model/index.ts";
import { componentGraph, computeMetrics, findCycles } from "../rules/index.ts";

export interface EdgeDelta {
  from: string;
  to: string;
  baseCount: number;
  headCount: number;
  samples: { file: string; line: number; target: string }[];
}

type Pair<T> = { base: T; head: T };

/** Indexes for base and head under head's component map, each with its own workspaces. */
function indexes(base: WorkspaceState, head: WorkspaceState): Pair<ComponentIndex> {
  const components = head.architecture.components;
  return { base: new ComponentIndex(components, base.graph.workspaces), head: new ComponentIndex(components, head.graph.workspaces) };
}

function graphs(base: WorkspaceState, head: WorkspaceState, index = indexes(base, head)): Pair<ComponentGraph> {
  return { base: componentGraph(base.graph, index.base), head: componentGraph(head.graph, index.head) };
}

const pairKey = (from: string, to: string) => `${from}\u0000${to}`;

/** Component pairs that have edges only in head (added) or only in base (removed). */
export function componentEdgeDelta(base: WorkspaceState, head: WorkspaceState): { added: EdgeDelta[]; removed: EdgeDelta[] } {
  return edgeDeltaOf(graphs(base, head));
}

function edgeDeltaOf(cg: Pair<ComponentGraph>): { added: EdgeDelta[]; removed: EdgeDelta[] } {
  const baseKeys = new Set(cg.base.edges.map((e) => pairKey(e.from, e.to)));
  const headKeys = new Set(cg.head.edges.map((e) => pairKey(e.from, e.to)));
  return {
    added: cg.head.edges
      .filter((e) => !baseKeys.has(pairKey(e.from, e.to)))
      .map((e) => ({ from: e.from, to: e.to, baseCount: 0, headCount: e.count, samples: e.samples })),
    removed: cg.base.edges
      .filter((e) => !headKeys.has(pairKey(e.from, e.to)))
      .map((e) => ({ from: e.from, to: e.to, baseCount: e.count, headCount: 0, samples: e.samples })),
  };
}

/** Component-level cycles present only in head (added) or only in base (removed). */
export function cycleDelta(base: WorkspaceState, head: WorkspaceState): { added: string[][]; removed: string[][] } {
  return cycleDeltaOf(graphs(base, head));
}

function cycleDeltaOf(cg: Pair<ComponentGraph>): { added: string[][]; removed: string[][] } {
  const baseCycles = findCycles(cg.base.components, cg.base.edges);
  const headCycles = findCycles(cg.head.components, cg.head.edges);
  const key = (members: string[]) => members.join("\u0000");
  const baseKeys = new Set(baseCycles.map(key));
  const headKeys = new Set(headCycles.map(key));
  return { added: headCycles.filter((c) => !baseKeys.has(key(c))), removed: baseCycles.filter((c) => !headKeys.has(key(c))) };
}

const PROPAGATION_COST_THRESHOLD = 0.02;

function info(rule: string, message: string, fingerprint: string, extra: Partial<Finding> = {}): Finding {
  return { rule, kind: "diff", level: "info", message, because: [], fingerprint, status: "new", ...extra };
}

/** Informational findings: new component edges, new cycles (unless an acyclic rule reports them), and rising propagation cost. */
export function structureFindings(base: WorkspaceState, head: WorkspaceState): Finding[] {
  const index = indexes(base, head);
  const cg = graphs(base, head, index);
  const findings: Finding[] = [];

  for (const delta of edgeDeltaOf(cg).added) {
    const imports = delta.headCount === 1 ? "1 import" : `${delta.headCount} imports`;
    const sample = delta.samples[0];
    findings.push(
      info("new-component-edge", `${delta.from} now depends on ${delta.to} through ${imports}; base had no such dependency.`, keyFingerprint("new-component-edge", delta.from, delta.to), {
        from: delta.from,
        to: delta.to,
        ...(sample ? { location: { file: sample.file, line: sample.line } } : {}),
      }),
    );
  }

  const acyclicRule = head.rules.rules.some((r) => r.kind === "acyclic" && r.scope === "components" && r.level !== "off");
  if (!acyclicRule) {
    for (const members of cycleDeltaOf(cg).added) {
      const inCycle = new Set(members);
      const related: Location[] = cg.head.edges
        .filter((e) => inCycle.has(e.from) && inCycle.has(e.to))
        .flatMap((e) => (e.samples[0] ? [{ file: e.samples[0].file, line: e.samples[0].line }] : []));
      findings.push(
        info("new-cycle", `Components ${members.join(", ")} now form a dependency cycle; base had no such cycle.`, cycleFingerprint("new-cycle", members), { related }),
      );
    }
  }

  const before = computeMetrics(base.graph, index.base).propagationCost;
  const after = computeMetrics(head.graph, index.head).propagationCost;
  // Rounding removes floating-point noise, so a rise of exactly the threshold does not count.
  if (Math.round((after - before) * 1e9) / 1e9 > PROPAGATION_COST_THRESHOLD) {
    findings.push(
      info(
        "propagation-cost-rise",
        `Propagation cost rose from ${before.toFixed(2)} to ${after.toFixed(2)}: a change in one component now reaches more of the others.`,
        keyFingerprint("propagation-cost-rise"),
      ),
    );
  }
  return sortFindings(findings);
}

interface DeprecationCheck {
  rule: string;
  level: FindingLevel;
  because: string[];
  includeTypes: boolean;
  covers: (target: Endpoint & { component: string }) => boolean;
}

/** Findings for head edges into deprecated components from files that had no edge into that component at base. */
export function deprecatedFindings(base: WorkspaceState, head: WorkspaceState): Finding[] {
  const index = indexes(base, head);
  const marked = (id: string) => {
    const deprecated = index.head.get(id)?.deprecated;
    return deprecated !== undefined && deprecated !== false;
  };
  const rules = head.rules.rules.filter((r): r is DeprecatedRule => r.kind === "deprecated");
  const checks: DeprecationCheck[] = rules
    .filter((r) => r.level !== "off")
    .map((r) => {
      const selectors = r.components;
      return {
        rule: r.id,
        level: r.level === "warn" ? "warn" : "error",
        because: r.because,
        includeTypes: r.include_type_imports,
        covers: (target) => (selectors === undefined ? marked(target.component) : anySelectorMatches(selectors, target)),
      };
    });
  if (rules.length === 0 && head.architecture.components.some((c) => marked(c.id))) {
    checks.push({ rule: "deprecated-dependency", level: "warn", because: [], includeTypes: true, covers: (target) => marked(target.component) });
  }
  if (checks.length === 0) return [];

  const hadEdge = sourceTargetPairs(base.graph, index.base);
  const findings: Finding[] = [];
  for (const edge of head.graph.edges) {
    const target = targetEndpoint(edge, index.head);
    if (target === null || target.component === null) continue;
    const component = target.component;
    const source = index.head.of(edge.from);
    if (source === component || hadEdge.has(pairKey(edge.from, component))) continue;
    for (const check of checks) {
      if ((!check.includeTypes && edge.kind === "type") || !check.covers({ ...target, component })) continue;
      findings.push(deprecatedFinding(check, edge, source, component, index.head));
    }
  }
  return sortFindings(findings);
}

function deprecatedFinding(check: DeprecationCheck, edge: Edge, source: string | null, component: string, index: ComponentIndex): Finding {
  const deprecation = index.get(component)?.deprecated;
  const detail = typeof deprecation === "object" ? deprecation : undefined;
  const reason = detail ? `, which is deprecated: ${detail.reason}` : deprecation === true ? ", which is deprecated" : `, which ${check.rule} marks as deprecated`;
  const replacement = detail?.replacement;
  return {
    rule: check.rule,
    kind: "deprecated",
    level: check.level,
    message: `${edge.from} now depends on ${component}${reason}.${replacement ? ` Use ${replacement} instead.` : ""}`,
    from: source ?? edge.from,
    to: component,
    location: { file: edge.from, line: edge.line },
    because: check.because,
    fix_hint: replacement
      ? `Depend on ${replacement} instead of ${component}.`
      : `Use the replacement for ${component} instead, or record a decision that lists ${check.rule} in weakens.`,
    fingerprint: edgeFingerprint(check.rule, edge.from, targetKey(edge), edge.kind),
    status: "new",
  };
}

/** Pairs of (source file, target component) that have at least one edge. */
function sourceTargetPairs(graph: Graph, index: ComponentIndex): Set<string> {
  const pairs = new Set<string>();
  for (const edge of graph.edges) {
    const component = targetEndpoint(edge, index)?.component;
    if (component) pairs.add(pairKey(edge.from, component));
  }
  return pairs;
}
