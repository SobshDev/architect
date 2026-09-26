import { describe, expect, test } from "bun:test";
import { ArchitectureSchema, type Decision, RulesFileSchema } from "../model/index.ts";
import { parseDecision, validateContract } from "./index.ts";

const today = "2026-09-26";
const decision = (id: string, front: string, imported = false): Decision =>
  parseDecision(`.architect/decisions/${id}-d.md`, `---\n${front}\n---\n# D\n`, { imported }).decision;

function run(arch: unknown, rules: unknown, decisions: Decision[] = [decision("0001", "status: accepted")]) {
  return validateContract({ architecture: ArchitectureSchema.parse(arch), rules: RulesFileSchema.parse(rules), decisions }, { today });
}
const paths = (r: ReturnType<typeof run>) => r.issues.map((i) => `${i.level} ${i.path ?? i.file}: ${i.message}`);
const arch = { components: [{ id: "a", paths: ["src/a"] }, { id: "b", paths: ["src/b"] }] };

describe("cross references", () => {
  test("a consistent contract has no issues", () => {
    const rules = { rules: [{ id: "f", kind: "forbid", from: ["a"], to: ["b", "path:x/**", "pkg:lodash"], because: ["ADR-1"] }] };
    expect(run(arch, rules).issues).toEqual([]);
  });

  test("duplicate ids", () => {
    const dupArch = { components: [...arch.components, { id: "a", paths: ["x"] }], resources: [{ id: "t", owner: "a" }, { id: "t", owner: "b" }] };
    const rules = { rules: [{ id: "c", kind: "acyclic", level: "warn" }, { id: "c", kind: "acyclic", level: "warn" }] };
    const result = run(dupArch, rules, [decision("0001", "status: accepted"), { ...decision("0001", "status: accepted"), file: "z.md" }]);
    expect(paths(result)).toEqual([
      'error components[2].id: duplicate component id "a"',
      'error resources[1].id: duplicate resource id "t"',
      'error rules[1].id: duplicate rule id "c"',
      'error z.md: duplicate decision id "0001"',
    ]);
  });

  test("unknown components in selectors, layers, waivers, and resource owners", () => {
    const result = run(
      { ...arch, resources: [{ id: "t", owner: "ghost" }] },
      {
        rules: [
          { id: "f", kind: "forbid", from: ["a"], to: ["nope"], because: ["0001"] },
          { id: "l", kind: "layers", layers: ["a", ["b", "zz"]], level: "warn" },
          { id: "s", kind: "state-owner", resources: ["missing"] },
        ],
        waivers: [{ rule: "gone", from: "x", reason: "r", expires: "2026-10-01" }],
      },
    );
    expect(paths(result)).toEqual([
      'error resources[0].owner: unknown component "ghost"',
      'error rules[0].to: unknown component "nope"',
      'error rules[1].layers[1]: unknown component "zz"',
      'error rules[2].resources[0]: unknown resource "missing"',
      'error waivers[0].from: unknown component "x"',
      'error waivers[0].rule: unknown rule "gone"',
    ]);
  });

  test("because must name a decision; citing a rejected one warns", () => {
    const rules = { rules: [{ id: "f", kind: "forbid", from: ["a"], to: ["b"], because: ["0009", "2", "adr"] }] };
    const result = run(arch, rules, [decision("0002", "status: rejected")]);
    expect(paths(result)).toEqual([
      'error rules[0].because[0]: unknown decision "0009"',
      'warn rules[0].because[1]: cites rejected decision "2"',
      'error rules[0].because[2]: unknown decision "adr"',
    ]);
  });

  test("decision supersedes and governs references", () => {
    const d = decision("0001", "status: accepted\nsupersedes: [ADR-7]\ngoverns: [a, ghost, 'src/**', '*', pkg.name]");
    expect(paths(run(arch, {}, [d]))).toEqual([
      'warn governs[1]: governs unknown component "ghost"',
      'warn supersedes[0]: supersedes unknown decision "ADR-7"',
    ]);
  });
});

describe("waiver expiry", () => {
  const rules = (expires: string) => ({
    rules: [{ id: "c", kind: "acyclic", level: "warn" }],
    waivers: [{ rule: "c", from: "a", reason: "migration", expires }],
  });

  test("180 days out is allowed, 181 is an error", () => {
    expect(run(arch, rules("2027-03-25")).issues).toEqual([]);
    expect(paths(run(arch, rules("2027-03-26")))).toEqual(["error waivers[0].expires: waiver expires 181 days from today; the limit is 180"]);
  });

  test("a waiver expiring today still applies; an expired one warns and is removed", () => {
    expect(run(arch, rules(today)).rules.waivers).toHaveLength(1);
    const expired = run(arch, rules("2026-09-25"));
    expect(expired.rules.waivers).toEqual([]);
    expect(expired.issues.map((i) => i.level)).toEqual(["warn"]);
  });
});
