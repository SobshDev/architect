import { describe, expect, test } from "bun:test";
import type { EdgeTarget, RawImport } from "../../model/index.ts";
import { MemorySource, SettingsSchema } from "../../model/index.ts";
import { createPythonResolver, parseIni } from "./resolve.ts";

type Resolve = (from: string, specifier: string, names?: string[]) => EdgeTarget[];

async function resolver(files: Record<string, string>, settings: Record<string, unknown> = {}): Promise<Resolve> {
  const source = new MemorySource(files);
  const r = await createPythonResolver({ source, files: await source.listFiles(), workspaces: [], settings: SettingsSchema.parse(settings) });
  return (from, specifier, names) => {
    const raw: RawImport = { specifier, kind: "static", line: 1 };
    if (names) raw.names = names;
    return r.resolve(from, raw);
  };
}

const to = (...paths: string[]): EdgeTarget[] => paths.map((p) => ({ to: p }));

describe("source roots", () => {
  test("pyproject packages.find where replaces the project folder as the first root", async () => {
    const resolve = await resolver({
      "pyproject.toml": '[tool.setuptools.packages.find]\nwhere = ["lib"]\n',
      "lib/app/__init__.py": "",
      "lib/app/core.py": "",
      "app/core.py": "",
      "tests/test_core.py": "",
    });
    expect(resolve("tests/test_core.py", "app.core")).toEqual(to("lib/app/core.py"));
    expect(resolve("tests/test_core.py", "tests.test_core")).toEqual(to("tests/test_core.py"));
  });

  test("a src folder is a root even without configuration, before the project folder", async () => {
    const resolve = await resolver({ "pyproject.toml": "[project]\nname = 'x'\n", "src/app/__init__.py": "", "src/app/core.py": "", "tests/t.py": "" });
    expect(resolve("tests/t.py", "app.core")).toEqual(to("src/app/core.py"));
  });

  test("setup.cfg package_dir with an empty key names the root", async () => {
    const resolve = await resolver({
      "setup.cfg": "[metadata]\nname = x\n\n[options]\npackage_dir =\n    =source\npackages = find:\n",
      "source/pkg/__init__.py": "",
      "source/pkg/mod.py": "",
      "scripts/run.py": "",
    });
    expect(resolve("scripts/run.py", "pkg.mod")).toEqual(to("source/pkg/mod.py"));
  });

  test("poetry and hatch declarations point at the parent of each package", async () => {
    const poetry = await resolver({ "pyproject.toml": '[tool.poetry]\npackages = [{ include = "pkg", from = "code" }]\n', "code/pkg/__init__.py": "", "main.py": "" });
    expect(poetry("main.py", "pkg")).toEqual(to("code/pkg/__init__.py"));
    const hatch = await resolver({ "pyproject.toml": '[tool.hatch.build.targets.wheel]\npackages = ["python/pkg"]\n', "python/pkg/__init__.py": "", "main.py": "" });
    expect(hatch("main.py", "pkg")).toEqual(to("python/pkg/__init__.py"));
  });

  test("the nearest project wins, and other projects in the repo still resolve", async () => {
    const resolve = await resolver({
      "services/api/pyproject.toml": "",
      "services/api/src/api/__init__.py": "",
      "services/api/src/shared/__init__.py": "",
      "libs/core/pyproject.toml": "",
      "libs/core/src/core/__init__.py": "",
      "libs/core/src/shared/__init__.py": "",
    });
    expect(resolve("services/api/src/api/__init__.py", "shared")).toEqual(to("services/api/src/shared/__init__.py"));
    expect(resolve("services/api/src/api/__init__.py", "core")).toEqual(to("libs/core/src/core/__init__.py"));
  });

  test("settings.source_roots override discovery and expand globs", async () => {
    const resolve = await resolver(
      { "pyproject.toml": "", "src/a/__init__.py": "", "packages/one/py/one/__init__.py": "", "x.py": "" },
      { source_roots: ["packages/*/py"] },
    );
    expect(resolve("x.py", "one")).toEqual(to("packages/one/py/one/__init__.py"));
    expect(resolve("x.py", "a")).toEqual([{ package: "a" }]);
  });

  test("invalid pyproject.toml falls back to the defaults", async () => {
    const resolve = await resolver({ "pyproject.toml": "[tool.setuptools\n", "src/app/__init__.py": "", "x.py": "" });
    expect(resolve("x.py", "app")).toEqual(to("src/app/__init__.py"));
  });
});

