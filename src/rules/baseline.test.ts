import { describe, expect, test } from "bun:test";
import type { Baseline, Finding } from "../model/index.ts";
import { applyBaseline, updateBaseline } from "./index.ts";

function finding(fingerprint: string, file: string, line: number, extra: Partial<Finding> = {}): Finding {
  return { rule: "r", kind: "forbid", level: "error", message: `${file}:${line}`, location: { file, line }, because: [], fingerprint, status: "new", ...extra };
}

const baseline = (entries: Baseline["entries"]): Baseline => ({ schema_version: 1, entries });

describe("applyBaseline", () => {
  test("an entry with count n absorbs the first n occurrences; the next stays new", () => {
    const findings = [finding("f1", "a.ts", 9), finding("f1", "a.ts", 2), finding("f1", "a.ts", 5)];
    const result = applyBaseline(findings, baseline([{ fingerprint: "f1", rule: "r", count: 2, file: "a.ts" }]));
    expect(result.findings.map((f) => `${f.location?.line}:${f.status}`)).toEqual(["9:new", "2:baselined", "5:baselined"]);
    expect(result.fixed).toEqual([]);
  });

  test("info and waived findings are never baselined", () => {
    const findings = [finding("f1", "a.ts", 1, { level: "info" }), finding("f1", "a.ts", 2, { status: "waived" })];
    const result = applyBaseline(findings, baseline([{ fingerprint: "f1", rule: "r", count: 1, file: "a.ts" }]));
    expect(result.findings.map((f) => f.status)).toEqual(["new", "waived"]);
  });

  test("missing occurrences are fixed, scoped to the checked files", () => {
    const entries = [
      { fingerprint: "f1", rule: "r", count: 3, file: "a.ts" },
      { fingerprint: "f2", rule: "r", count: 1, file: "b.ts" },
      { fingerprint: "c1", rule: "cycles", count: 1 },
    ];
    const findings = [finding("f1", "a.ts", 1)];
    expect(applyBaseline(findings, baseline(entries)).fixed.map((e) => `${e.fingerprint}:${e.count}`)).toEqual(["c1:1", "f1:2", "f2:1"]);
    const scoped = applyBaseline(findings, baseline(entries), { files: new Set(["a.ts"]) });
    expect(scoped.fixed.map((e) => e.fingerprint)).toEqual(["c1", "f1"]);
  });
});

describe("updateBaseline", () => {
  const old = baseline([
    { fingerprint: "f1", rule: "r", count: 2, file: "a.ts" },
    { fingerprint: "f2", rule: "r", count: 1, file: "b.ts" },
  ]);
  const findings = [
    finding("f1", "a.ts", 1),
    finding("f1", "a.ts", 2, { status: "baselined" }),
    finding("f1", "a.ts", 3),
    finding("f3", "c.ts", 1),
    finding("f4", "d.ts", 1, { level: "info" }),
  ];

  test("never grows without allowGrow; fixed entries disappear", () => {
    const result = updateBaseline(old, findings, { allowGrow: false });
    expect(result.baseline.entries.map((e) => `${e.fingerprint}:${e.count}`)).toEqual(["f1:2"]);
    expect(result.removed.map((e) => `${e.fingerprint}:${e.count}`)).toEqual(["f2:1"]);
    expect(result.added).toEqual([]);
    expect(result.grown).toEqual([]);
  });

  test("allowGrow matches occurrences and adds new fingerprints", () => {
    const result = updateBaseline(old, findings, { allowGrow: true });
    expect(result.baseline.entries.map((e) => `${e.fingerprint}:${e.count}`)).toEqual(["f1:3", "f3:1"]);
    expect(result.grown.map((e) => `${e.fingerprint}:${e.count}`)).toEqual(["f1:1"]);
    expect(result.added).toMatchObject([{ fingerprint: "f3", file: "c.ts", message: "c.ts:1" }]);
  });

  test("cycle entries carry no file", () => {
    const cycle = finding("c1", "a.ts", 1, { kind: "acyclic", rule: "no-cycles" });
    const result = updateBaseline(baseline([]), [cycle], { allowGrow: true });
    expect(result.baseline.entries[0]!.file).toBeUndefined();
  });
});
