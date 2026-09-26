import { describe, expect, test } from "bun:test";
import { ArchitectureSchema, type Decision, type Edge, type FileFacts, RulesFileSchema, type WorkspaceState } from "../model/index.ts";
import { diffStates } from "./diff.ts";

const today = "2026-09-26";

function decision(id: string, weakens: string[]): Decision {
  return {
    id,
    file: `.architect/decisions/${id}-x.md`,
    title: id,
    status: "accepted",
    decision_makers: [],
    governs: [],
    supersedes: [],
    weakens,
    assumptions: [],
    evidence: [],
    body: "",
    imported: false,
  };
}

const rules = [
  { id: "stable", kind: "api-stability", level: "warn", components: ["infra"] },
  { id: "no-legacy", kind: "deprecated", level: "warn" },
];

/** infra is deprecated and exposes run() from index.ts; the head adds an app -> infra import and changes run(). */
function state(side: "base" | "head", decisions: Decision[] = [], deprecated = true): WorkspaceState {
  const signature = side === "base" ? "function run(): void" : "function run(x: number): void";
  const file = (path: string, exports: FileFacts["exports"] = []): FileFacts => ({
    path,
    language: "typescript",
    contentId: path + side,
    loc: 1,
    imports: [],
    exports,
    starExports: [],
    dynamicImports: [],
    writes: [],
  });
  const edges: Edge[] =
    side === "head" ? [{ from: "src/app/main.ts", to: "src/infra/index.ts", specifier: "../infra/index.ts", kind: "static", line: 2, analyzer: "typescript" }] : [];
  return {
    label: side,
    graph: { version: 1, files: [file("src/app/main.ts"), file("src/infra/index.ts", [{ name: "run", kind: "function", signature, line: 1 }])], edges, workspaces: [] },
    architecture: ArchitectureSchema.parse({
      components: [
        { id: "app", paths: ["src/app"] },
        { id: "infra", paths: ["src/infra"], entrypoints: ["src/infra/index.ts"], ...(deprecated ? { deprecated: true } : {}) },
      ],
    }),
    rules: RulesFileSchema.parse({ rules }),
    decisions,
    baseline: { schema_version: 1, entries: [] },
  };
}

const diffOnly = (result: ReturnType<typeof diffStates>) =>
  result.findings.filter((f) => f.kind === "api-stability" || f.kind === "deprecated").map((f) => [f.rule, f.status, f.approved_by]);

describe("diffStates approvals", () => {
  test("without a decision, the API break and the new dependent are new findings", () => {
    expect(diffOnly(diffStates({ base: state("base"), head: state("head"), today }))).toEqual([
      ["no-legacy", "new", undefined],
      ["stable", "new", undefined],
    ]);
  });

  test("a new decision that lists a rule in weakens approves its findings", () => {
    const head = state("head", [decision("0009", ["stable", "no-legacy"])]);
    expect(diffOnly(diffStates({ base: state("base"), head, today }))).toEqual([
      ["no-legacy", "waived", "0009"],
      ["stable", "waived", "0009"],
    ]);
  });

  test("an unchanged old decision approves nothing", () => {
    const old = [decision("0003", ["stable", "no-legacy"])];
    const result = diffStates({ base: state("base", old), head: state("head", old), today });
    expect(diffOnly(result).map(([, status]) => status)).toEqual(["new", "new"]);
  });

  test("dropping the deprecated mark in the same change is a weakening of the deprecated rule", () => {
    const result = diffStates({ base: state("base"), head: state("head", [], false), today });
    expect(result.weakenings.map((w) => [w.rule, w.type, w.approved_by])).toEqual([["no-legacy", "component-changed", undefined]]);
  });
});

