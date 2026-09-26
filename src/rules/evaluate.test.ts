import { describe, expect, test } from "bun:test";
import { ArchitectureSchema, type Edge, type FileFacts, type Graph, RulesFileSchema, type WriteSite } from "../model/index.ts";
import { evaluateRules, findCycles } from "./index.ts";

function file(path: string, loc = 10, writes: WriteSite[] = []): FileFacts {
  return { path, language: "typescript", contentId: path, loc, imports: [], exports: [], starExports: [], dynamicImports: [], writes };
}

function edge(from: string, target: Partial<Edge>, line = 1, kind: Edge["kind"] = "static"): Edge {
  return { from, specifier: target.to ?? target.package ?? target.workspace ?? "x", kind, line, analyzer: "typescript", ...target };
}

function graph(edges: Edge[], files: FileFacts[] = []): Graph {
  const paths = new Set(files.map((f) => f.path));
  const all = [...files];
  for (const e of edges) {
    for (const p of [e.from, e.to]) {
      if (p !== undefined && !paths.has(p)) {
        paths.add(p);
        all.push(file(p));
      }
    }
  }
  return { version: 1, files: all.sort((a, b) => a.path.localeCompare(b.path)), edges, workspaces: [] };
}

const architecture = ArchitectureSchema.parse({
  components: [
    { id: "app", paths: ["src/app"] },
    { id: "domain", paths: ["src/domain"] },
    { id: "infra", paths: ["src/infra"] },
    { id: "billing", paths: ["src/billing"], entrypoints: ["src/billing/index.ts"] },
    { id: "shipping", paths: ["src/shipping"] },
  ],
  resources: [{ id: "orders", owner: "infra" }],
});

function run(rules: unknown[], g: Graph, extra: { waivers?: unknown[]; files?: Set<string>; today?: string } = {}) {
  const parsed = RulesFileSchema.parse({ rules, waivers: extra.waivers ?? [] });
  return evaluateRules({ graph: g, architecture, rules: parsed, today: extra.today ?? "2026-09-26", ...(extra.files ? { files: extra.files } : {}) });
}

const forbid = { id: "domain-no-infra", kind: "forbid", level: "warn", from: ["domain"], to: ["infra"] };

describe("forbid", () => {
  test("reports each offending edge and ignores allowed ones", () => {
    const g = graph([
      edge("src/domain/order.ts", { to: "src/infra/db.ts" }, 3),
      edge("src/domain/order.ts", { to: "src/infra/db.ts" }, 9),
      edge("src/app/main.ts", { to: "src/infra/db.ts" }),
      edge("src/domain/order.ts", { to: "src/domain/money.ts" }),
    ]);
    const findings = run([forbid], g);
    expect(findings.map((f) => f.location?.line)).toEqual([3, 9]);
    expect(findings[0]!.fingerprint).toBe(findings[1]!.fingerprint);
    expect(findings[0]!.message).toContain("src/domain/order.ts imports src/infra/db.ts (domain → infra)");
    expect(findings[0]!.fix_hint).toEndWith("change it with a decision that lists it in weakens.");
  });

  test("skips type imports when include_type_imports is false", () => {
    const g = graph([edge("src/domain/order.ts", { to: "src/infra/db.ts" }, 1, "type")]);
    expect(run([forbid], g)).toHaveLength(1);
    expect(run([{ ...forbid, include_type_imports: false }], g)).toHaveLength(0);
  });

  test("skips unresolved edges and rules at level off", () => {
    const g = graph([edge("src/domain/order.ts", { unresolved: true }), edge("src/domain/a.ts", { to: "src/infra/db.ts" })]);
    expect(run([forbid], g)).toHaveLength(1);
    expect(run([{ ...forbid, level: "off" }], g)).toHaveLength(0);
  });

  test("edge fingerprints ignore line numbers", () => {
    const a = run([forbid], graph([edge("src/domain/order.ts", { to: "src/infra/db.ts" }, 3)]));
    const b = run([forbid], graph([edge("src/domain/order.ts", { to: "src/infra/db.ts" }, 40)]));
    expect(a[0]!.fingerprint).toBe(b[0]!.fingerprint);
  });

  test("files mode limits edge rules to edges from those files", () => {
    const g = graph([edge("src/domain/a.ts", { to: "src/infra/db.ts" }), edge("src/domain/b.ts", { to: "src/infra/db.ts" })]);
    expect(run([forbid], g, { files: new Set(["src/domain/b.ts"]) }).map((f) => f.location?.file)).toEqual(["src/domain/b.ts"]);
  });
});

