import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySource } from "../model/index.ts";
import { loadContract, serializeArchitecture, serializeBaseline, serializeRules, writeRepoFile } from "./index.ts";

test("serializeBaseline is stable under input reordering and puts file-less entries last", () => {
  const entries = [
    { fingerprint: "f3", rule: "b", count: 1 },
    { fingerprint: "f2", rule: "a", count: 1, message: "cycle" },
    { message: "m", to: "y", from: "x", file: "src/z.ts", count: 2, rule: "a", fingerprint: "f9" },
    { fingerprint: "f1", rule: "a", count: 1, file: "src/a.ts" },
  ];
  const text = serializeBaseline({ schema_version: 1, entries });
  expect(serializeBaseline({ schema_version: 1, entries: [...entries].reverse() })).toBe(text);
  const parsed = JSON.parse(text);
  expect(Object.keys(parsed)).toEqual(["schema_version", "entries"]);
  expect(parsed.entries.map((e: { fingerprint: string }) => e.fingerprint)).toEqual(["f1", "f9", "f2", "f3"]);
  expect(Object.keys(parsed.entries[1])).toEqual(["fingerprint", "rule", "count", "file", "from", "to", "message"]);
  expect(text.endsWith("}\n")).toBe(true);
});

describe("contract YAML", () => {
  test("serialized files load back without issues and keep defaults implicit", async () => {
    const architecture = serializeArchitecture({ components: [{ id: "core", paths: ["src/core"], entrypoints: [] }], resources: [] });
    const rules = serializeRules({ rules: [{ id: "no-cycles", kind: "acyclic", level: "warn", description: "x: \"y\"" }] });
    expect(architecture.startsWith("# ")).toBe(true);
    expect(architecture).not.toContain("entrypoints");
    expect(architecture).not.toContain("version");
    const contract = await loadContract(
      new MemorySource({ ".architect/architecture.yaml": architecture, ".architect/rules.yaml": rules }),
      { today: "2026-09-26" },
    );
    expect(contract.issues).toEqual([]);
    expect(contract.rules.rules[0]).toMatchObject({ id: "no-cycles", description: 'x: "y"' });
  });

  test("invalid input throws", () => {
    expect(() => serializeRules({ rules: [{ id: "bad", kind: "acyclic" }] })).toThrow();
  });
});

describe("writeRepoFile", () => {
  test("creates parent directories and writes exactly", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "architect-store-")));
    await writeRepoFile(root, ".architect/decisions/0001-a.md", "x\n");
    expect(await readFile(join(root, ".architect/decisions/0001-a.md"), "utf8")).toBe("x\n");
  });

  test.each(["../outside.txt", "a/../../outside.txt", "/etc/passwd", "C:\\x.txt", "", "."])("refuses %p", async (path) => {
    const root = await mkdtemp(join(tmpdir(), "architect-store-"));
    await expect(writeRepoFile(root, path, "x")).rejects.toThrow();
  });
});
