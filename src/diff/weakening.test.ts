import { describe, expect, test } from "bun:test";
import {
  ArchitectureSchema,
  type BaselineEntry,
  type Decision,
  type Edge,
  type FileFacts,
  type Graph,
  RulesFileSchema,
  type WorkspaceState,
} from "../model/index.ts";
import { detectWeakenings } from "./weakening.ts";

const today = "2026-09-26";

function file(path: string): FileFacts {
  return { path, language: "typescript", contentId: path, loc: 1, imports: [], exports: [], starExports: [], dynamicImports: [], writes: [] };
}

function graph(pairs: [string, string][] = []): Graph {
  const edges: Edge[] = pairs.map(([from, to], i) => ({ from, to, specifier: to, kind: "static", line: i + 1, analyzer: "typescript" }));
  const paths = [...new Set(pairs.flat())].sort();
  return { version: 1, files: paths.map(file), edges, workspaces: [] };
}

const components = [
  { id: "app", paths: ["src/app/**"] },
  { id: "domain", paths: ["src/domain/**"] },
  { id: "infra", paths: ["src/infra/**"] },
];

function decision(id: string, weakens: string[], status: Decision["status"] = "accepted"): Decision {
  return {
    id,
    file: `.architect/decisions/${id}-x.md`,
    title: id,
    status,
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

interface StateInput {
  rules?: unknown[];
  waivers?: unknown[];
  components?: unknown[];
  decisions?: Decision[];
  baseline?: BaselineEntry[];
  graph?: Graph;
}

function state(input: StateInput): WorkspaceState {
  return {
    label: "test",
    graph: input.graph ?? graph(),
    architecture: ArchitectureSchema.parse({ components: input.components ?? components }),
    rules: RulesFileSchema.parse({ rules: input.rules ?? [], waivers: input.waivers ?? [] }),
    decisions: input.decisions ?? [],
    baseline: { schema_version: 1, entries: input.baseline ?? [] },
  };
}

function diff(base: StateInput, head: StateInput) {
  return detectWeakenings(state(base), state({ graph: base.graph, ...head }), { today });
}

const forbid = { id: "no-infra", kind: "forbid", level: "warn", from: ["domain"], to: ["infra"] };

describe("syntactic weakening", () => {
  test("a removed rule", () => {
    expect(diff({ rules: [forbid] }, { rules: [] }).map((w) => [w.rule, w.type])).toEqual([["no-infra", "rule-removed"]]);
  });

  test("rules already off at base are ignored", () => {
    expect(diff({ rules: [{ ...forbid, level: "off" }] }, { rules: [] })).toEqual([]);
  });

  test("a lowered level", () => {
    const [w] = diff({ rules: [forbid] }, { rules: [{ ...forbid, level: "off" }] });
    expect(w?.type).toBe("level-lowered");
    expect(w?.message).toContain("from warn to off");
  });

  test("a changed kind", () => {
    const allowOnly = { id: "no-infra", kind: "allow-only", level: "warn", from: ["domain"], to: [] };
    expect(diff({ rules: [forbid] }, { rules: [allowOnly] }).map((w) => w.type)).toEqual(["rule-changed"]);
  });

  test("type imports excluded", () => {
    expect(diff({ rules: [forbid] }, { rules: [{ ...forbid, include_type_imports: false }] }).map((w) => w.type)).toEqual([
      "type-imports-excluded",
    ]);
  });

  test("a narrowed forbid names what changed", () => {
    const [w] = diff({ rules: [{ ...forbid, to: ["infra", "pkg:axios"] }] }, { rules: [forbid] });
    expect(w?.type).toBe("selector-narrowed");
    expect(w?.message).toBe('Rule no-infra allows more: removed "pkg:axios" from to.');
  });

  test("an allow-only rule that allows a new target", () => {
    const rule = { id: "web", kind: "allow-only", level: "warn", from: ["app"], to: ["domain"] };
    const [w] = diff({ rules: [rule] }, { rules: [{ ...rule, to: ["domain", "pkg:axios"] }] });
    expect(w?.message).toBe('Rule web allows more: added "pkg:axios" to to.');
  });

  test("external-imports: added allow entry and allowed builtins", () => {
    const rule = { id: "ext", kind: "external-imports", level: "warn", from: ["domain"], allow: ["zod"], allow_builtins: false };
    const [w] = diff({ rules: [rule] }, { rules: [{ ...rule, allow: ["zod", "axios"], allow_builtins: true }] });
    expect(w?.type).toBe("selector-narrowed");
    expect(w?.message).toContain('added "axios" to allow');
    expect(w?.message).toContain("allow_builtins changed from false to true");
  });

  test("acyclic limited to a subset and scope change", () => {
    const rule = { id: "dag", kind: "acyclic", level: "warn" };
    expect(diff({ rules: [rule] }, { rules: [{ ...rule, within: ["domain"] }] }).map((w) => w.type)).toEqual(["selector-narrowed"]);
    expect(diff({ rules: [rule] }, { rules: [{ ...rule, scope: "files" }] }).map((w) => w.type)).toEqual(["rule-changed"]);
  });

  test("entrypoints: any added glob loosens, dropping the override changes the rule", () => {
    const rule = { id: "ep", kind: "entrypoints", level: "warn", targets: ["domain"], entrypoints: ["src/domain/index.ts"] };
    const added = diff({ rules: [rule] }, { rules: [{ ...rule, entrypoints: ["src/domain/index.ts", "src/domain/**"] }] });
    expect(added.map((w) => w.type)).toEqual(["selector-narrowed"]);
    const { entrypoints: _, ...without } = rule;
    expect(diff({ rules: [rule] }, { rules: [without] }).map((w) => w.type)).toEqual(["rule-changed"]);
  });

  test("tightening changes are not weakenings", () => {
    const tighter = { ...forbid, level: "error", because: ["0001"], to: ["infra", "pkg:axios"] };
    expect(diff({ rules: [forbid] }, { rules: [tighter, { id: "new", kind: "acyclic", level: "warn" }] })).toEqual([]);
  });
});

describe("layers", () => {
  const rule = { id: "layers", kind: "layers", level: "warn", layers: ["app", "domain", "infra"] };

  test("reordering layers lets a lower layer depend on a higher one", () => {
    const [w] = diff({ rules: [rule] }, { rules: [{ ...rule, layers: ["app", "infra", "domain"] }] });
    expect(w?.type).toBe("selector-narrowed");
    expect(w?.message).toContain('"infra" may now depend on "domain"');
  });

  test("merging layers loosens", () => {
    const [w] = diff({ rules: [rule] }, { rules: [{ ...rule, layers: ["app", ["domain", "infra"]] }] });
    expect(w?.message).toContain('"infra" may now depend on "domain"');
  });

  test("allowing skips loosens; splitting a layer does not", () => {
    const strict = { ...rule, allow_skip: false };
    expect(diff({ rules: [strict] }, { rules: [rule] }).map((w) => w.type)).toEqual(["selector-narrowed"]);
    const merged = { ...rule, layers: ["app", ["domain", "infra"]] };
    expect(diff({ rules: [merged] }, { rules: [rule] })).toEqual([]);
  });
});

describe("waivers", () => {
  const waiver = { rule: "no-infra", from: "domain", to: "infra", reason: "migration", expires: "2026-12-01" };

  test("a new waiver and an extended expiry both count; an unchanged one does not", () => {
    expect(diff({ rules: [forbid] }, { rules: [forbid], waivers: [waiver] }).map((w) => w.type)).toEqual(["waiver-added"]);
    const extended = { ...waiver, expires: "2027-01-01" };
    const [w] = diff({ rules: [forbid], waivers: [waiver] }, { rules: [forbid], waivers: [extended] });
    expect(w?.type).toBe("waiver-added");
    expect(w?.message).toContain("extended");
    expect(diff({ rules: [forbid], waivers: [waiver] }, { rules: [forbid], waivers: [waiver] })).toEqual([]);
  });

  test("rewording the reason, citing a decision, or shortening the expiry is not a new waiver", () => {
    const edited = { ...waiver, reason: "migration to the new client", decision: "0004", expires: "2026-11-01" };
    expect(diff({ rules: [forbid], waivers: [waiver] }, { rules: [forbid], waivers: [edited] })).toEqual([]);
  });
});

describe("component changes", () => {
  const deprecatedRule = { id: "no-legacy", kind: "deprecated", level: "warn" };
  const marked = components.map((c) => (c.id === "infra" ? { ...c, deprecated: true } : c));

  test("a component that loses its deprecated mark loosens a deprecated rule that relies on the mark", () => {
    expect(diff({ rules: [deprecatedRule], components: marked }, { rules: [deprecatedRule] }).map((w) => [w.rule, w.type])).toEqual([
      ["no-legacy", "component-changed"],
    ]);
    const bySelector = { ...deprecatedRule, components: ["infra"] };
    expect(diff({ rules: [bySelector], components: marked }, { rules: [bySelector] })).toEqual([]);
  });

  test("a component that stops declaring an entrypoint loosens an api-stability rule; adding one does not", () => {
    const stable = { id: "stable", kind: "api-stability", level: "warn", components: ["domain"] };
    const g = graph([["src/domain/index.ts", "src/domain/order.ts"]]);
    const withEntry = (entrypoints: string[]) => components.map((c) => (c.id === "domain" ? { ...c, entrypoints } : c));
    const [w] = diff({ graph: g, rules: [stable], components: withEntry(["src/domain/index.ts"]) }, { rules: [stable], components: withEntry(["src/domain/order.ts"]) });
    expect([w?.rule, w?.type, w?.details]).toEqual(["stable", "component-changed", ["src/domain/index.ts"]]);
    const wider = withEntry(["src/domain/index.ts", "src/domain/order.ts"]);
    expect(diff({ graph: g, rules: [stable], components: withEntry(["src/domain/index.ts"]) }, { rules: [stable], components: wider })).toEqual([]);
  });
});

describe("baseline", () => {
  const entry: BaselineEntry = { fingerprint: "aaaa", rule: "no-infra", count: 1, file: "src/domain/a.ts", from: "domain", to: "infra" };

  test("growth is one weakening per rule, approved by a decision that weakens baseline", () => {
    const grown = [{ ...entry, count: 3 }, { ...entry, fingerprint: "bbbb", file: "src/domain/b.ts" }];
    const [w] = diff({ rules: [forbid], baseline: [entry] }, { rules: [forbid], baseline: grown });
    expect(w?.type).toBe("baseline-grown");
    expect(w?.details).toEqual(["no-infra src/domain/a.ts → infra: base 1, head 3", "no-infra src/domain/b.ts → infra: base 0, head 1"]);
    expect(w?.approved_by).toBeUndefined();

    const [approved] = diff({ rules: [forbid], baseline: [entry] }, { rules: [forbid], baseline: grown, decisions: [decision("0003", ["baseline"])] });
    expect(approved?.approved_by).toBe("0003");
  });

  test("a shrinking baseline is not a weakening", () => {
    expect(diff({ rules: [forbid], baseline: [{ ...entry, count: 2 }] }, { rules: [forbid], baseline: [entry] })).toEqual([]);
  });

  test("baselining the existing violations of a rule that base did not enforce is not a weakening", () => {
    expect(diff({}, { rules: [forbid], baseline: [entry] })).toEqual([]);
  });
});

describe("semantic weakening", () => {
  const g = graph([["src/domain/legacy/db.ts", "src/infra/db.ts"]]);

  test("moving a file out of a component loosens a rule with no rule edit", () => {
    const moved = [{ id: "legacy", paths: ["src/domain/legacy/**"] }, ...components];
    const found = diff({ graph: g, rules: [forbid] }, { rules: [forbid], components: moved });
    expect(found.map((w) => [w.rule, w.type])).toEqual([["no-infra", "semantic"]]);
    expect(found[0]?.details[1]).toStartWith("src/domain/legacy/db.ts:1 ");
  });

  test("semantic details join an existing syntactic weakening", () => {
    const found = diff({ graph: g, rules: [forbid] }, { rules: [] });
    expect(found.map((w) => w.type)).toEqual(["rule-removed"]);
    expect(found[0]?.details[0]).toContain("1 violation");
  });

  test("waivers do not hide semantic loosening", () => {
    const waivers = [{ rule: "no-infra", from: "domain", reason: "x", expires: "2026-12-01" }];
    expect(diff({ graph: g, rules: [forbid], waivers }, { rules: [forbid], waivers })).toEqual([]);
  });
});

describe("approval", () => {
  const removed = (baseDecisions: Decision[], headDecisions: Decision[]) =>
    diff({ rules: [forbid], decisions: baseDecisions }, { rules: [], decisions: headDecisions })[0]?.approved_by;

  test("a new accepted decision approves; the lowest id wins", () => {
    expect(removed([], [decision("0009", ["no-infra"]), decision("0004", ["no-infra"])])).toBe("0004");
  });

  test("proposed decisions and unchanged old decisions do not approve", () => {
    expect(removed([], [decision("0004", ["no-infra"], "proposed")])).toBeUndefined();
    expect(removed([decision("0004", ["no-infra"])], [decision("0004", ["no-infra"])])).toBeUndefined();
  });

  test("an old decision approves once its weakens list changes, matching ids after normalization", () => {
    expect(removed([decision("ADR-4", [])], [decision("0004", ["no-infra"])])).toBe("0004");
  });

  test("renumbering an old decision does not re-arm it", () => {
    const titled = (id: string) => ({ ...decision(id, ["no-infra"]), title: "Drop the infra rule" });
    expect(removed([titled("0003")], [titled("0009")])).toBeUndefined();
  });

  test("only weakens ids new to a decision approve", () => {
    expect(removed([decision("0003", ["no-infra"])], [decision("0003", ["no-infra", "other"])])).toBeUndefined();
    expect(removed([decision("0003", ["other"])], [decision("0003", ["other", "no-infra"])])).toBe("0003");
  });

  test("a decision accepted in this change approves everything it lists", () => {
    expect(removed([decision("0003", ["no-infra"], "proposed")], [decision("0003", ["no-infra"])])).toBe("0003");
  });
});
