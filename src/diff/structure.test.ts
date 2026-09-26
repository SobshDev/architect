import { describe, expect, test } from "bun:test";
import { ArchitectureSchema, type Edge, type FileFacts, RulesFileSchema, type WorkspaceState } from "../model/index.ts";
import { componentEdgeDelta, cycleDelta, deprecatedFindings, structureFindings } from "./structure.ts";

const components = [
  { id: "api", paths: ["src/api"] },
  { id: "db", paths: ["src/db"] },
  { id: "auth", paths: ["src/auth"] },
  { id: "legacy", paths: ["src/legacy"], deprecated: { reason: "replaced by auth", replacement: "auth" } },
];

function state(edges: [string, string, number?, Edge["kind"]?][], rules: unknown[] = [], comps: unknown[] = components): WorkspaceState {
  const paths = [...new Set(edges.flatMap(([a, b]) => [a, b]))].sort();
  const files: FileFacts[] = paths.map((path) => ({ path, language: "typescript", contentId: path, loc: 1, imports: [], exports: [], starExports: [], dynamicImports: [], writes: [] }));
  return {
    label: "test",
    graph: {
      version: 1,
      files,
      edges: edges.map(([from, to, line = 1, kind = "static"]) => ({ from, to, specifier: to, kind, line, analyzer: "typescript" })),
      workspaces: [],
    },
    architecture: ArchitectureSchema.parse({ components: comps }),
    rules: RulesFileSchema.parse({ rules }),
    decisions: [],
    baseline: { schema_version: 1, entries: [] },
  };
}

describe("component edges and cycles", () => {
  test("new and removed component pairs", () => {
    const base = state([["src/api/a.ts", "src/auth/x.ts"]]);
    const head = state([
      ["src/api/a.ts", "src/db/x.ts", 3],
      ["src/api/b.ts", "src/db/y.ts"],
    ]);
    const delta = componentEdgeDelta(base, head);
    expect(delta.added.map((d) => [d.from, d.to, d.baseCount, d.headCount])).toEqual([["api", "db", 0, 2]]);
    expect(delta.removed.map((d) => [d.from, d.to, d.baseCount, d.headCount])).toEqual([["api", "auth", 1, 0]]);
    const finding = structureFindings(base, head).find((f) => f.rule === "new-component-edge")!;
    expect(finding.message).toBe("api now depends on db through 2 imports; base had no such dependency.");
    expect(finding.location).toEqual({ file: "src/api/a.ts", line: 3 });
  });

  test("new cycles are reported unless an acyclic component rule already covers them", () => {
    const base = state([["src/api/a.ts", "src/db/x.ts"]]);
    const head = state([
      ["src/api/a.ts", "src/db/x.ts"],
      ["src/db/x.ts", "src/api/a.ts"],
    ]);
    expect(cycleDelta(base, head)).toEqual({ added: [["api", "db"]], removed: [] });
    expect(cycleDelta(head, base)).toEqual({ added: [], removed: [["api", "db"]] });
    expect(structureFindings(base, head).filter((f) => f.rule === "new-cycle")).toHaveLength(1);
    const guarded = state(head.graph.edges.map((e) => [e.from, e.to!] as [string, string]), [{ id: "no-cycles", kind: "acyclic", level: "warn" }]);
    expect(structureFindings(base, guarded).filter((f) => f.rule === "new-cycle")).toEqual([]);
  });

  test("propagation cost rise is reported only above the threshold", () => {
    // Four components: each new edge adds one reachable pair out of 16 (0.0625).
    const base = state([]);
    const head = state([["src/api/a.ts", "src/db/x.ts"]]);
    const rise = structureFindings(base, head).find((f) => f.rule === "propagation-cost-rise");
    expect(rise?.message).toContain("from 0.25 to 0.31");
    // With 8 components one new edge adds 1/64 (about 0.016), below the threshold.
    const many = [...components, ...["e", "f", "g", "h"].map((id) => ({ id, paths: [`src/${id}`] }))];
    const small = structureFindings(state([], [], many), state([["src/api/a.ts", "src/db/x.ts"]], [], many));
    expect(small.find((f) => f.rule === "propagation-cost-rise")).toBeUndefined();
  });
});

describe("deprecatedFindings", () => {
  const rule = { id: "no-legacy", kind: "deprecated", level: "error", because: ["0004"] };

  test("a new edge from a file with no prior edge into the component is a finding; existing dependents are not", () => {
    const base = state([["src/api/old.ts", "src/legacy/a.ts"]], [rule]);
    const head = state(
      [
        ["src/api/old.ts", "src/legacy/b.ts"],
        ["src/api/new.ts", "src/legacy/a.ts", 7],
        ["src/legacy/a.ts", "src/legacy/b.ts"],
      ],
      [rule],
    );
    const findings = deprecatedFindings(base, head);
    expect(findings.map((f) => [f.rule, f.level, f.location?.file, f.location?.line])).toEqual([["no-legacy", "error", "src/api/new.ts", 7]]);
    expect(findings[0]!.message).toBe("src/api/new.ts now depends on legacy, which is deprecated: replaced by auth. Use auth instead.");
    expect(findings[0]!.because).toEqual(["0004"]);
  });

  test("without a deprecated rule, marked components still warn; an off rule silences them", () => {
    const head = (rules: unknown[]) => state([["src/api/new.ts", "src/legacy/a.ts"]], rules);
    expect(deprecatedFindings(state([]), head([])).map((f) => [f.rule, f.level])).toEqual([["deprecated-dependency", "warn"]]);
    expect(deprecatedFindings(state([]), head([{ ...rule, level: "off" }]))).toEqual([]);
  });

  test("rule selectors cover components that are not marked deprecated", () => {
    const head = state([["src/api/a.ts", "src/db/x.ts"]], [{ id: "no-db", kind: "deprecated", level: "warn", components: ["db"] }]);
    expect(deprecatedFindings(state([]), head).map((f) => f.to)).toEqual(["db"]);
  });
});
