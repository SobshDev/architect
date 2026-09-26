import { describe, expect, test } from "bun:test";
import { ArchitectureSchema, type Edge, type ExportedSymbol, type FileFacts, RulesFileSchema, type WorkspaceState } from "../model/index.ts";
import { apiStabilityFindings, diffApi } from "./api.ts";

type Spec = { exports?: Partial<ExportedSymbol>[]; stars?: string[] };

function state(files: Record<string, Spec>, edges: Partial<Edge>[] = [], rules: unknown[] = []): WorkspaceState {
  const facts: FileFacts[] = Object.entries(files)
    .map(([path, spec]) => ({
      path,
      language: "typescript" as const,
      contentId: path,
      loc: 1,
      imports: [],
      exports: (spec.exports ?? []).map((e) => ({ name: "x", kind: "function" as const, signature: "", line: 1, ...e })),
      starExports: spec.stars ?? [],
      dynamicImports: [],
      writes: [],
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return {
    label: "test",
    graph: {
      version: 1,
      files: facts,
      edges: edges.map((e) => ({ from: "", specifier: "", kind: "reexport" as const, line: 1, analyzer: "typescript" as const, ...e })),
      workspaces: [],
    },
    architecture: ArchitectureSchema.parse({
      components: [
        { id: "billing", paths: ["src/billing"], entrypoints: ["src/billing/index.ts"] },
        { id: "app", paths: ["src/app"] },
      ],
    }),
    rules: RulesFileSchema.parse({ rules }),
    decisions: [],
    baseline: { schema_version: 1, entries: [] },
  };
}

const starEdge = { from: "src/billing/index.ts", to: "src/billing/invoice.ts", specifier: "./invoice.ts" };

describe("diffApi", () => {
  test("a signature change behind export * is a changed API symbol", () => {
    const base = state({ "src/billing/index.ts": { stars: ["./invoice.ts"] }, "src/billing/invoice.ts": { exports: [{ name: "bill", signature: "function bill(a: number): void" }] } }, [starEdge]);
    const head = state({ "src/billing/index.ts": { stars: ["./invoice.ts"] }, "src/billing/invoice.ts": { exports: [{ name: "bill", signature: "function bill(a: string): void" }] } }, [starEdge]);
    expect(diffApi(base, head)).toEqual([
      { component: "billing", file: "src/billing/index.ts", symbol: "bill", change: "changed", before: "function bill(a: number): void", after: "function bill(a: string): void" },
    ]);
  });

  test("formatting-only differences are not changes", () => {
    const base = state({ "src/billing/index.ts": { exports: [{ name: "bill", signature: "function bill(a: number): void" }] } });
    const head = state({ "src/billing/index.ts": { exports: [{ name: "bill", signature: "function bill(\n  a:number,\n) :  void" }] } });
    expect(diffApi(base, head).filter((c) => c.change === "changed")).toEqual([]);
  });

  test("explicit exports shadow star exports, and default never passes through export *", () => {
    const files = (inner: string) => ({
      "src/billing/index.ts": { exports: [{ name: "bill", signature: "function bill(): void" }], stars: ["./invoice.ts"] },
      "src/billing/invoice.ts": { exports: [{ name: "bill", signature: inner }, { name: "default", kind: "default" as const, signature: inner }] },
    });
    expect(diffApi(state(files("function bill(): void"), [starEdge]), state(files("function bill(x: 1): void"), [starEdge]))).toEqual([]);
  });

  test("renamed re-exports resolve to the original declaration", () => {
    const edge = { from: "src/billing/index.ts", to: "src/billing/invoice.ts", specifier: "./invoice.ts" };
    const index = { exports: [{ name: "charge", kind: "reexport" as const, from: "./invoice.ts", original: "bill", signature: "export { bill as charge } from './invoice.ts'" }] };
    const base = state({ "src/billing/index.ts": index, "src/billing/invoice.ts": { exports: [{ name: "bill", signature: "function bill(): void" }] } }, [edge]);
    const head = state({ "src/billing/index.ts": index, "src/billing/invoice.ts": { exports: [{ name: "bill", signature: "function bill(): number" }] } }, [edge]);
    expect(diffApi(base, head)).toEqual([
      { component: "billing", file: "src/billing/index.ts", symbol: "charge", change: "changed", before: "function bill(): void", after: "function bill(): number" },
    ]);
  });

  test("re-export cycles terminate", () => {
    const edges = [starEdge, { from: "src/billing/invoice.ts", to: "src/billing/index.ts", specifier: "./index.ts" }];
    const files = { "src/billing/index.ts": { stars: ["./invoice.ts"] }, "src/billing/invoice.ts": { stars: ["./index.ts"], exports: [{ name: "bill" }] } };
    expect(diffApi(state(files, edges), state(files, edges))).toEqual([]);
  });

  test("reports removals and additions, and ignores files that are not entrypoints", () => {
    const base = state({ "src/billing/index.ts": { exports: [{ name: "old" }] }, "src/billing/internal.ts": { exports: [{ name: "a" }] }, "src/app/main.ts": { exports: [{ name: "b" }] } });
    const head = state({ "src/billing/index.ts": { exports: [{ name: "fresh" }] } });
    expect(diffApi(base, head).map((c) => `${c.symbol}:${c.change}`)).toEqual(["fresh:added", "old:removed"]);
  });
});

describe("apiStabilityFindings", () => {
  const base = state({ "src/billing/index.ts": { exports: [{ name: "bill", signature: "a" }, { name: "gone", signature: "g" }] } });
  const headFiles = { "src/billing/index.ts": { exports: [{ name: "bill", signature: "b" }, { name: "fresh", signature: "f" }] } };

  test("breaks take the rule's level; growth is ignored when allowed", () => {
    const head = state(headFiles, [], [{ id: "stable", kind: "api-stability", level: "error", because: ["0001"], components: ["billing"] }]);
    const findings = apiStabilityFindings(diffApi(base, head), head);
    expect(findings.map((f) => [f.level, f.message.split(" ")[4]])).toEqual([
      ["error", "changed"],
      ["error", "lost"],
    ]);
    expect(findings[0]!.because).toEqual(["0001"]);
  });

  test("growth is a warning when allow_growth is false, and rules at off report nothing", () => {
    const head = state(headFiles, [], [
      { id: "stable", kind: "api-stability", level: "warn", components: ["*"], allow_growth: false },
      { id: "muted", kind: "api-stability", level: "off", components: ["*"] },
    ]);
    const findings = apiStabilityFindings(diffApi(base, head), head);
    expect(findings.map((f) => f.rule)).toEqual(["stable", "stable", "stable"]);
    expect(findings.every((f) => f.level === "warn")).toBe(true);
  });

  test("rules only cover their components", () => {
    const head = state(headFiles, [], [{ id: "stable", kind: "api-stability", level: "warn", components: ["app"] }]);
    expect(apiStabilityFindings(diffApi(base, head), head)).toEqual([]);
  });
});
