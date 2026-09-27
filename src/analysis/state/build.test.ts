import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Architecture } from "../../model/index.ts";
import { ArchitectureSchema } from "../../model/index.ts";
import { buildGraphWith } from "../graph/build.ts";
import { WorktreeSource } from "../source/index.ts";
import { typescriptAnalyzer } from "../typescript/index.ts";

let root: string;
let cacheDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "architect-writes-"));
  cacheDir = join(root, ".cache");
  await writeFile(join(root, "a.ts"), "export async function f(db: any) {\n  await db.insert(users).values({});\n}\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const withResources = (resources: unknown[]): Architecture => ArchitectureSchema.parse({ resources });
const users = { id: "users", owner: "x", writes: [{ preset: "drizzle" }] };
const writesOf = async (architecture: Architecture, options: { only?: string[] } = {}) =>
  (await buildGraphWith([typescriptAnalyzer], new WorktreeSource(root), architecture, { cacheDir, ...options })).graph.files.flatMap((f) =>
    f.writes.map((w) => `${f.path}:${w.line}:${w.resource}`),
  );

test("changing resources invalidates cached writes", async () => {
  expect(await writesOf(withResources([]))).toEqual([]);
  expect(await writesOf(withResources([users]))).toEqual(["a.ts:2:users"]);
  expect(await writesOf(withResources([{ ...users, writes: [{ preset: "drizzle", name: "accounts" }] }]))).toEqual([]);
  // Back to the first resources: the content-addressed facts must not replay the "accounts" result.
  expect(await writesOf(withResources([users]))).toEqual(["a.ts:2:users"]);
});

test("hook mode computes writes for touched files", async () => {
  const architecture = withResources([users]);
  await writesOf(architecture);
  await writeFile(join(root, "b.ts"), "export const g = (db: any) => db.delete(users);\n");
  expect(await writesOf(architecture, { only: ["b.ts"] })).toEqual(["a.ts:2:users", "b.ts:1:users"]);
});
