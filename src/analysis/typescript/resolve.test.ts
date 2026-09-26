import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { EdgeTarget, FileSource, WorkspacePackage } from "../../model/index.ts";
import { MemorySource, SettingsSchema } from "../../model/index.ts";
import { typescriptAnalyzer } from "./index.ts";

const FIXTURES = join(import.meta.dir, "../../../test/fixtures/ts-resolve");
const CASES = ["paths", "extends", "references", "workspaces", "relative", "nodenext", "catchall", "assets", "wsassets"];
const WORKSPACES: Record<string, WorkspacePackage[]> = {
  workspaces: [
    { name: "@acme/ui", dir: "packages/ui" },
    { name: "legacy", dir: "packages/legacy" },
    { name: "@acme/nomap", dir: "packages/nomap" },
    { name: "web", dir: "apps/web" },
  ],
  wsassets: [{ name: "@acme/ui", dir: "packages/ui" }],
};

async function loadFixture(name: string, label?: string): Promise<MemorySource> {
  const dir = join(FIXTURES, name);
  const files: Record<string, string> = {};
  for await (const path of new Bun.Glob("**/*").scan({ cwd: dir, dot: true })) files[path] = await Bun.file(join(dir, path)).text();
  return new MemorySource(files, { root: "/work/" + name, label });
}

/** Analyzes every source file and resolves every import. Keys are "file kind specifier". */
async function resolveAll(source: FileSource, tsconfig?: string): Promise<Record<string, EdgeTarget>> {
  const files = await source.listFiles();
  const workspaces = WORKSPACES[source.root.slice(source.root.lastIndexOf("/") + 1)] ?? [];
  const resolver = await typescriptAnalyzer.createResolver({ source, files, workspaces, settings: SettingsSchema.parse({ tsconfig }) });
  const out: Record<string, EdgeTarget> = {};
  for (const path of files) {
    if (!typescriptAnalyzer.extensions.some((e) => path.endsWith(e))) continue;
    const facts = typescriptAnalyzer.analyze(path, (await source.readFile(path)) ?? "", "x");
    for (const raw of facts.imports) {
      const targets = resolver.resolve(path, raw);
      expect(targets).toHaveLength(1);
      out[path + " " + raw.kind + " " + raw.specifier] = targets[0] as EdgeTarget;
    }
  }
  return out;
}

