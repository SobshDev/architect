import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import type { Architecture, EdgeTarget, FileFacts, LanguageAnalyzer, RawImport } from "../../model/index.ts";
import { ArchitectureSchema, MemorySource, dirOf } from "../../model/index.ts";
import { WorktreeSource } from "../source/index.ts";
import { buildGraphWith } from "./build.ts";
import type { BuildGraphOptions } from "./build.ts";

/**
 * A line-based analyzer for ".toy" files: "import <spec>", "dynamic <expr>", "broken".
 * Its resolver maps "~/x" through the "alias" folder named in tsconfig.json, so config edits change resolution.
 */
function toyAnalyzer(calls: string[], version = "1"): LanguageAnalyzer {
  return {
    id: "typescript",
    version,
    extensions: [".toy"],
    analyze(path, text, contentId): FileFacts {
      calls.push(path);
      const imports: RawImport[] = [];
      const dynamicImports: FileFacts["dynamicImports"] = [];
      let parseError: string | undefined;
      text.split("\n").forEach((line, i) => {
        const [word, arg] = line.trim().split(/\s+/);
        if (word === "import" && arg) imports.push({ specifier: arg, kind: "static", line: i + 1 });
        if (word === "dynamic" && arg) dynamicImports.push({ line: i + 1, expression: arg });
        if (word === "broken") parseError = `unexpected token on line ${i + 1}`;
      });
      const loc = text.split("\n").filter((l) => l.trim() !== "").length;
      return { path, language: "typescript", contentId, loc, imports, exports: [], starExports: [], dynamicImports, writes: [], ...(parseError && { parseError }) };
    },
    async createResolver({ source, files, workspaces }) {
      const listed = new Set(files);
      const config = await source.readFile("tsconfig.json");
      const alias: string = config ? JSON.parse(config).alias : "src";
      const local = (path: string): EdgeTarget => (listed.has(path) ? { to: path } : { unresolved: true });
      return {
        resolve(from, raw): EdgeTarget[] {
          const spec = raw.specifier;
          if (spec.startsWith(".")) return [local(`${posix.join(dirOf(from), spec)}.toy`)];
          if (spec.startsWith("~/")) return [local(`${alias}/${spec.slice(2)}.toy`)];
          if (workspaces.some((w) => w.name === spec)) return [{ workspace: spec }];
          if (spec.startsWith("node:")) return [{ package: spec, builtin: true }];
          return [{ package: spec }];
        },
      };
    },
  };
}

class RevisionSource extends MemorySource {
  readonly revision = "a".repeat(40);
}

const architecture: Architecture = ArchitectureSchema.parse({
  components: [
    { id: "app", paths: ["src/app"] },
    { id: "lib", paths: ["src/lib"] },
  ],
});

const base: Record<string, string> = {
  "tsconfig.json": JSON.stringify({ alias: "src" }),
  "src/app/main.toy": "import ../lib/util\nimport ./missing\nimport react\nimport node:fs",
  "src/app/page.toy": "import ../lib/old\nimport ~/lib/util",
  "src/lib/util.toy": "export util",
  "src/lib/old.toy": "export old",
  "scripts/tool.toy": "dynamic someVar\nbroken",
  "README.md": "# not analyzed",
};

let cacheDir: string;
let calls: string[];
beforeEach(async () => {
  cacheDir = await mkdtemp(join(tmpdir(), "architect-graph-"));
  calls = [];
});
afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

function build(files: Record<string, string>, options: Omit<BuildGraphOptions, "analyzers"> = { cacheDir }, analyzer = toyAnalyzer(calls)) {
  return buildGraphWith([analyzer], new MemorySource(files), architecture, options);
}

async function fresh(files: Record<string, string>) {
  const { graph, coverage } = await buildGraphWith([toyAnalyzer([])], new MemorySource(files), architecture);
  return { graph, coverage };
}

