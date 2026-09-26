import { describe, expect, test } from "bun:test";
import {
  ArchitectureSchema,
  ComponentIndex,
  cycleFingerprint,
  normalizeDecisionId,
  RulesFileSchema,
  selectorMatches,
  parseSelector,
  targetEndpoint,
} from "./index.ts";

describe("component index", () => {
  const index = new ComponentIndex(
    [
      { id: "billing-api", paths: ["src/billing/api/**"], entrypoints: ["src/billing/api/index.ts"] },
      { id: "billing", paths: ["src/billing"] },
      { id: "ui", paths: ["packages/ui/**"] },
    ],
    [{ name: "@acme/ui", dir: "packages/ui" }],
  );

  test("a file belongs to the first component whose globs match", () => {
    expect(index.of("src/billing/api/routes.ts")).toBe("billing-api");
    expect(index.of("src/billing/invoice.ts")).toBe("billing");
    expect(index.of("src/other.ts")).toBeNull();
  });

  test("workspace packages map to the component owning their directory", () => {
    expect(index.ofPackage("@acme/ui")).toBe("ui");
    expect(index.packageOfFile("packages/ui/src/button.tsx")).toBe("@acme/ui");
  });

  test("entrypoints are matched per component", () => {
    expect(index.isEntrypoint("billing-api", "src/billing/api/index.ts")).toBe(true);
    expect(index.isEntrypoint("billing-api", "src/billing/api/routes.ts")).toBe(false);
    expect(index.hasEntrypoints("billing")).toBe(false);
  });

  test("unresolved workspace imports still land in the package's component", () => {
    const endpoint = targetEndpoint(
      { from: "src/app.ts", workspace: "@acme/ui", specifier: "@acme/ui", kind: "static", line: 1, analyzer: "typescript" },
      index,
    );
    expect(endpoint?.component).toBe("ui");
  });
});

describe("selectors", () => {
  test("pkg selectors match scoped package globs and never internal-only endpoints", () => {
    const sel = parseSelector("pkg:@aws-sdk/*");
    expect(selectorMatches(sel, { component: null, package: "@aws-sdk/client-s3", external: true })).toBe(true);
    expect(selectorMatches(sel, { component: null, package: "aws-sdk", external: true })).toBe(false);
    expect(selectorMatches(parseSelector("*"), { component: null, package: "react", external: true })).toBe(false);
  });
});

describe("ids and fingerprints", () => {
  test("decision references normalize to four digits", () => {
    expect(normalizeDecisionId("ADR-7")).toBe("0007");
    expect(normalizeDecisionId("0012-use-postgres")).toBe("0012");
    expect(normalizeDecisionId("no number")).toBeNull();
  });

  test("cycle fingerprints ignore where the cycle was entered", () => {
    expect(cycleFingerprint("no-cycles", ["a", "b", "c"])).toBe(cycleFingerprint("no-cycles", ["c", "a", "b"]));
  });
});

describe("schemas", () => {
  test("nested settings defaults apply when settings are omitted", () => {
    const parsed = ArchitectureSchema.parse({ components: [] });
    expect(parsed.settings.history.max_files_per_commit).toBeGreaterThan(0);
    expect(parsed.settings.exclude).toEqual([]);
  });

  test("error-level rules must cite a decision", () => {
    const missing = RulesFileSchema.safeParse({ rules: [{ id: "no-cycles", kind: "acyclic" }] });
    expect(missing.success).toBe(false);
    const warn = RulesFileSchema.safeParse({ rules: [{ id: "no-cycles", kind: "acyclic", level: "warn" }] });
    expect(warn.success).toBe(true);
  });

  test("external-imports accepts exactly one of its two forms", () => {
    const both = RulesFileSchema.safeParse({
      rules: [{ id: "x", kind: "external-imports", level: "warn", from: ["a"], allow: ["zod"], packages: ["zod"], allow_from: ["a"] }],
    });
    expect(both.success).toBe(false);
  });
});
