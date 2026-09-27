import { describe, expect, test } from "bun:test";
import { ArchitectureSchema, ComponentIndex, type Decision, type Edge, type FileFacts, type Graph, RulesFileSchema } from "../model/index.ts";
import { computeMetrics, decisionFindings, metricFindings } from "./index.ts";

function file(path: string, loc = 10): FileFacts {
  return { path, language: "typescript", contentId: path, loc, imports: [], exports: [], starExports: [], dynamicImports: [], writes: [] };
}

function dep(from: string, to: string): Edge {
  return { from: `src/${from}/i.ts`, to: `src/${to}/i.ts`, specifier: to, kind: "static", line: 1, analyzer: "typescript" };
}

function setup(ids: string[], deps: [string, string][], loc: Record<string, number> = {}) {
  const architecture = ArchitectureSchema.parse({ components: ids.map((id) => ({ id, paths: [`src/${id}`] })) });
  const graph: Graph = { version: 1, files: ids.map((id) => file(`src/${id}/i.ts`, loc[id] ?? 10)), edges: deps.map(([a, b]) => dep(a, b)), workspaces: [] };
  return { architecture, graph };
}

describe("metrics", () => {
  test("instability and propagation cost", () => {
    const { architecture, graph } = setup(["a", "b", "c"], [["a", "b"], ["b", "c"]]);
    const { components, propagationCost } = computeMetrics(graph, new ComponentIndex(architecture.components));
    expect(components.map((c) => c.instability)).toEqual([1, 0.5, 0]);
    // a reaches 3, b reaches 2, c reaches 1 (self included) out of 9.
    expect(propagationCost).toBeCloseTo(6 / 9);
    const isolated = setup(["x"], []);
    expect(computeMetrics(isolated.graph, new ComponentIndex(isolated.architecture.components)).components[0]!.instability).toBeNull();
  });

  test("hub needs fan-in and fan-out of at least three", () => {
    const hub = setup(["h", "a", "b", "c", "x", "y", "z"], [["a", "h"], ["b", "h"], ["c", "h"], ["h", "x"], ["h", "y"], ["h", "z"]]);
    expect(metricFindings(hub.graph, hub.architecture).filter((f) => f.rule === "hub-component").map((f) => f.from)).toEqual(["h"]);
    const small = setup(["h", "a", "b", "x", "y", "z"], [["a", "h"], ["b", "h"], ["h", "x"], ["h", "y"], ["h", "z"]]);
    expect(metricFindings(small.graph, small.architecture).filter((f) => f.rule === "hub-component")).toEqual([]);
  });

  test("god component needs four components and over 30% of files and lines", () => {
    const four = setup(["big", "a", "b", "c"], [], { big: 100 });
    four.graph.files.push(file("src/big/j.ts", 100));
    expect(metricFindings(four.graph, four.architecture).map((f) => f.rule)).toEqual(["god-component"]);
    const three = setup(["big", "a", "b"], [], { big: 100 });
    expect(metricFindings(three.graph, three.architecture)).toEqual([]);
  });

  test("god component needs the evidence: not on a small sample, and never from tests or scripts", () => {
    const four = setup(["big", "a", "b", "c"], [], { big: 100 });
    four.graph.files.push(file("src/big/j.ts", 100));
    expect(metricFindings(four.graph, four.architecture, { files_analyzed: 5, source_files: 100 })).toEqual([]);
    const [partial] = metricFindings(four.graph, four.architecture, { files_analyzed: 5, source_files: 8 });
    expect(partial?.message).toEndWith("Based on the 5 analyzed files, 62% of 8 source files.");
    const scripted = setup(["tools", "a", "b", "c"], []);
    for (let i = 0; i < 5; i++) scripted.graph.files.push(file(`src/tools/scripts/s${i}.ts`, 100));
    expect(metricFindings(scripted.graph, scripted.architecture)).toEqual([]);
  });

  test("unstable dependency when the target is much less stable", () => {
    // s is depended on by p, q and depends on u; u depends on v and w.
    const { architecture, graph } = setup(["p", "q", "s", "u", "v", "w"], [["p", "s"], ["q", "s"], ["s", "u"], ["u", "v"], ["u", "w"]]);
    const findings = metricFindings(graph, architecture).filter((f) => f.rule === "unstable-dependency");
    expect(findings.map((f) => `${f.from}->${f.to}`)).toEqual(["s->u"]);
    expect(findings[0]!.level).toBe("info");
  });
});

function decision(id: string, extra: Partial<Decision> = {}): Decision {
  return {
    id,
    file: `.architect/decisions/${id}-x.md`,
    title: `Decision ${id}`,
    status: "accepted",
    decision_makers: [],
    governs: [],
    supersedes: [],
    weakens: [],
    assumptions: [],
    evidence: [],
    body: "",
    imported: false,
    ...extra,
  };
}

describe("decision findings", () => {
  const { architecture, graph } = setup(["a", "b"], []);
  const rules = RulesFileSchema.parse({
    rules: [{ id: "a-no-b", kind: "forbid", from: ["a"], to: ["b"], because: ["ADR-0002", "0003"] }],
  });

  test("stale, superseded, and unchecked", () => {
    const decisions = [
      decision("0001", {
        governs: ["a", "src/b/**", "gone", "src/old/**"],
        assumptions: [
          { text: "traffic stays low", review_by: "2026-01-01" },
          { text: "fresh", review_by: "2027-01-01" },
          { text: "checked", check: "a-no-b" },
          { text: "dangling", check: "missing-rule" },
        ],
      }),
      decision("0002", { status: "superseded", superseded_by: "0004" }),
      decision("0003", { status: "accepted" }),
      decision("0005", { status: "rejected", governs: ["gone"] }),
    ];
    const findings = decisionFindings({ graph, architecture, rules, decisions, today: "2026-09-26" });
    expect(findings.map((f) => f.rule).sort()).toEqual(["stale-decision", "stale-decision", "stale-decision", "superseded-citation", "unchecked-assumption"]);
    expect(findings.find((f) => f.rule === "superseded-citation")!.message).toContain("0004");
    expect(findings.every((f) => f.level === "info" && f.kind === "decision")).toBe(true);
  });
});
