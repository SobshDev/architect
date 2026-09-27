import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Architecture, Graph, HistorySettings } from "../../model/index.ts";
import { ArchitectureSchema } from "../../model/index.ts";
import type { CommitRecord } from "./index.ts";
import { readCommits, readHistory, summarizeHistory } from "./index.ts";
import { parseNumstatPath } from "./log.ts";

const settings = (over: Partial<HistorySettings> = {}): HistorySettings => ({
  months: 12,
  max_files_per_commit: 50,
  min_support: 2,
  min_confidence: 0.5,
  ...over,
});

function arch(components: { id: string; paths: string[] }[] = []): Architecture {
  return ArchitectureSchema.parse({ components });
}

describe("readCommits on a git repository", () => {
  let repo: string;

  function git(date: string, ...args: string[]): void {
    const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    const result = Bun.spawnSync(
      ["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args],
      { cwd: repo, env, stdout: "pipe", stderr: "pipe" },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }

  async function write(path: string, text: string): Promise<void> {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), text);
  }

  async function commit(date: string, files: Record<string, string>, message: string): Promise<void> {
    for (const [path, text] of Object.entries(files)) await write(path, text);
    git(date, "add", "-A");
    git(date, "commit", "-q", "-m", message);
  }

  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join("\n") + "\n";

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), "architect-history-"));
    git("2024-01-01T00:00:00Z", "init", "-q");
    // Outside the 12-month window anchored to the last commit (2025-06-01).
    await commit("2024-01-01T00:00:00Z", { "old.ts": "x\n" }, "ancient");
    await commit("2025-01-01T00:00:00Z", { "src/a.ts": lines(10, "a"), "b.ts": lines(3, "b") }, "one");
    await commit("2025-02-01T00:00:00Z", { "src/a.ts": lines(12, "a"), "b.ts": lines(4, "b"), "logo.bin": "\u0000\u0001binary" }, "two");
    await mkdir(join(repo, "src/core"));
    git("2025-03-01T00:00:00Z", "mv", "src/a.ts", "src/core/a.ts");
    git("2025-03-01T00:00:00Z", "commit", "-q", "-m", "move into core");
    await commit("2025-04-01T00:00:00Z", { "src/core/a.ts": lines(13, "a"), "b.ts": lines(5, "b") }, "three");
    // Four files with max_files_per_commit 3: skipped, yet its rename of b.ts must still be followed.
    await rm(join(repo, "b.ts"));
    await commit("2025-05-01T00:00:00Z", { "lib/b.ts": lines(5, "b"), "c.ts": "c\n", "d.ts": "d\n", "e.ts": "e\n" }, "bulk");
    await commit("2025-06-01T00:00:00Z", { "lib/b.ts": lines(6, "b"), "src/core/a.ts": lines(14, "a") }, "four");
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test("follows renames to the newest path, skips large commits, and stays inside the window", async () => {
    const commits = await readCommits(repo, settings({ max_files_per_commit: 3 }));
    expect(commits.map((c) => c.files.map((f) => f.path))).toEqual([
      ["lib/b.ts", "src/core/a.ts"],
      ["lib/b.ts", "src/core/a.ts"],
      ["src/core/a.ts"],
      ["lib/b.ts", "logo.bin", "src/core/a.ts"],
      ["lib/b.ts", "src/core/a.ts"],
    ]);
    const binary = commits[3]?.files.find((f) => f.path === "logo.bin");
    expect(binary).toEqual({ path: "logo.bin", added: 0, deleted: 0 });
  });

  test("the summary counts renamed files as one file", async () => {
    const graph: Graph = {
      version: 1,
      files: [
        { path: "lib/b.ts", loc: 6 },
        { path: "src/core/a.ts", loc: 14 },
      ].map((f) => ({ ...f, language: "typescript", contentId: f.path, imports: [], exports: [], starExports: [], dynamicImports: [], writes: [] })),
      edges: [],
      workspaces: [],
    };
    const architecture = ArchitectureSchema.parse({ settings: { history: { max_files_per_commit: 3, min_support: 2 } } });
    const cacheDir = join(repo, ".cache");
    const summary = await readHistory(repo, graph, architecture, { cacheDir });
    // lib/b.ts changed in 4 counted commits, all with a.ts (which changed in 5).
    expect(summary?.filePairs).toEqual([{ a: "lib/b.ts", b: "src/core/a.ts", support: 4, confidence: 1 }]);
    expect(await readHistory(repo, graph, architecture, { cacheDir })).toEqual(summary);
  });

  test("outside git there is no history", async () => {
    const plain = await mkdtemp(join(tmpdir(), "architect-nogit-"));
    try {
      expect(await readCommits(plain, settings())).toEqual([]);
      expect(await readHistory(plain, { version: 1, files: [], edges: [], workspaces: [] }, arch())).toBeNull();
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});

describe("parseNumstatPath", () => {
  test("brace renames with an empty side collapse the doubled slash", () => {
    expect(parseNumstatPath("src/{ => sub}/f.ts")).toEqual({ path: "src/sub/f.ts", old: "src/f.ts" });
    expect(parseNumstatPath("{old => new}/f.ts")).toEqual({ path: "new/f.ts", old: "old/f.ts" });
    expect(parseNumstatPath("a.ts => b/c.ts")).toEqual({ path: "b/c.ts", old: "a.ts" });
  });
});

describe("summarizeHistory", () => {
  const commit = (...paths: string[]): CommitRecord => ({ sha: paths.join(","), files: paths.map((path) => ({ path, added: 1, deleted: 0 })) });
  const files = ["a/1.ts", "a/2.ts", "b/1.ts", "c/1.ts"].map((path) => ({ path, loc: 10 }));
  const input = (architecture = arch(), over: Partial<HistorySettings> = {}) => ({
    head: "h",
    since: "s",
    files,
    architecture,
    settings: settings({ min_support: 3, ...over }),
  });

  test("keeps pairs at the support and confidence thresholds, using the less frequently changed side", () => {
    const commits = [
      ...Array.from({ length: 3 }, () => commit("a/1.ts", "b/1.ts")),
      ...Array.from({ length: 3 }, () => commit("a/1.ts")),
      ...Array.from({ length: 2 }, () => commit("a/2.ts", "c/1.ts")),
    ];
    const summary = summarizeHistory(commits, input());
    // a/1.ts changed 6 times, b/1.ts 3 times: confidence is 3 / 3, not 3 / 6.
    expect(summary.filePairs).toEqual([{ a: "a/1.ts", b: "b/1.ts", support: 3, confidence: 1 }]);
    expect(summarizeHistory(commits, input(arch(), { min_confidence: 1 })).filePairs).toHaveLength(1);
    expect(summarizeHistory(commits.slice(1), input()).filePairs).toEqual([]);
  });

  test("confidence below the threshold drops the pair", () => {
    const commits = [...Array.from({ length: 3 }, () => commit("a/1.ts", "b/1.ts")), ...Array.from({ length: 4 }, () => commit("a/1.ts")), ...Array.from({ length: 4 }, () => commit("b/1.ts"))];
    expect(summarizeHistory(commits, input(arch(), { min_confidence: 0.5 })).filePairs).toEqual([]);
    expect(summarizeHistory(commits, input(arch(), { min_confidence: 0.4 })).filePairs).toHaveLength(1);
  });

  test("a commit counts once per component pair however many files it touches", () => {
    const architecture = arch([
      { id: "a", paths: ["a"] },
      { id: "b", paths: ["b"] },
    ]);
    const commits = Array.from({ length: 3 }, () => commit("a/1.ts", "a/2.ts", "b/1.ts"));
    expect(summarizeHistory(commits, input(architecture)).componentPairs).toEqual([{ a: "a", b: "b", support: 3, confidence: 1 }]);
  });

  test("ignores files outside the graph and ranks hotspots by churn times size", () => {
    const commits: CommitRecord[] = [
      { sha: "1", files: [{ path: "gone.ts", added: 500, deleted: 0 }, { path: "a/1.ts", added: 3, deleted: 2 }] },
      { sha: "2", files: [{ path: "b/1.ts", added: 5, deleted: 0 }, { path: "c/1.ts", added: 0, deleted: 9 }] },
    ];
    const summary = summarizeHistory(commits, input());
    expect(summary.hotspots.map((h) => [h.path, h.score])).toEqual([
      ["c/1.ts", 90],
      ["a/1.ts", 50],
      ["b/1.ts", 50],
    ]);
  });
});
