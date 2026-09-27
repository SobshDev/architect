import { expect, test } from "bun:test";
import { ArchitectureSchema, type Edge, type FileFacts, type Graph, RulesFileSchema } from "../model/index.ts";
import { inertRules } from "./index.ts";

const file = (path: string): FileFacts => ({ path, language: "typescript", contentId: path, loc: 1, imports: [], exports: [], starExports: [], dynamicImports: [], writes: [] });
const edge = (from: string, to: string): Edge => ({ from, to, specifier: to, kind: "static", line: 1, analyzer: "typescript" });

const architecture = ArchitectureSchema.parse({
  components: ["ui", "domain", "native"].map((id) => ({ id, paths: [id] })),
});
const rules = RulesFileSchema.parse({
  rules: [
    { id: "no-cycles", kind: "acyclic", because: ["0001"] },
    { id: "domain-no-packages", kind: "external-imports", from: ["domain"], allow: [], because: ["0001"] },
    { id: "native-down", kind: "forbid", from: ["native"], to: ["ui"], because: ["0001"] },
  ],
});

test("a rule over components with no analyzed files, or over a graph without edges, cannot fire", () => {
  const graph: Graph = { version: 1, files: [file("ui/a.ts"), file("domain/b.ts")], edges: [], workspaces: [] };
  expect(inertRules(graph, architecture, rules)).toEqual([
    { rule: "domain-no-packages", reason: "it evaluated 0 edges" },
    { rule: "native-down", reason: "it evaluated 0 edges; selector native matches no analyzed file" },
    { rule: "no-cycles", reason: "it evaluated 0 edges" },
  ]);
});

test("a rule whose source side has imports is working, even when none of them breaks it", () => {
  const graph: Graph = { version: 1, files: [file("ui/a.ts"), file("domain/b.ts")], edges: [edge("ui/a.ts", "domain/b.ts"), edge("domain/b.ts", "domain/c.ts")], workspaces: [] };
  expect(inertRules(graph, architecture, rules).map((r) => r.rule)).toEqual(["native-down"]);
});