describe("typescript resolver", () => {
  test("paths aliases and baseUrl resolve to repo files; unmatched aliases are unresolved", async () => {
    const r = await resolveAll(await loadFixture("paths"));
    expect(r["src/a.ts static @/b"]).toEqual({ to: "src/b.ts" });
    expect(r["src/a.ts static ~lib"]).toEqual({ to: "lib/index.ts" });
    expect(r["src/a.ts static src/utils/c"]).toEqual({ to: "src/utils/c.ts" });
    expect(r["src/a.ts static @/missing"]).toEqual({ unresolved: true });
    expect(r["src/a.ts static react"]).toEqual({ package: "react" });
    expect(r["src/a.ts static @scope/pkg/deep/path"]).toEqual({ package: "@scope/pkg" });
  });

  test("a catch-all paths pattern that finds no file falls back to the external package", async () => {
    const r = await resolveAll(await loadFixture("catchall"));
    const m = "src/main.ts static ";
    expect(r[m + "react"]).toEqual({ package: "react" });
    expect(r[m + "zod/v4"]).toEqual({ package: "zod" });
    expect(r[m + "@scope/name/sub"]).toEqual({ package: "@scope/name" });
    expect(r[m + "mytype"]).toEqual({ to: "types/mytype.ts" });
    expect(r[m + "helper"]).toEqual({ to: "src/helper.ts" });
    expect(r[m + "@web/helper"]).toEqual({ to: "src/helper.ts" });
    // The more specific named alias wins over "*", and its miss stays unresolved.
    expect(r[m + "@web/missing"]).toEqual({ unresolved: true });
  });

  test("aliased assets and bundler query suffixes resolve to the listed file", async () => {
    const r = await resolveAll(await loadFixture("assets"));
    const m = "src/main.ts ";
    expect(r[m + "side-effect @/index.css"]).toEqual({ to: "src/index.css" });
    expect(r[m + "static @/assets/logo.png"]).toEqual({ to: "src/assets/logo.png" });
    expect(r[m + "static ./worker.ts?worker&url"]).toEqual({ to: "src/worker.ts" });
    expect(r[m + "static ./a.svg?raw"]).toEqual({ to: "src/a.svg" });
    expect(r[m + "static @/a.svg?raw#frag"]).toEqual({ to: "src/a.svg" });
    expect(r[m + "side-effect @/nope.css"]).toEqual({ unresolved: true });
  });

  test("extends chains across files and skips a missing package link", async () => {
    const r = await resolveAll(await loadFixture("extends"));
    expect(r["app/main.ts static $shared/x"]).toEqual({ to: "shared/x.ts" });
  });

  test("a solution-style root hands each file to the referenced project that contains it", async () => {
    const r = await resolveAll(await loadFixture("references"));
    expect(r["packages/app/src/main.ts static @core/util"]).toEqual({ to: "packages/core/src/util.ts" });
    // core's own project has no alias, so the same specifier is an external package there.
    expect(r["packages/core/src/other.ts static @core/util"]).toEqual({ package: "@core/util" });
  });

  test("settings.tsconfig restricts which configs apply", async () => {
    const r = await resolveAll(await loadFixture("paths"), "other/tsconfig.json");
    expect(r["src/a.ts static @/b"]).toEqual({ package: "@/b" });
  });

  test("workspace packages map exports and main back from build output to source", async () => {
    const r = await resolveAll(await loadFixture("workspaces"));
    const page = "apps/web/src/page.ts static ";
    expect(r[page + "@acme/ui"]).toEqual({ to: "packages/ui/src/index.ts", workspace: "@acme/ui" });
    expect(r[page + "@acme/ui/components/button"]).toEqual({ to: "packages/ui/src/components/button.tsx", workspace: "@acme/ui" });
    expect(r[page + "legacy"]).toEqual({ to: "packages/legacy/src/main.js", workspace: "legacy" });
    expect(r[page + "@acme/nomap"]).toEqual({ workspace: "@acme/nomap" });
    expect(r[page + "react"]).toEqual({ package: "react" });
  });

  test("workspace exports can name asset files; a missing subpath keeps only the workspace", async () => {
    const r = await resolveAll(await loadFixture("wsassets"));
    const m = "app/main.ts ";
    expect(r[m + "side-effect @acme/ui/theme.css"]).toEqual({ to: "packages/ui/src/theme.css", workspace: "@acme/ui" });
    expect(r[m + "static @acme/ui/button"]).toEqual({ to: "packages/ui/src/button.tsx", workspace: "@acme/ui" });
    expect(r[m + "static @acme/ui/missing"]).toEqual({ workspace: "@acme/ui" });
  });

  test("built-ins", async () => {
    const r = await resolveAll(await loadFixture("workspaces"));
    const page = "apps/web/src/page.ts static ";
    expect(r[page + "node:fs/promises"]).toEqual({ package: "node:fs", builtin: true });
    expect(r[page + "path"]).toEqual({ package: "node:path", builtin: true });
    expect(r[page + "bun:test"]).toEqual({ package: "bun:test", builtin: true });
    expect(r[page + "bun"]).toEqual({ package: "bun", builtin: true });
  });

  test("relative imports: .js to .ts, index files, json, declarations, dynamic, require", async () => {
    const r = await resolveAll(await loadFixture("relative"));
    const m = "src/main.ts ";
    expect(r[m + "static ./util.js"]).toEqual({ to: "src/util.ts" });
    expect(r[m + "static ./lib"]).toEqual({ to: "src/lib/index.ts" });
    expect(r[m + "static ./lib/index.js"]).toEqual({ to: "src/lib/index.ts" });
    expect(r[m + "static ./data.json"]).toEqual({ to: "src/data.json" });
    expect(r[m + "type ./types"]).toEqual({ to: "src/types.d.ts" });
    expect(r[m + "side-effect ./style.css"]).toEqual({ to: "src/style.css" });
    expect(r[m + "dynamic ./util.js"]).toEqual({ to: "src/util.ts" });
    expect(r[m + "dynamic ./lib"]).toEqual({ to: "src/lib/index.ts" });
    expect(r[m + "require ./legacy.cjs"]).toEqual({ to: "src/legacy.cjs" });
    expect(r[m + "static ./missing"]).toEqual({ unresolved: true });
    expect(r[m + "static ../outside"]).toEqual({ unresolved: true });
  });

  test("NodeNext: .js mapping, extensionless fallback, subpath imports, CJS importers", async () => {
    const r = await resolveAll(await loadFixture("nodenext"));
    expect(r["src/main.ts static ./util.js"]).toEqual({ to: "src/util.ts" });
    expect(r["src/main.ts static ./util"]).toEqual({ to: "src/util.ts" });
    expect(r["src/main.ts static #util"]).toEqual({ to: "src/util.ts" });
    expect(r["src/main.ts static #nope"]).toEqual({ unresolved: true });
    expect(r["src/legacy.cts require ./helper.cjs"]).toEqual({ to: "src/helper.cts" });
  });

  test("a git-backed source gives identical results", async () => {
    for (const name of CASES) {
      const worktree = await resolveAll(await loadFixture(name, "worktree"));
      const commit = await resolveAll(await loadFixture(name, "main@abc1234"));
      expect(commit).toEqual(worktree);
    }
  });
});
