import { describe, expect, test } from "bun:test";
import { MemorySource } from "../model/index.ts";
import { loadContract } from "./index.ts";

const today = "2026-09-26";
const ARCH = ".architect/architecture.yaml";
const RULES = ".architect/rules.yaml";

test("a missing contract loads defaults without issues", async () => {
  const contract = await loadContract(new MemorySource({ "src/a.ts": "" }), { today });
  expect(contract.issues).toEqual([]);
  expect(contract.present).toEqual({ architecture: false, rules: false, baseline: false, decisions: 0 });
  expect(contract.architecture.components).toEqual([]);
  expect(contract.baseline.entries).toEqual([]);
});

describe("schema issues", () => {
  test("zod issues carry rendered paths and valid entries survive", async () => {
    const source = new MemorySource({
      [ARCH]: "components:\n  - id: core\n    paths: [src/core]\n  - id: bad\n    paths: []\n",
      [RULES]: "rules:\n  - id: ok\n    kind: acyclic\n    level: warn\n  - id: strict\n    kind: acyclic\n",
    });
    const contract = await loadContract(source, { today });
    expect(contract.issues.map((i) => [i.file, i.path])).toEqual([
      [ARCH, "components[1].paths"],
      [RULES, "rules[1].because"],
    ]);
    expect(contract.architecture.components.map((c) => c.id)).toEqual(["core"]);
    expect(contract.rules.rules.map((r) => r.id)).toEqual(["ok"]);
  });

  test("YAML and JSON syntax errors are issues", async () => {
    const source = new MemorySource({ [ARCH]: "components:\n  - id: [a\n", ".architect/baseline.json": "{" });
    const contract = await loadContract(source, { today });
    expect(contract.issues.map((i) => i.file)).toEqual([ARCH, ".architect/baseline.json"]);
    expect(contract.issues[0]?.message).toMatch(/line \d+/);
  });
});

describe("decisions", () => {
  test("native and imported ADRs load, sorted, with conflicts and odd names handled", async () => {
    const source = new MemorySource({
      [ARCH]: "settings:\n  adr_dirs: [docs/adr]\n",
      ".architect/decisions/0002-b.md": "---\nstatus: accepted\n---\n# B\n",
      ".architect/decisions/notes.md": "# Notes\n",
      "docs/adr/README.md": "# ADRs\n",
      "docs/adr/template.md": "# Template\n",
      "docs/adr/0001-a.md": "# 1. A\n\n## Status\n\nAccepted\n",
      "docs/adr/0002-clash.md": "# 2. Clash\n",
      "docs/adr/nested/0003-deep.md": "# Deep\n",
    });
    const contract = await loadContract(source, { today });
    expect(contract.decisions.map((d) => [d.id, d.title, d.status, d.imported])).toEqual([
      ["0001", "A", "accepted", true],
      ["0002", "B", "accepted", false],
    ]);
    expect(contract.present.decisions).toBe(1);
    expect(contract.issues.map((i) => [i.level, i.file])).toEqual([
      ["warn", ".architect/decisions/notes.md"],
      ["warn", "docs/adr/0002-clash.md"],
    ]);
  });
});

test("expired waivers are dropped from the loaded rules", async () => {
  const source = new MemorySource({
    [RULES]: "rules:\n  - {id: r, kind: acyclic, level: warn}\nwaivers:\n  - {rule: r, from: '*', reason: old, expires: 2026-01-01}\n",
  });
  const contract = await loadContract(source, { today });
  expect(contract.rules.waivers).toEqual([]);
  expect(contract.issues.map((i) => [i.level, i.path])).toEqual([["warn", "waivers[0].expires"]]);
});