describe("full builds with the worktree cache", () => {
  test("a warm build equals the cold one and re-analyzes only changed files", async () => {
    const cold = await build(base);
    expect(cold.stats).toMatchObject({ cache: "cold", files: 5, parsed: 5 });
    calls.length = 0;

    const unchanged = await build(base);
    expect(unchanged.stats).toMatchObject({ cache: "warm", parsed: 0, reused: 5 });
    expect({ graph: unchanged.graph, coverage: unchanged.coverage }).toEqual({ graph: cold.graph, coverage: cold.coverage });
    expect(JSON.stringify(unchanged.graph)).toBe(JSON.stringify(cold.graph));

    const edited = { ...base, "src/lib/old.toy": "import ./util" };
    const warm = await build(edited);
    expect(calls).toEqual(["src/lib/old.toy"]);
    expect({ graph: warm.graph, coverage: warm.coverage }).toEqual(await fresh(edited));
  });

  test("adding a file resolves imports that were unresolved, deleting one unresolves its importers", async () => {
    await build(base);
    const next: Record<string, string> = { ...base, "src/app/missing.toy": "export" };
    delete next["src/lib/old.toy"];
    const warm = await build(next);
    expect({ graph: warm.graph, coverage: warm.coverage }).toEqual(await fresh(next));
    expect(warm.graph.edges).toContainEqual(expect.objectContaining({ from: "src/app/main.toy", to: "src/app/missing.toy" }));
    expect(warm.coverage.unresolved_imports).toEqual([{ file: "src/app/page.toy", line: 1, specifier: "../lib/old" }]);
  });

  test("a config change re-resolves every import while reusing facts", async () => {
    const files = { ...base, "lib/lib/util.toy": "export" };
    await build(files);
    calls.length = 0;
    const next = { ...files, "tsconfig.json": JSON.stringify({ alias: "lib" }) };
    const warm = await build(next);
    expect(calls).toEqual([]);
    expect(warm.graph.edges).toContainEqual(expect.objectContaining({ from: "src/app/page.toy", specifier: "~/lib/util", to: "lib/lib/util.toy" }));
    expect({ graph: warm.graph, coverage: warm.coverage }).toEqual(await fresh(next));
  });

  test("an analyzer version change re-analyzes every file", async () => {
    await build(base);
    calls.length = 0;
    const warm = await build(base, { cacheDir }, toyAnalyzer(calls, "2"));
    expect(warm.stats).toMatchObject({ cache: "cold", parsed: 5 });
  });

  test("a corrupt cache is ignored and rebuilt", async () => {
    const cold = await build(base);
    await writeFile(join(cacheDir, "graph", "worktree.json"), "{ not json");
    await writeFile(join(cacheDir, "graph", "facts.json"), "[]");
    const again = await build(base);
    expect(again.stats.cache).toBe("cold");
    expect(again.graph).toEqual(cold.graph);
  });
});

describe("hook mode", () => {
  test("after an add, a modify, and a delete it equals a fresh full build", async () => {
    await build(base);
    calls.length = 0;
    const next: Record<string, string> = {
      ...base,
      "src/app/missing.toy": "import ../lib/util",
      "src/lib/util.toy": "import react\ndynamic x",
    };
    delete next["src/lib/old.toy"];
    const hook = await build(next, { cacheDir, only: ["src/app/missing.toy", "src/lib/util.toy", "README.md"], deleted: ["src/lib/old.toy"] });
    expect(calls.sort()).toEqual(["src/app/missing.toy", "src/lib/util.toy"]);
    expect(hook.stats).toMatchObject({ cache: "warm", parsed: 2 });
    expect({ graph: hook.graph, coverage: hook.coverage }).toEqual(await fresh(next));

    // The hook refreshed the stamps it saw, so the next full build has nothing to analyze.
    calls.length = 0;
    const full = await build(next);
    expect(calls).toEqual([]);
    expect(full.graph).toEqual(hook.graph);
  });

  test("without a cached graph it falls back to a full build", async () => {
    const hook = await build(base, { cacheDir, only: ["src/lib/util.toy"] });
    expect(hook.stats).toMatchObject({ cache: "cold", parsed: 5 });
    expect(hook.graph).toEqual((await fresh(base)).graph);
  });

  test("an edited file importing a file the cache never listed relists the repository instead of reporting it unresolved", async () => {
    await build(base);
    // Created by a shell command or git checkout, so no hook saw it.
    const next = { ...base, "src/lib/extra.toy": "export extra", "src/app/page.toy": "import ../lib/extra" };
    const hook = await build(next, { cacheDir, only: ["src/app/page.toy"] });
    expect(hook.graph.edges).toContainEqual(expect.objectContaining({ from: "src/app/page.toy", to: "src/lib/extra.toy" }));
    expect({ graph: hook.graph, coverage: hook.coverage }).toEqual(await fresh(next));
  });

  test("a touched config file triggers a full re-resolution", async () => {
    const files = { ...base, "lib/lib/util.toy": "export" };
    await build(files);
    const next = { ...files, "tsconfig.json": JSON.stringify({ alias: "lib" }) };
    const hook = await build(next, { cacheDir, only: ["tsconfig.json"] });
    expect({ graph: hook.graph, coverage: hook.coverage }).toEqual(await fresh(next));
  });
});

