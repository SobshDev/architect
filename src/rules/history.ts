import { type Architecture, ComponentIndex, type Finding, type Graph, type HistorySummary, keyFingerprint, sortFindings } from "../model/index.ts";
import { componentGraph } from "./graph.ts";

const HOTSPOT_FINDINGS = 10;

const percent = (n: number) => `${Math.round(n * 100)}%`;

/**
 * Informational findings from change history: component pairs that change together without any import between
 * them (hidden change coupling), and the top hotspots.
 */
export function historyFindings(history: HistorySummary, graph: Graph, architecture: Architecture): Finding[] {
  const index = new ComponentIndex(architecture.components, graph.workspaces);
  const linked = new Set<string>();
  for (const e of componentGraph(graph, index).edges) {
    linked.add(`${e.from}\u0000${e.to}`);
    linked.add(`${e.to}\u0000${e.from}`);
  }
  const findings: Finding[] = [];
  for (const pair of history.componentPairs) {
    if (!index.has(pair.a) || !index.has(pair.b) || linked.has(`${pair.a}\u0000${pair.b}`)) continue;
    findings.push({
      rule: "hidden-change-coupling",
      kind: "history",
      level: "info",
      message: `Components ${pair.a} and ${pair.b} changed together in ${pair.support} commits (confidence ${percent(pair.confidence)}) but neither imports the other.`,
      from: pair.a,
      to: pair.b,
      because: [],
      fix_hint: "Look for an implicit contract (shared data shape, protocol, or config) and make it explicit, or merge the components.",
      fingerprint: keyFingerprint("hidden-change-coupling", pair.a, pair.b),
      status: "new",
    });
  }
  for (const spot of history.hotspots.slice(0, HOTSPOT_FINDINGS)) {
    const component = index.of(spot.path);
    findings.push({
      rule: "hotspot",
      kind: "history",
      level: "info",
      message: `${spot.path} is a hotspot: ${spot.churn} lines changed since ${history.since.slice(0, 10)} across a file of ${spot.loc} lines (score ${spot.score}).`,
      ...(component !== null && { from: component }),
      location: { file: spot.path },
      because: [],
      fix_hint: "Frequent change in a large file concentrates risk; consider splitting it along the reasons it changes.",
      fingerprint: keyFingerprint("hotspot", spot.path),
      status: "new",
    });
  }
  return sortFindings(findings);
}
