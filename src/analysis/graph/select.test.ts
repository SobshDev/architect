import { expect, test } from "bun:test";
import { MemorySource, SettingsSchema } from "../../model/index.ts";
import { selectFiles } from "./select.ts";
import { discoverWorkspaces } from "./workspaces.ts";

const files = [
  ".architect/cache/x.ts",
  "README.md",
  "node_modules/react/index.js",
  "packages/a/dist/index.js",
  "packages/a/src/index.ts",
  "packages/a/src/types.d.ts",
  "packages/a/src/view.TSX",
  "public/lib.min.js",
  "scripts/gen.ts",
  "src/app.ts",
  "src/app.test.ts",
  "src/legacy/old.js",
];

test("selection keeps analyzer extensions and drops built-in excludes", () => {
  expect(selectFiles(files, SettingsSchema.parse({}), [".ts", ".tsx", ".js"])).toEqual([
    "packages/a/src/index.ts",
    "packages/a/src/view.TSX",
    "scripts/gen.ts",
    "src/app.ts",
    "src/app.test.ts",
    "src/legacy/old.js",
  ]);
});

test("include restricts and exclude removes, folders work without globs", () => {
  const settings = SettingsSchema.parse({ include: ["src", "packages/*/src/**"], exclude: ["**/*.test.ts", "src/legacy"] });
  expect(selectFiles(files, settings, [".ts", ".tsx", ".js"])).toEqual(["packages/a/src/index.ts", "packages/a/src/view.TSX", "src/app.ts"]);
});

const packages = {
  "apps/web/package.json": JSON.stringify({ name: "web" }),
  "packages/a/package.json": JSON.stringify({ name: "@x/a" }),
  "packages/b/package.json": JSON.stringify({ name: "@x/b" }),
  "packages/nameless/package.json": JSON.stringify({ private: true }),
  "packages/a/node_modules/dep/package.json": JSON.stringify({ name: "dep" }),
};

async function discover(extra: Record<string, string>) {
  const source = new MemorySource({ ...packages, ...extra });
  return discoverWorkspaces(source, await source.listFiles());
}

test("workspaces from a package.json array, with negation", async () => {
  const found = await discover({ "package.json": JSON.stringify({ workspaces: ["packages/*", "./apps/*/", "!packages/b"] }) });
  expect(found).toEqual([
    { name: "web", dir: "apps/web" },
    { name: "@x/a", dir: "packages/a" },
  ]);
});

test("workspaces from a package.json packages object", async () => {
  const found = await discover({ "package.json": JSON.stringify({ workspaces: { packages: ["packages/**"] } }) });
  expect(found.map((w) => w.dir)).toEqual(["packages/a", "packages/b"]);
});

test("workspaces from pnpm-workspace.yaml; the root is never a workspace", async () => {
  const found = await discover({ "package.json": JSON.stringify({ name: "root" }), "pnpm-workspace.yaml": "packages:\n  - 'apps/*'\n  - '!apps/none'\n" });
  expect(found).toEqual([{ name: "web", dir: "apps/web" }]);
});

test("broken manifests yield no workspaces", async () => {
  expect(await discover({ "package.json": "{", "pnpm-workspace.yaml": ": [" })).toEqual([]);
});