describe("commit builds", () => {
  test("share facts with worktree builds and cache the finished graph by sha", async () => {
    const worktree = await build(base);
    calls.length = 0;
    const analyzer = toyAnalyzer(calls);
    const first = await buildGraphWith([analyzer], new RevisionSource(base), architecture, { cacheDir });
    expect(calls).toEqual([]);
    expect(first.stats.cache).toBe("cold");
    expect(first.graph).toEqual(worktree.graph);
    const second = await buildGraphWith([analyzer], new RevisionSource(base), architecture, { cacheDir });
    expect(second.stats).toMatchObject({ cache: "warm", parsed: 0 });
    expect(second.coverage).toEqual(first.coverage);
  });
});

test("coverage lists languages, unmapped files, unresolved and dynamic imports, and parse errors", async () => {
  const { coverage, graph } = await fresh(base);
  expect(graph.files.map((f) => f.path)).toEqual(["scripts/tool.toy", "src/app/main.toy", "src/app/page.toy", "src/lib/old.toy", "src/lib/util.toy"]);
  expect(coverage).toEqual({
    files_analyzed: 5,
    languages: { typescript: 5 },
    unmapped_files: ["scripts/tool.toy"],
    unresolved_imports: [{ file: "src/app/main.toy", line: 2, specifier: "./missing" }],
    dynamic_imports: [{ file: "scripts/tool.toy", line: 1, expression: "someVar" }],
    parse_errors: [{ file: "scripts/tool.toy", message: "unexpected token on line 2" }],
  });
  expect(graph.edges.filter((e) => e.from === "src/app/main.toy")).toEqual([
    { from: "src/app/main.toy", to: "src/lib/util.toy", specifier: "../lib/util", kind: "static", line: 1, analyzer: "typescript" },
    { from: "src/app/main.toy", specifier: "./missing", kind: "static", line: 2, analyzer: "typescript", unresolved: true },
    { from: "src/app/main.toy", package: "react", specifier: "react", kind: "static", line: 3, analyzer: "typescript" },
    { from: "src/app/main.toy", package: "node:fs", builtin: true, specifier: "node:fs", kind: "static", line: 4, analyzer: "typescript" },
  ]);
});

test("an import of a workspace package without a matching file keeps its edge and counts as unresolved", async () => {
  const { coverage, graph } = await fresh({
    ...base,
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/nodep/package.json": JSON.stringify({ name: "nodep" }),
    "src/app/ws.toy": "import nodep",
  });
  expect(graph.edges.find((e) => e.from === "src/app/ws.toy")).toMatchObject({ workspace: "nodep" });
  expect(coverage.unresolved_imports).toContainEqual({ file: "src/app/ws.toy", line: 1, specifier: "nodep" });
});

test("an unreadable file is reported as a parse error and retried once readable", async () => {
  const root = await mkdtemp(join(tmpdir(), "architect-unreadable-"));
  try {
    for (const [path, text] of Object.entries(base)) {
      await mkdir(join(root, dirOf(path)), { recursive: true });
      await writeFile(join(root, path), text);
    }
    const locked = join(root, "src/lib/old.toy");
    await chmod(locked, 0o000);
    const options = { cacheDir: join(root, ".cache") };
    const first = await buildGraphWith([toyAnalyzer([])], new WorktreeSource(root), architecture, options);
    expect(first.coverage.parse_errors).toContainEqual({ file: "src/lib/old.toy", message: "unreadable: EACCES" });
    expect(first.graph.edges.some((e) => e.from === "src/app/main.toy" && e.to === "src/lib/util.toy")).toBe(true);

    await chmod(locked, 0o644);
    const second = await buildGraphWith([toyAnalyzer([])], new WorktreeSource(root), architecture, options);
    expect(second.coverage.parse_errors.map((e) => e.file)).toEqual(["scripts/tool.toy"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
