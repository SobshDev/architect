import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { contentId } from "../../model/index.ts";
import { changedFiles, findRepoRoot, headSha, mergeBase, openGitSource, resolveRef, WorktreeSource } from "./index.ts";

const temps: string[] = [];
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "architect-source-")));
  temps.push(dir);
  return dir;
}

function run(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, LC_ALL: "C" } });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

function write(root: string, path: string, content: string | Uint8Array): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function repo(files: Record<string, string> = {}): string {
  const root = tempDir();
  run(root, "init", "-q", "-b", "main");
  run(root, "config", "user.name", "Test");
  run(root, "config", "user.email", "test@example.com");
  run(root, "config", "commit.gpgsign", "false");
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  if (Object.keys(files).length > 0) {
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "init");
  }
  return root;
}

describe("git helpers", () => {
  test("resolve refs, HEAD, merge base, and repo root", async () => {
    const root = repo({ "a.txt": "a\n" });
    const first = run(root, "rev-parse", "HEAD");
    run(root, "checkout", "-q", "-b", "side");
    write(root, "b.txt", "b\n");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "side");
    mkdirSync(join(root, "sub"));

    expect(await headSha(root)).toBe(run(root, "rev-parse", "HEAD"));
    expect(await resolveRef(root, "main")).toBe(first);
    expect(await resolveRef(root, "no-such-branch")).toBeNull();
    expect(await resolveRef(root, "HEAD:a.txt")).toBeNull(); // a blob is not a commit
    expect(await mergeBase(root, "main", "side")).toBe(first);
    expect(await findRepoRoot(join(root, "sub"))).toBe(root);
    expect(await findRepoRoot(tempDir())).toBeNull();
    expect(await headSha(repo())).toBeNull();
  });
});

describe("GitSource", () => {
  test("reads committed text while the worktree has edits", async () => {
    const root = repo({ "src/a.ts": "export const a = 1;\n", "b.md": "committed\n" });
    write(root, "src/a.ts", "export const a = 2;\n");
    write(root, "new.ts", "untracked\n");
    const source = await openGitSource(root, "HEAD");
    try {
      expect(source.revision).toBe(run(root, "rev-parse", "HEAD"));
      expect(source.label).toBe(`HEAD@${source.revision.slice(0, 7)}`);
      expect(await source.listFiles()).toEqual(["b.md", "src/a.ts"]);
      expect(await source.readFile("src/a.ts")).toBe("export const a = 1;\n");
      expect(await source.readFile("new.ts")).toBeNull();
      expect(await source.stamp("new.ts")).toBeNull();
      const stamp = await source.stamp("src/a.ts");
      expect(stamp).toBe(run(root, "rev-parse", "HEAD:src/a.ts"));
      expect(stamp).toBe(contentId("export const a = 1;\n"));
    } finally {
      source.close();
    }
  });

  test("stamp equals git hash-object of the same content", async () => {
    const root = repo({ "x.txt": "\uFEFFbom and ünïcödé\r\n" });
    const source = await openGitSource(root, "HEAD");
    try {
      expect(await source.stamp("x.txt")).toBe(run(root, "hash-object", "x.txt"));
      expect(contentId((await source.readFile("x.txt")) ?? "")).toBe(run(root, "hash-object", "x.txt"));
    } finally {
      source.close();
    }
  });

  test("parallel reads return the right content, including large and header-like files", async () => {
    const big = "0123456789abcdef".repeat(10_000); // 160 KB, spans many pipe chunks
    const fake = "0000000000000000000000000000000000000000 blob 5\nhello\n";
    const files: Record<string, string> = { "big.txt": big, "fake.txt": fake, "dup1.txt": "same\n", "dup2.txt": "same\n" };
    for (let i = 0; i < 300; i++) files[`many/f${i}.txt`] = `file ${i}\n`;
    const root = repo(files);
    write(root, "bin.dat", new Uint8Array([1, 2, 0, 3]));
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "binary");
    const source = await openGitSource(root, "HEAD");
    try {
      const paths = Object.keys(files);
      const singles = await Promise.all(paths.map((path) => source.readFile(path)));
      paths.forEach((path, i) => expect(singles[i]).toBe(files[path] as string));
      const [batch, again] = await Promise.all([source.readFiles([...paths, "bin.dat", "missing"]), source.readFile("big.txt")]);
      expect(again).toBe(big);
      expect(batch.size).toBe(paths.length);
      for (const path of paths) expect(batch.get(path)).toBe(files[path] as string);
      expect(await source.readFile("bin.dat")).toBeNull();
    } finally {
      source.close();
    }
  });

  test("lists regular files only, skipping symlinks", async () => {
    const root = repo({ "real.txt": "real\n", "tool.sh": "#!/bin/sh\n" });
    symlinkSync("real.txt", join(root, "link.txt"));
    Bun.spawnSync(["chmod", "+x", join(root, "tool.sh")]);
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "link");
    const source = await openGitSource(root, "HEAD");
    try {
      expect(await source.listFiles()).toEqual(["real.txt", "tool.sh"]);
      expect(await source.readFile("link.txt")).toBeNull();
    } finally {
      source.close();
    }
  });

  test("rejects refs that do not name a commit, and reads fail after close", async () => {
    const root = repo({ "a.txt": "a\n" });
    await expect(openGitSource(root, "nope")).rejects.toThrow('"nope" does not resolve to a commit');
    const source = await openGitSource(root, "HEAD");
    source.close();
    await expect(source.readFile("a.txt")).rejects.toThrow("closed");
  });

  test("an unclosed source does not keep the process alive", async () => {
    const root = repo({ "a.txt": "a\n" });
    const script = `import { openGitSource } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};
const s = await openGitSource(${JSON.stringify(root)}, "HEAD");
console.log(await s.readFile("a.txt"));`;
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 5000);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    expect(out).toBe("a\n\n");
    expect(code).toBe(0);
  });
});

