// Loads web-tree-sitter and the vendored Python grammar once. Both wasm files are file imports, so compiled binaries embed them.
import { Language, Parser } from "web-tree-sitter";
import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import grammarWasm from "./grammar/tree-sitter-python.wasm" with { type: "file" };

let loading: Promise<void> | null = null;
let parser: Parser | null = null;

/** Initializes the parser. Idempotent: every call shares one promise. */
export function preparePython(): Promise<void> {
  loading ??= (async () => {
    const [wasmBinary, grammar] = await Promise.all([Bun.file(runtimeWasm).bytes(), Bun.file(grammarWasm).bytes()]);
    await Parser.init({ wasmBinary });
    const language = await Language.load(grammar);
    const instance = new Parser();
    instance.setLanguage(language);
    parser = instance;
  })();
  return loading;
}

/** The ready parser. Throws when preparePython() has not completed. */
export function pythonParser(): Parser {
  if (parser === null) throw new Error("python analyzer: call prepare() and await it before analyze()");
  return parser;
}
