import { beforeAll, describe, expect, test } from "bun:test";
import type { FileFacts } from "../../model/index.ts";
import { analyzeFile } from "./analyze.ts";
import { preparePython } from "./parser.ts";

beforeAll(() => preparePython());

const facts = (...lines: string[]): FileFacts => analyzeFile("pkg/mod.py", `${lines.join("\n")}\n`, "id");
const importsOf = (f: FileFacts) => f.imports.map((i) => `${i.line} ${i.kind} ${i.specifier}${i.names ? ` ${i.names.join(",")}` : ""}`);
const exportsOf = (f: FileFacts) => f.exports.map((e) => `${e.kind} ${e.name}: ${e.signature}`);

describe("imports", () => {
  test("TYPE_CHECKING blocks give type edges; else branches, try blocks, and function bodies stay static", () => {
    const f = facts(
      "import typing",
      "from typing import TYPE_CHECKING",
      "if TYPE_CHECKING:",
      "    from app.models import User",
      "if typing.TYPE_CHECKING:",
      "    import app.repo as repo",
      "else:",
      "    import app.runtime",
      "try:",
      "    import ujson as json",
      "except ImportError:",
      "    import json",
      "def load():",
      "    from app.cache import get",
    );
    expect(importsOf(f)).toEqual([
      "1 static typing",
      "2 static typing TYPE_CHECKING",
      "4 type app.models User",
      "6 type app.repo",
      "8 static app.runtime",
      "10 static ujson",
      "12 static json",
      "14 static app.cache get",
    ]);
  });

  test("from-imports keep their relative dots and list the original names; a wildcard lists *", () => {
    const f = facts("from . import sibling", "from ..core import b as c", "from .x import *");
    expect(importsOf(f)).toEqual(["1 static . sibling", "2 static ..core b", "3 static .x *"]);
  });

  test("literal import_module and __import__ calls are dynamic edges; anything computed is reported instead", () => {
    const f = facts(
      "import importlib",
      "a = importlib.import_module('plugins.csv')",
      "b = importlib.import_module('.json', 'plugins')",
      "c = importlib.import_module('.yaml', package=__package__)",
      "d = __import__(name)",
    );
    expect(importsOf(f)).toEqual(["1 static importlib", "2 dynamic plugins.csv", "3 dynamic plugins.json"]);
    expect(f.dynamicImports).toEqual([
      { line: 4, expression: "'.yaml'" },
      { line: 5, expression: "name" },
    ]);
  });
});

describe("exports", () => {
  test("public top-level names and relative re-exports are exported; private names and absolute from-imports are not", () => {
    const f = facts(
      "import os",
      "from app.core import Engine",
      "from .helpers import slugify as slug",
      "from .models import *",
      "VERSION: str = '1'",
      "_private = 2",
      "@dataclass",
      "class Order(Base):",
      "    def total(self):",
      "        return 1",
      "def _hidden():",
      "    pass",
      "async def fetch(url: str, *, timeout: float = 1.0) -> bytes:",
      "    return b''",
      "if sys.version_info >= (3, 11):",
      "    def modern():",
      "        pass",
    );
    expect(exportsOf(f)).toEqual([
      "reexport slug: from .helpers import slugify as slug",
      "variable VERSION: VERSION: str",
      "class Order: @dataclass class Order(Base)",
      "function fetch: async def fetch(url: str, *, timeout: float = 1.0) -> bytes",
      "function modern: def modern()",
    ]);
    expect(f.exports.find((e) => e.name === "slug")).toMatchObject({ from: ".helpers", original: "slugify" });
    expect(f.starExports).toEqual([".models"]);
  });

  test("a literal __all__ replaces the default exports and += extends it; a computed __all__ keeps the defaults", () => {
    const listed = facts("from .a import A", "from app.b import B", "def c():", "    pass", "def d():", "    pass", "__all__ = ['A', 'B']", "__all__ += ['c']");
    expect(listed.exports.map((e) => e.name)).toEqual(["A", "B", "c"]);
    const computed = facts("def c():", "    pass", "def _d():", "    pass", "__all__ = [n for n in dir() if n.startswith('c')]");
    expect(computed.exports.map((e) => e.name)).toEqual(["c"]);
  });
});

test("a syntax error keeps the facts recovered around it and reports the first error line", () => {
  const f = facts("import app.one", "def broken(:", "    pass", "from app.two import x");
  expect(importsOf(f)).toEqual(["1 static app.one", "4 static app.two x"]);
  expect(f.parseError).toBe("syntax error on line 2");
});