describe("changedFiles", () => {
  test("covers staged, unstaged, untracked, ignored, deleted, and renamed files", async () => {
    const root = repo({
      ".gitignore": "*.log\n",
      "staged.ts": "1\n",
      "unstaged.ts": "1\n",
      "deleted.ts": "1\n",
      "old-name.ts": "rename me\n",
      "same.ts": "1\n",
    });
    write(root, "staged.ts", "2\n");
    run(root, "add", "staged.ts");
    write(root, "unstaged.ts", "2\n");
    write(root, "dir/untracked.ts", "new\n");
    write(root, "debug.log", "ignored\n");
    unlinkSync(join(root, "deleted.ts"));
    run(root, "mv", "old-name.ts", "new-name.ts");
    write(root, "added.ts", "added\n");
    run(root, "add", "added.ts");

    expect(await changedFiles(root)).toEqual({
      changed: ["added.ts", "dir/untracked.ts", "new-name.ts", "staged.ts", "unstaged.ts"],
      deleted: ["deleted.ts", "old-name.ts"],
    });
  });

  test("compares against an older commit", async () => {
    const root = repo({ "a.ts": "1\n" });
    const first = run(root, "rev-parse", "HEAD");
    write(root, "b.ts", "1\n");
    run(root, "add", "-A");
    run(root, "commit", "-q", "-m", "b");
    expect(await changedFiles(root, first)).toEqual({ changed: ["b.ts"], deleted: [] });
    expect(await changedFiles(root)).toEqual({ changed: [], deleted: [] });
    await expect(changedFiles(root, "nope")).rejects.toThrow("does not resolve");
  });

  test("in a repo without commits every listed file is changed", async () => {
    const root = repo();
    write(root, ".gitignore", "out/\n");
    write(root, "staged.ts", "1\n");
    run(root, "add", "staged.ts");
    write(root, "loose.ts", "1\n");
    write(root, "out/build.js", "1\n");
    expect(await changedFiles(root)).toEqual({ changed: [".gitignore", "loose.ts", "staged.ts"], deleted: [] });
  });
});

describe("WorktreeSource", () => {
  test("lists untracked but not ignored files and drops deleted tracked files", async () => {
    const root = repo({ ".gitignore": "dist/\nnode_modules/\n", "kept.ts": "1\n", "gone.ts": "1\n" });
    unlinkSync(join(root, "gone.ts"));
    write(root, "fresh.ts", "new\n");
    write(root, "dist/out.js", "ignored\n");
    write(root, "node_modules/pkg/tsconfig.json", "{}\n");
    symlinkSync("kept.ts", join(root, "alias.ts"));
    const source = new WorktreeSource(root);
    expect(source.label).toBe("worktree");
    expect(source.revision).toBeUndefined();
    expect(await source.listFiles()).toEqual([".gitignore", "fresh.ts", "kept.ts"]);
    // Unlisted files stay readable; resolvers need them.
    expect(await source.readFile("node_modules/pkg/tsconfig.json")).toBe("{}\n");
  });

  test("reads text, rejects escaping paths, and returns null for missing, directory, or binary", async () => {
    const root = tempDir();
    write(root, "a.txt", "hello\n");
    write(root, "d/b.bin", new Uint8Array([65, 0, 66]));
    const source = new WorktreeSource(root);
    expect(await source.readFile("a.txt")).toBe("hello\n");
    expect(await source.readFile("missing.txt")).toBeNull();
    expect(await source.readFile("d")).toBeNull();
    expect(await source.readFile("d/b.bin")).toBeNull();
    await expect(source.readFile("../outside")).rejects.toThrow("escapes");
    const files = await source.readFiles(["a.txt", "missing.txt", "d/b.bin"]);
    expect([...files.keys()]).toEqual(["a.txt"]);
    expect(await source.stamp("missing.txt")).toBeNull();
    const before = await source.stamp("a.txt");
    write(root, "a.txt", "changed content\n");
    expect(await source.stamp("a.txt")).not.toBe(before);
  });

  test("walks the tree outside git, skipping .git, node_modules, and symlinked directories", async () => {
    const root = tempDir();
    write(root, "src/a.ts", "1\n");
    write(root, "b.ts", "1\n");
    write(root, "node_modules/x/index.js", "1\n");
    write(root, ".git-like/.git/config", "1\n");
    mkdirSync(join(root, "real"));
    write(root, "real/c.ts", "1\n");
    symlinkSync("real", join(root, "linked"));
    expect(await new WorktreeSource(root).listFiles()).toEqual(["b.ts", "real/c.ts", "src/a.ts"]);
  });
});

test("without git on PATH the helpers report no repository and the worktree falls back to a file walk", async () => {
  const root = repo({ "a.ts": "a\n", "sub/b.ts": "b\n" });
  const script = [
    `import { findRepoRoot, headSha, mergeBase, resolveRef, WorktreeSource } from ${JSON.stringify(join(import.meta.dir, "index.ts"))};`,
    "const root = process.argv[1];",
    "const out = [await findRepoRoot(root), await resolveRef(root, 'HEAD'), await headSha(root), await mergeBase(root, 'HEAD', 'HEAD'), await new WorktreeSource(root).listFiles()];",
    "console.log(JSON.stringify(out));",
  ].join("\n");
  const result = Bun.spawnSync([process.execPath, "-e", script, root], { env: { ...process.env, PATH: "/nonexistent" } });
  expect(result.stderr.toString()).toBe("");
  expect(JSON.parse(result.stdout.toString())).toEqual([null, null, null, null, ["a.ts", "sub/b.ts"]]);
});