describe("allow-only", () => {
  const rule = { id: "domain-pure", kind: "allow-only", level: "warn", from: ["domain"], to: ["pkg:zod"] };
  const g = graph([
    edge("src/domain/a.ts", { to: "src/domain/b.ts" }),
    edge("src/domain/a.ts", { to: "src/infra/db.ts" }),
    edge("src/domain/a.ts", { to: "src/lib/loose.ts" }),
    edge("src/domain/a.ts", { package: "zod" }),
    edge("src/domain/a.ts", { package: "node:fs", builtin: true }),
  ]);

  test("internal scope flags other components and unmapped files, ignores packages", () => {
    expect(run([rule], g).map((f) => f.to)).toEqual(["infra", "src/lib/loose.ts"]);
  });

  test("scope all also restricts packages, built-ins included", () => {
    expect(run([{ ...rule, scope: "all" }], g).map((f) => f.to).sort()).toEqual(["infra", "node:fs", "src/lib/loose.ts"]);
  });
});

describe("layers", () => {
  const rule = { id: "layering", kind: "layers", level: "warn", layers: ["app", ["domain", "billing"], "infra"] };
  const g = graph([
    edge("src/app/main.ts", { to: "src/infra/db.ts" }),
    edge("src/infra/db.ts", { to: "src/domain/order.ts" }),
    edge("src/domain/order.ts", { to: "src/billing/index.ts" }),
    edge("src/shipping/x.ts", { to: "src/app/main.ts" }),
  ]);

  test("flags upward edges only; same layer and unknown layers pass", () => {
    expect(run([rule], g).map((f) => `${f.from}->${f.to}`)).toEqual(["infra->domain"]);
  });

  test("allow_skip false also flags skipping a layer", () => {
    expect(run([{ ...rule, allow_skip: false }], g).map((f) => `${f.from}->${f.to}`).sort()).toEqual(["app->infra", "infra->domain"]);
  });
});

describe("independent", () => {
  const rule = { id: "features-apart", kind: "independent", level: "warn", members: ["billing", "shipping"] };
  test("flags edges between different members only", () => {
    const g = graph([
      edge("src/billing/a.ts", { to: "src/shipping/b.ts" }),
      edge("src/billing/a.ts", { to: "src/billing/c.ts" }),
      edge("src/billing/a.ts", { to: "src/domain/d.ts" }),
    ]);
    expect(run([rule], g).map((f) => f.to)).toEqual(["shipping"]);
  });
});

describe("entrypoints", () => {
  const rule = { id: "billing-api", kind: "entrypoints", level: "warn", targets: ["billing"] };
  const g = graph([
    edge("src/app/main.ts", { to: "src/billing/index.ts" }),
    edge("src/app/main.ts", { to: "src/billing/internal.ts" }),
    edge("scripts/tool.ts", { to: "src/billing/internal.ts" }),
    edge("src/billing/index.ts", { to: "src/billing/internal.ts" }),
  ]);

  test("outside sources, unmapped included, must go through the entrypoint", () => {
    expect(run([rule], g).map((f) => f.location?.file)).toEqual(["scripts/tool.ts", "src/app/main.ts"]);
  });

  test("rule entrypoints override the component's own", () => {
    expect(run([{ ...rule, entrypoints: ["src/billing/internal.ts"] }], g).map((f) => f.message)).toEqual([
      expect.stringContaining("src/billing/index.ts"),
    ]);
  });

  test("targets without entrypoints are skipped", () => {
    expect(run([{ ...rule, targets: ["shipping"] }], graph([edge("src/app/a.ts", { to: "src/shipping/x.ts" })]))).toHaveLength(0);
  });
});

describe("external-imports", () => {
  const g = graph([
    edge("src/domain/a.ts", { package: "react" }),
    edge("src/domain/a.ts", { package: "@acme/util" }),
    edge("src/domain/a.ts", { package: "node:fs", builtin: true }),
    edge("src/infra/db.ts", { package: "pg" }),
    edge("src/domain/a.ts", { to: "src/infra/db.ts" }),
  ]);

  test("allow list with globs; built-ins pass unless disallowed", () => {
    const rule = { id: "domain-deps", kind: "external-imports", level: "warn", from: ["domain"], allow: ["@acme/*"] };
    expect(run([rule], g).map((f) => f.to)).toEqual(["react"]);
    expect(run([{ ...rule, allow_builtins: false }], g).map((f) => f.to).sort()).toEqual(["node:fs", "react"]);
  });

  test("forbid list", () => {
    const rule = { id: "no-react", kind: "external-imports", level: "warn", from: ["*"], forbid: ["react", "node:*"], allow_builtins: false };
    expect(run([rule], g).map((f) => f.to).sort()).toEqual(["node:fs", "react"]);
  });

  test("packages + allow_from restricts who may import", () => {
    const rule = { id: "pg-in-infra", kind: "external-imports", level: "warn", packages: ["pg", "react"], allow_from: ["infra"] };
    expect(run([rule], g).map((f) => `${f.from}:${f.to}`)).toEqual(["domain:react"]);
  });
});

