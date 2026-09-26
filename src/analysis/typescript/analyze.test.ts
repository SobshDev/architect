import { describe, expect, test } from "bun:test";
import type { ExportedSymbol } from "../../model/index.ts";
import { typescriptAnalyzer } from "./index.ts";

const analyze = (text: string, path = "src/a.ts") => typescriptAnalyzer.analyze(path, text, "id");
const signatureOf = (text: string, name: string) => analyze(text).exports.find((e) => e.name === name)?.signature;

describe("imports", () => {
  test("each import form gets its kind, line, and names", () => {
    const facts = analyze(
      [
        'import def, { a, b as bb } from "./a";',
        'import * as ns from "./ns";',
        'import type { T } from "./t";',
        'import { type X, type Y } from "./xy";',
        'import { type Z, w } from "./zw";',
        'import "./side";',
        'import cjs = require("./cjs");',
        'export { r1, r2 as renamed } from "./re";',
        'export * from "./star";',
        'export * as nsx from "./nsx";',
        'export type { RT } from "./rt";',
        'function load() { return require("./req"); }',
        'const d = import("./dyn");',
        "const t = import(`./tpl`);",
      ].join("\n"),
    );
    expect(facts.imports).toEqual([
      { specifier: "./a", kind: "static", line: 1, names: ["default", "a", "b"] },
      { specifier: "./ns", kind: "static", line: 2, names: ["*"] },
      { specifier: "./t", kind: "type", line: 3, names: ["T"] },
      { specifier: "./xy", kind: "type", line: 4, names: ["X", "Y"] },
      { specifier: "./zw", kind: "static", line: 5, names: ["Z", "w"] },
      { specifier: "./side", kind: "side-effect", line: 6 },
      { specifier: "./cjs", kind: "require", line: 7, names: ["default"] },
      { specifier: "./re", kind: "reexport", line: 8, names: ["r1", "r2"] },
      { specifier: "./star", kind: "reexport", line: 9, names: ["*"] },
      { specifier: "./nsx", kind: "reexport", line: 10, names: ["*"] },
      { specifier: "./rt", kind: "type", line: 11, names: ["RT"] },
      { specifier: "./req", kind: "require", line: 12 },
      { specifier: "./dyn", kind: "dynamic", line: 13 },
      { specifier: "./tpl", kind: "dynamic", line: 14 },
    ]);
    expect(facts.starExports).toEqual(["./star"]);
  });

  test("non-literal import() and require() are recorded as dynamic imports", () => {
    const facts = analyze("const a = import(base + '/x');\nconst b = require(`./${name}`);\nconst c = import(" + '"' + "x".repeat(200) + '"' + " + y);");
    expect(facts.imports).toEqual([]);
    expect(facts.dynamicImports.map((d) => d.line)).toEqual([1, 2, 3]);
    expect(facts.dynamicImports[0]?.expression).toBe("base + '/x'");
    expect(facts.dynamicImports[2]?.expression.length).toBe(120);
  });

  test("language, loc, and parse errors", () => {
    const facts = analyze('import { a } from "./a";\n\n\nexport function broken( {\n', "lib/x.mjs");
    expect(facts.language).toBe("javascript");
    expect(facts.loc).toBe(2);
    expect(facts.parseError).toBeString();
    expect(facts.imports.map((i) => i.specifier)).toEqual(["./a"]);
    expect(analyze("export const a = 1;").parseError).toBeUndefined();
    expect(analyze("const a = <div />;", "x.tsx").parseError).toBeUndefined();
  });
});

describe("export signatures", () => {
  test("formatting, comments, and body changes keep signatures; a parameter type change alters them", () => {
    const base = "export function f(a: string, b = 1): number { return 1; }\nexport class C { private x = 1; m(a: string): void { go(); } }\nexport const g = (a: string) => a;";
    const reformatted = "/** docs */\nexport function f(\n  a: string, // first\n  b = 2,\n): number {\n  return compute(a);\n}\nexport class C {\n  private x = 2;\n  #y = 3;\n  m(a: string): void {}\n}\nexport const g = (a: string) => {\n  return a + a;\n};";
    const changed = base.replaceAll("a: string", "a: number");
    for (const name of ["f", "C", "g"]) {
      expect(signatureOf(reformatted, name)).toBe(signatureOf(base, name) as string);
      expect(signatureOf(changed, name)).not.toBe(signatureOf(base, name) as string);
    }
  });

  test("declarations print without bodies, initializers, or private members", () => {
    const exports = analyze(
      [
        "export function over(a: string): string;",
        "export function over(a: number): number;",
        "export function over(a: any): any { return a; }",
        "export default class Foo extends Base { private s = 1; #h = 2; static count = 0; get v(): number { return 1; } }",
        "export interface I { a: string }",
        "export type U = 'a' | 'b';",
        "export enum E { A = 1, B }",
        "export namespace N { export const k = 1; export function g() {} }",
        "export const conf: Config = { a: 1 };",
        "export let plain = 5;",
        "function local(a: string): void {}",
        "export { local as exposed };",
      ].join("\n"),
    ).exports;
    const byName = Object.fromEntries(exports.map((e) => [e.name, [e.kind, e.signature]]));
    expect(byName).toEqual({
      over: ["function", "function over(a: string): string; function over(a: number): number;"],
      default: ["class", "class Foo extends Base { static count; get v(): number; }"],
      I: ["interface", "interface I { a: string; }"],
      U: ["type", 'type U = "a" | "b";'],
      E: ["enum", "enum E { A = 1, B }"],
      N: ["namespace", "namespace N { k, g }"],
      conf: ["variable", "const conf: Config"],
      plain: ["variable", "let plain"],
      exposed: ["function", "function local(a: string): void;"],
    });
  });

  test("export default expressions and export =", () => {
    expect(analyze("export default defineConfig({ a: 1 });").exports).toEqual([{ name: "default", kind: "default", signature: "export default defineConfig(…)", line: 1 }]);
    expect(analyze("function main(a: string) {}\nexport = main;").exports[0]).toMatchObject({ name: "default", kind: "default", signature: "function main(a: string);" });
  });

  test("re-exports record their source and original name", () => {
    const exports = analyze('export { a as b, c } from "./x";\nexport * as ns from "./y";\nimport { d } from "./z";\nexport { d as e };\nexport * from "./w";').exports;
    expect(exports).toEqual<ExportedSymbol[]>([
      { name: "b", kind: "reexport", signature: 'export { a as b } from "./x"', line: 1, from: "./x", original: "a" },
      { name: "c", kind: "reexport", signature: 'export { c } from "./x"', line: 1, from: "./x" },
      { name: "ns", kind: "reexport", signature: 'export * as ns from "./y"', line: 2, from: "./y", original: "*" },
      { name: "e", kind: "reexport", signature: 'export { d as e } from "./z"', line: 4, from: "./z", original: "d" },
    ]);
  });
});