describe("relative imports", () => {
  const files = {
    "pkg/__init__.py": "",
    "pkg/a.py": "",
    "pkg/sub/__init__.py": "",
    "pkg/sub/b.py": "",
    "pkg/sub.py": "",
    "top.py": "",
  };

  test("one dot is the importing module's package, also from __init__.py", async () => {
    const resolve = await resolver(files);
    expect(resolve("pkg/sub/b.py", ".", ["x"])).toEqual(to("pkg/sub/__init__.py"));
    expect(resolve("pkg/sub/__init__.py", ".b")).toEqual(to("pkg/sub/b.py"));
    expect(resolve("pkg/__init__.py", ".a", ["f"])).toEqual(to("pkg/a.py"));
  });

  test("each extra dot climbs one package; a package folder beats a same-named module", async () => {
    const resolve = await resolver(files);
    expect(resolve("pkg/sub/b.py", "..a")).toEqual(to("pkg/a.py"));
    expect(resolve("pkg/sub/b.py", "..", ["a"])).toEqual(to("pkg/a.py"));
    expect(resolve("pkg/a.py", ".sub")).toEqual(to("pkg/sub/__init__.py"));
  });

  test("misses and climbing above the repo are unresolved", async () => {
    const resolve = await resolver(files);
    expect(resolve("pkg/a.py", ".missing")).toEqual([{ unresolved: true }]);
    expect(resolve("pkg/a.py", ".", ["nothing_here"])).toEqual(to("pkg/__init__.py"));
    expect(resolve("top.py", "..x")).toEqual([{ unresolved: true }]);
  });
});

describe("packages and names", () => {
  const files = {
    "pkg/__init__.py": "",
    "pkg/sub.py": "",
    "pkg/deep/__init__.py": "",
    "ns/part/mod.py": "",
    "ns/part/other.py": "",
    "main.py": "",
  };

  test("from-import names that are submodules get their own target; other names hit the package", async () => {
    const resolve = await resolver(files);
    expect(resolve("main.py", "pkg", ["func", "sub", "Klass", "deep"])).toEqual(to("pkg/__init__.py", "pkg/sub.py", "pkg/deep/__init__.py"));
    expect(resolve("main.py", "pkg", ["*"])).toEqual(to("pkg/__init__.py"));
    expect(resolve("main.py", "pkg.sub", ["x"])).toEqual(to("pkg/sub.py"));
  });

  test("namespace packages have no file: they add no edge, and their modules resolve", async () => {
    const resolve = await resolver(files);
    expect(resolve("main.py", "ns")).toEqual([]);
    expect(resolve("main.py", "ns.part")).toEqual([]);
    expect(resolve("main.py", "ns.part", ["mod", "other"])).toEqual(to("ns/part/mod.py", "ns/part/other.py"));
    expect(resolve("main.py", "ns.part.mod")).toEqual(to("ns/part/mod.py"));
    expect(resolve("ns/part/mod.py", ".other")).toEqual(to("ns/part/other.py"));
  });

  test("stdlib is builtin, other absolute misses are packages, and misses inside a regular internal package are unresolved", async () => {
    const resolve = await resolver({ ...files, "email/templates.py": "" });
    expect(resolve("main.py", "os.path")).toEqual([{ package: "os", builtin: true }]);
    expect(resolve("main.py", "__future__", ["annotations"])).toEqual([{ package: "__future__", builtin: true }]);
    expect(resolve("main.py", "email.message")).toEqual([{ package: "email", builtin: true }]);
    expect(resolve("main.py", "requests.adapters", ["HTTPAdapter"])).toEqual([{ package: "requests" }]);
    expect(resolve("main.py", "pkg.missing")).toEqual([{ unresolved: true }]);
    expect(resolve("main.py", "ns.part", ["absent"])).toEqual([{ package: "ns" }]);
  });
});

test("parseIni reads continuation lines and ignores comments", () => {
  const ini = parseIni("# c\n[options]\npackage_dir =\n  =src\n  x = lib/x\n; c\n[options.packages.find]\nwhere: src\n");
  expect(ini.get("options")?.get("package_dir")).toBe("\n=src\nx = lib/x");
  expect(ini.get("options.packages.find")?.get("where")).toBe("src");
});