describe("state-owner", () => {
  test("writes outside the owner are heuristic findings", () => {
    const g = graph([], [file("src/app/a.ts", 5, [{ line: 4, resource: "orders", text: "db.insert(orders)" }]), file("src/infra/r.ts", 5, [{ line: 2, resource: "orders", text: "x" }])]);
    const findings = run([{ id: "orders-owner", kind: "state-owner" }], g);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ level: "warn", heuristic: true, from: "app", to: "infra", location: { file: "src/app/a.ts", line: 4 } });
    expect(run([{ id: "orders-owner", kind: "state-owner", resources: ["users"] }], g)).toHaveLength(0);
  });
});

describe("acyclic", () => {
  const rule = { id: "no-cycles", kind: "acyclic", level: "warn" };
  const cycle = [
    edge("src/app/a.ts", { to: "src/domain/b.ts" }, 2),
    edge("src/domain/b.ts", { to: "src/infra/c.ts" }, 3),
    edge("src/infra/c.ts", { to: "src/app/a.ts" }, 4),
  ];

  test("one finding per cycle with a path, sample locations, and first member", () => {
    const [finding, ...rest] = run([rule], graph(cycle));
    expect(rest).toHaveLength(0);
    expect(finding!.message).toContain("app → domain → infra → app");
    expect(finding!.from).toBe("app");
    expect(finding!.to).toBeUndefined();
    expect(finding!.related).toHaveLength(3);
    expect(finding!.location).toEqual({ file: "src/app/a.ts", line: 2 });
  });

  test("fingerprint ignores discovery order and line numbers", () => {
    const moved = [...cycle].reverse().map((e) => ({ ...e, line: e.line + 10 }));
    expect(run([rule], graph(moved))[0]!.fingerprint).toBe(run([rule], graph(cycle))[0]!.fingerprint);
  });

  test("files mode does not limit cycles", () => {
    expect(run([rule], graph(cycle), { files: new Set(["src/unrelated.ts"]) })).toHaveLength(1);
  });

  test("type-only back edges break the cycle when type imports are excluded", () => {
    const g = graph([...cycle.slice(0, 2), { ...cycle[2]!, kind: "type" }]);
    expect(run([{ ...rule, include_type_imports: false }], g)).toHaveLength(0);
  });

  test("file scope and within", () => {
    const g = graph([edge("src/domain/x.ts", { to: "src/domain/y.ts" }), edge("src/domain/y.ts", { to: "src/domain/x.ts" })]);
    expect(run([rule], g)).toHaveLength(0);
    expect(run([{ ...rule, scope: "files" }], g)[0]!.message).toContain("src/domain/x.ts → src/domain/y.ts → src/domain/x.ts");
    expect(run([{ ...rule, scope: "files", within: ["path:src/app/**"] }], g)).toHaveLength(0);
    expect(run([{ ...rule, within: ["app", "domain"] }], graph(cycle))).toHaveLength(0);
  });

  test("findCycles returns sorted members of each strongly connected component", () => {
    const cycles = findCycles(["a", "b", "c", "d", "e"], [
      { from: "c", to: "a" },
      { from: "a", to: "c" },
      { from: "d", to: "e" },
      { from: "e", to: "d" },
      { from: "b", to: "b" },
    ]);
    expect(cycles).toEqual([["a", "c"], ["d", "e"]]);
  });
});

describe("waivers", () => {
  const g = graph([edge("src/domain/a.ts", { to: "src/infra/db.ts" }), edge("src/domain/a.ts", { to: "src/app/x.ts" })]);
  const rule = { id: "domain-alone", kind: "forbid", level: "warn", from: ["domain"], to: ["infra", "app"] };
  const waiver = { rule: "domain-alone", from: "domain", to: "infra", reason: "migration", expires: "2026-12-01" };
  const statuses = (w: unknown, today?: string) =>
    run([rule], g, { waivers: [w], ...(today ? { today } : {}) }).map((f) => `${f.to}:${f.status}`);

  test("match on from and to", () => {
    expect(statuses(waiver)).toEqual(["app:new", "infra:waived"]);
    const { to: _to, ...anyTarget } = waiver;
    expect(statuses(anyTarget)).toEqual(["app:waived", "infra:waived"]);
    expect(statuses({ ...waiver, from: "app" })).toEqual(["app:new", "infra:new"]);
    expect(statuses({ ...waiver, rule: "other" })).toEqual(["app:new", "infra:new"]);
  });

  test("expired waivers are ignored", () => {
    expect(statuses(waiver, "2026-12-01")).toEqual(["app:new", "infra:waived"]);
    expect(statuses(waiver, "2026-12-02")).toEqual(["app:new", "infra:new"]);
  });

  test("cycle waivers match any member", () => {
    const cycleGraph = graph([edge("src/app/a.ts", { to: "src/domain/b.ts" }), edge("src/domain/b.ts", { to: "src/app/a.ts" })]);
    const findings = run([{ id: "no-cycles", kind: "acyclic", level: "warn" }], cycleGraph, {
      waivers: [{ rule: "no-cycles", from: "domain", reason: "known", expires: "2026-12-01" }],
    });
    expect(findings.map((f) => f.status)).toEqual(["waived"]);
  });
});
