import type { ComponentEdge, ComponentGraph } from "../model/index.ts";
import { compareText } from "./report.ts";

export type GraphFormat = "mermaid" | "dot" | "json";

const isTypeOnly = (edge: ComponentEdge): boolean => edge.kinds.length > 0 && edge.kinds.every((k) => k === "type");

function sortedEdges(graph: ComponentGraph): ComponentEdge[] {
  return [...graph.edges].sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to));
}

/** Every component named by the graph, including edge endpoints the component list missed. */
function nodes(graph: ComponentGraph): string[] {
  const all = new Set(graph.components);
  for (const e of graph.edges) all.add(e.from).add(e.to);
  return [...all].sort(compareText);
}

function mermaid(graph: ComponentGraph, cycles: readonly string[][]): string {
  // Mermaid node ids: [A-Za-z0-9_] only, prefixed so reserved words (end, graph) and leading digits are safe.
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const name of nodes(graph)) {
    const base = "c_" + name.replace(/[^A-Za-z0-9_]/g, "_");
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
    taken.add(id);
    ids.set(name, id);
  }
  const lines = ["flowchart LR"];
  for (const [name, id] of ids) lines.push(`  ${id}["${name.replaceAll('"', "#quot;")}"]`);
  for (const e of sortedEdges(graph)) {
    lines.push(`  ${ids.get(e.from)} ${isTypeOnly(e) ? "-.->" : "-->"}|${e.count}| ${ids.get(e.to)}`);
  }
  const members = [...new Set(cycles.flat())].filter((m) => ids.has(m)).sort(compareText);
  if (members.length > 0) {
    lines.push("  classDef cycle fill:#fde8e8,stroke:#c53030,stroke-width:2px");
    lines.push(`  class ${members.map((m) => ids.get(m)).join(",")} cycle`);
  }
  return lines.join("\n") + "\n";
}

function dot(graph: ComponentGraph, cycles: readonly string[][]): string {
  const quote = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const inCycle = new Set(cycles.flat());
  const lines = ["digraph architect {", "  rankdir=LR;", "  node [shape=box];"];
  for (const name of nodes(graph)) lines.push(`  ${quote(name)}${inCycle.has(name) ? " [color=red, fontcolor=red]" : ""};`);
  for (const e of sortedEdges(graph)) {
    lines.push(`  ${quote(e.from)} -> ${quote(e.to)} [label="${e.count}"${isTypeOnly(e) ? ", style=dashed" : ""}];`);
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

export function formatGraph(graph: ComponentGraph, format: GraphFormat, options: { cycles?: readonly string[][] } = {}): string {
  const cycles = options.cycles ?? [];
  switch (format) {
    case "mermaid":
      return mermaid(graph, cycles);
    case "dot":
      return dot(graph, cycles);
    case "json":
      return JSON.stringify(graph, null, 2) + "\n";
  }
}
