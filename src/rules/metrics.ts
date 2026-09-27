import {
  type Architecture,
  ComponentIndex,
  type Coverage,
  coveragePercent,
  type Finding,
  type Graph,
  isLowCoverage,
  isNonProduction,
  keyFingerprint,
  sortFindings,
} from "../model/index.ts";
import { componentGraph } from "./graph.ts";

export interface ComponentMetrics {
  id: string;
  files: number;
  loc: number;
  fanIn: number;
  fanOut: number;
  instability: number | null;
}

/** Size, coupling, and Martin's instability per component, plus the propagation cost of the component graph. */
export function computeMetrics(graph: Graph, index: ComponentIndex): { components: ComponentMetrics[]; propagationCost: number } {
  const ids = index.ids();
  const cg = componentGraph(graph, index);
  const components = ids.map((id) => {
    const owned = graph.files.filter((f) => index.of(f.path) === id);
    const fanIn = new Set(cg.edges.filter((e) => e.to === id).map((e) => e.from)).size;
    const fanOut = new Set(cg.edges.filter((e) => e.from === id).map((e) => e.to)).size;
    return {
      id,
      files: owned.length,
      loc: owned.reduce((sum, f) => sum + f.loc, 0),
      fanIn,
      fanOut,
      instability: fanIn + fanOut === 0 ? null : fanOut / (fanIn + fanOut),
    };
  });
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of cg.edges) out.get(e.from)?.push(e.to);
  let reachable = 0;
  for (const id of ids) {
    const seen = new Set([id]);
    const queue = [id];
    while (queue.length > 0) {
      for (const next of out.get(queue.shift()!) ?? []) {
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(next);
      }
    }
    reachable += seen.size;
  }
  return { components, propagationCost: ids.length === 0 ? 0 : reachable / (ids.length * ids.length) };
}

const round = (n: number) => Math.round(n * 100) / 100;

function info(rule: string, message: string, fingerprint: string, from: string, to?: string): Finding {
  const finding: Finding = { rule, kind: "metric", level: "info", message, from, because: [], fingerprint, status: "new" };
  if (to !== undefined) finding.to = to;
  return finding;
}

/**
 * Informational findings: hub components, god components, and unstable dependencies. With coverage, they are held
 * to the evidence behind them: when some source files were not analyzed, each message says which share it rests
 * on, and below LOW_COVERAGE the size shares of god-component are not reported at all, since a sample cannot
 * support them. Size shares count production code only, without tests, fixtures, and scripts.
 */
export function metricFindings(graph: Graph, architecture: Architecture, coverage?: Pick<Coverage, "files_analyzed" | "source_files">): Finding[] {
  const index = new ComponentIndex(architecture.components, graph.workspaces);
  const { components } = computeMetrics(graph, index);
  const n = components.length;
  const byId = new Map(components.map((c) => [c.id, c]));
  const findings: Finding[] = [];
  const partial = coverage !== undefined && coverage.source_files > coverage.files_analyzed;
  const basis = partial ? ` Based on the ${coverage.files_analyzed} analyzed files, ${coveragePercent(coverage)} of ${coverage.source_files} source files.` : "";

  const hub = Math.max(3, Math.ceil(0.3 * (n - 1)));
  for (const c of components) {
    if (c.fanIn >= hub && c.fanOut >= hub) {
      findings.push(
        info("hub-component", `Component ${c.id} is a hub: ${c.fanIn} components depend on it and it depends on ${c.fanOut} (threshold ${hub}).${basis}`, keyFingerprint("hub-component", c.id), c.id),
      );
    }
  }

  const production = graph.files.filter((f) => !isNonProduction(f.path));
  const totalFiles = production.length;
  const totalLoc = production.reduce((sum, f) => sum + f.loc, 0);
  const lowCoverage = coverage !== undefined && isLowCoverage(coverage);
  if (n >= 4 && totalFiles > 0 && totalLoc > 0 && !lowCoverage) {
    const size = new Map<string, { files: number; loc: number }>();
    for (const f of production) {
      const id = index.of(f.path);
      if (id === null) continue;
      const s = size.get(id) ?? { files: 0, loc: 0 };
      s.files++;
      s.loc += f.loc;
      size.set(id, s);
    }
    for (const c of components) {
      const own = size.get(c.id) ?? { files: 0, loc: 0 };
      const fileShare = own.files / totalFiles;
      const locShare = own.loc / totalLoc;
      if (fileShare > 0.3 && locShare > 0.3) {
        findings.push(
          info(
            "god-component",
            `Component ${c.id} holds ${own.files} of ${totalFiles} production files (${Math.round(fileShare * 100)}%) and ${own.loc} of ${totalLoc} lines (${Math.round(locShare * 100)}%).${basis}`,
            keyFingerprint("god-component", c.id),
            c.id,
          ),
        );
      }
    }
  }

  for (const e of componentGraph(graph, index).edges) {
    const from = byId.get(e.from)?.instability;
    const to = byId.get(e.to)?.instability;
    if (from == null || to == null || to - from <= 0.25) continue;
    findings.push(
      info(
        "unstable-dependency",
        `Component ${e.from} (instability ${round(from)}) depends on ${e.to}, which is less stable (instability ${round(to)}).${basis}`,
        keyFingerprint("unstable-dependency", e.from, e.to),
        e.from,
        e.to,
      ),
    );
  }
  return sortFindings(findings);
}
