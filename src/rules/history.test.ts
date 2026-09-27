import { describe, expect, test } from "bun:test";
import type { Edge, FileFacts, Graph, HistorySummary } from "../model/index.ts";
import { ArchitectureSchema } from "../model/index.ts";
import { historyFindings } from "./history.ts";

function file(path: string): FileFacts {
  return { path, language: "typescript", contentId: path, loc: 10, imports: [], exports: [], starExports: [], dynamicImports: [], writes: [] };
}

const edge = (from: string, to: string): Edge => ({ from, to, specifier: to, kind: "static", line: 1, analyzer: "typescript" });

const architecture = ArchitectureSchema.parse({
  components: ["a", "b", "c"].map((id) => ({ id, paths: [id] })),
});

describe("historyFindings", () => {
  const pair = (a: string, b: string) => ({ a, b, support: 6, confidence: 0.75 });
  const history: HistorySummary = {
    head: "h",
    since: "2025-01-01T00:00:00Z",
    commits: 20,
    filePairs: [],
    componentPairs: [pair("a", "b"), pair("a", "c"), pair("b", "c")],
    hotspots: Array.from({ length: 12 }, (_, i) => ({ path: `a/f${i}.ts`, churn: 12 - i, commits: 3, loc: 10, score: (12 - i) * 10 })),
  };
  // b imports a; c imports nothing and nothing imports c.
  const graph: Graph = { version: 1, files: ["a/x.ts", "b/x.ts", "c/x.ts"].map(file), edges: [edge("b/x.ts", "a/x.ts")], workspaces: [] };

  test("reports co-changing components only when no import links them in either direction", () => {
    const coupling = historyFindings(history, graph, architecture).filter((f) => f.rule === "hidden-change-coupling");
    expect(coupling.map((f) => [f.from, f.to])).toEqual([
      ["a", "c"],
      ["b", "c"],
    ]);
    expect(coupling.every((f) => f.level === "info" && f.status === "new")).toBe(true);
  });

  test("reports the top ten hotspots only", () => {
    const hotspots = historyFindings(history, graph, architecture).filter((f) => f.rule === "hotspot");
    expect(hotspots).toHaveLength(10);
    expect(hotspots.some((f) => f.location?.file === "a/f10.ts" || f.location?.file === "a/f11.ts")).toBe(false);
  });
});
