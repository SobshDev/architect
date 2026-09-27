// Extracts imports, exports, and dynamic imports from one Python file with tree-sitter, using syntax only.
import type { Node } from "web-tree-sitter";
import type { EdgeKind, ExportedSymbol, ExportKind, FileFacts, RawImport } from "../../model/index.ts";
import { pythonParser } from "./parser.ts";

const MAX_EXPRESSION = 120;
const IMPORT_NODES = ["import_statement", "import_from_statement", "future_import_statement"];
const DYNAMIC_FUNCTIONS = new Set(["importlib.import_module", "import_module", "__import__"]);
/** Nodes whose statements still run at module level, so their definitions count as top-level. */
const CONTAINERS = new Set([
  "block",
  "if_statement",
  "elif_clause",
  "else_clause",
  "try_statement",
  "except_clause",
  "except_group_clause",
  "finally_clause",
  "with_statement",
  "ERROR",
]);

/** A top-level name. absolute marks absolute from-imports, which are exports only when __all__ lists them. */
interface Binding extends Omit<ExportedSymbol, "name"> {
  absolute?: boolean;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

function isPublic(name: string): boolean {
  return !name.startsWith("_");
}

/** The value of a plain string literal (no f-string, no concatenation), or undefined. */
function literalString(node: Node | null | undefined): string | undefined {
  if (!node || node.type !== "string") return undefined;
  let content = "";
  for (const child of node.namedChildren) {
    if (!child) continue;
    if (child.type === "string_start") {
      if (/[fFbBtT]/.test(child.text)) return undefined;
    } else if (child.type === "string_content") content += child.text;
    else if (child.type !== "string_end") return undefined;
  }
  return content;
}

/** Strings of a list or tuple literal, or undefined when any element is not a plain string. */
function literalStrings(node: Node | null | undefined): string[] | undefined {
  if (!node || (node.type !== "list" && node.type !== "tuple")) return undefined;
  const out: string[] = [];
  for (const child of node.namedChildren) {
    if (!child || child.type === "comment") continue;
    const value = literalString(child);
    if (value === undefined) return undefined;
    out.push(value);
  }
  return out;
}

/** True when the node sits in the body of "if TYPE_CHECKING:" (or "if typing.TYPE_CHECKING:"). */
function underTypeChecking(node: Node): boolean {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (parent.type !== "if_statement" || child.type !== "block") continue;
    if (!parent.childForFieldName("consequence")?.equals(child)) continue;
    const condition = parent.childForFieldName("condition");
    if (condition && /^(\w+\.)*TYPE_CHECKING$/.test(condition.text)) return true;
  }
  return false;
}

/** The module named by a from-import: "a.b", ".", "..pkg". */
function fromModule(statement: Node): string {
  const module = statement.childForFieldName("module_name");
  return module ? module.text.replace(/\s+/g, "") : "";
}

/** Imported (original, bound) name pairs of a from-import, or [["*", "*"]] for a wildcard. */
function fromNames(statement: Node): [string, string][] {
  if (statement.namedChildren.some((c) => c?.type === "wildcard_import")) return [["*", "*"]];
  return statement.childrenForFieldName("name").map((n): [string, string] => {
    if (n.type === "aliased_import") {
      const original = n.childForFieldName("name")?.text ?? "";
      return [original, n.childForFieldName("alias")?.text ?? original];
    }
    return [n.text, n.text];
  });
}

/** Resolves a relative module literal against a package literal, as importlib does: (".x", "a.b") gives "a.b.x". */
function absoluteName(name: string, pkg: string): string | undefined {
  const dots = name.length - name.replace(/^\.+/, "").length;
  const parts = pkg.split(".");
  if (dots > parts.length) return undefined;
  const base = parts.slice(0, parts.length - dots + 1).join(".");
  const rest = name.slice(dots);
  return rest ? `${base}.${rest}` : base;
}

function paramsText(node: Node | null): string {
  if (!node) return "()";
  const parts = node.namedChildren.flatMap((c) => (c && c.type !== "comment" ? [collapse(c.text)] : []));
  return `(${parts.join(", ")})`;
}

function definitionSignature(definition: Node, decorators: readonly Node[]): string {
  const prefix = decorators.map((d) => collapse(d.text) + " ").join("");
  const name = definition.childForFieldName("name")?.text ?? "";
  const typeParams = definition.childForFieldName("type_parameters");
  const generic = typeParams ? collapse(typeParams.text) : "";
  if (definition.type === "class_definition") {
    const bases = definition.childForFieldName("superclasses");
    return `${prefix}class ${name}${generic}${bases && bases.namedChildCount > 0 ? paramsText(bases) : ""}`;
  }
  const isAsync = definition.children.some((c) => c?.type === "async");
  const returns = definition.childForFieldName("return_type");
  const params = paramsText(definition.childForFieldName("parameters"));
  return `${prefix}${isAsync ? "async " : ""}def ${name}${generic}${params}${returns ? " -> " + collapse(returns.text) : ""}`;
}

/** Names bound by an assignment target: an identifier, or the identifiers of a tuple or list pattern. */
function targetNames(target: Node): string[] {
  if (target.type === "identifier") return [target.text];
  if (["pattern_list", "tuple_pattern", "list_pattern"].includes(target.type)) {
    return target.namedChildren.flatMap((c) => (c ? targetNames(c) : []));
  }
  return [];
}

/** First syntax error or missing token, as "syntax error on line N". */
function firstError(root: Node): string | undefined {
  if (!root.hasError) return undefined;
  let node: Node = root;
  for (;;) {
    let next: Node | undefined;
    for (const child of node.children) {
      if (!child) continue;
      if (child.isError || child.isMissing) return `syntax error on line ${lineOf(child)}`;
      if (child.hasError) {
        next = child;
        break;
      }
    }
    if (!next) return `syntax error on line ${lineOf(node)}`;
    node = next;
  }
}

/** Top-level bindings and __all__, walking into if/try/with blocks but never into functions or classes. */
class ExportCollector {
  readonly bindings = new Map<string, Binding>();
  readonly starExports: string[] = [];
  all: string[] | undefined;
  allLiteral = true;
  allLine = 0;

  visit(container: Node): void {
    for (const node of container.namedChildren) {
      if (!node) continue;
      if (CONTAINERS.has(node.type)) this.visit(node);
      else this.statement(node);
    }
  }

  private bind(name: string, binding: Binding): void {
    if (!this.bindings.has(name)) this.bindings.set(name, binding);
  }

  private statement(node: Node): void {
    switch (node.type) {
      case "decorated_definition": {
        const definition = node.childForFieldName("definition");
        if (definition) this.definition(definition, node.namedChildren.filter((c): c is Node => c?.type === "decorator"), node);
        return;
      }
      case "function_definition":
      case "class_definition":
        this.definition(node, [], node);
        return;
      case "expression_statement":
        for (const child of node.namedChildren) if (child) this.expression(child);
        return;
      case "import_from_statement": {
        const from = fromModule(node);
        for (const [original, name] of fromNames(node)) {
          if (original === "*") {
            if (from.startsWith(".")) this.starExports.push(from);
            continue;
          }
          const renamed = original === name ? "" : ` as ${name}`;
          const binding: Binding = { kind: "reexport", signature: `from ${from} import ${original}${renamed}`, line: lineOf(node), from };
          if (original !== name) binding.original = original;
          if (!from.startsWith(".")) binding.absolute = true;
          this.bind(name, binding);
        }
        return;
      }
    }
  }

  private definition(definition: Node, decorators: Node[], outer: Node): void {
    const name = definition.childForFieldName("name")?.text;
    if (!name) return;
    const kind: ExportKind = definition.type === "class_definition" ? "class" : "function";
    this.bind(name, { kind, signature: definitionSignature(definition, decorators), line: lineOf(outer) });
  }

  private expression(node: Node): void {
    if (node.type === "assignment") {
      const left = node.childForFieldName("left");
      if (left?.text === "__all__") {
        this.setAll(literalStrings(node.childForFieldName("right")), node, false);
        return;
      }
      const annotation = node.childForFieldName("type");
      for (let current: Node | null = node, first = true; current?.type === "assignment"; current = current.childForFieldName("right"), first = false) {
        const target = current.childForFieldName("left");
        if (!target) continue;
        for (const name of targetNames(target)) {
          const typed = first && annotation && target.type === "identifier" ? `${name}: ${collapse(annotation.text)}` : name;
          this.bind(name, { kind: "variable", signature: typed, line: lineOf(node) });
        }
      }
    } else if (node.type === "augmented_assignment" && node.childForFieldName("left")?.text === "__all__") {
      this.setAll(node.text.includes("+=") ? literalStrings(node.childForFieldName("right")) : undefined, node, true);
    } else if (node.type === "call") {
      const fn = node.childForFieldName("function")?.text;
      const args = node.childForFieldName("arguments")?.namedChildren.filter((c): c is Node => c !== null && c.type !== "comment") ?? [];
      if (fn === "__all__.extend") this.setAll(args.length === 1 ? literalStrings(args[0]) : undefined, node, true);
      else if (fn === "__all__.append") {
        const value = args.length === 1 ? literalString(args[0]) : undefined;
        this.setAll(value === undefined ? undefined : [value], node, true);
      }
    }
  }

  private setAll(names: string[] | undefined, node: Node, append: boolean): void {
    if (names === undefined) this.allLiteral = false;
    else if (append && this.all !== undefined) this.all.push(...names);
    else if (append) this.allLiteral = false;
    else this.all = [...names];
    if (this.allLine === 0) this.allLine = lineOf(node);
  }

  exports(): { exports: ExportedSymbol[]; starExports: string[] } {
    const out: ExportedSymbol[] = [];
    const explicit = this.all !== undefined && this.allLiteral ? [...new Set(this.all)] : undefined;
    if (explicit) {
      for (const name of explicit) {
        const binding = this.bindings.get(name) ?? { kind: "variable", signature: name, line: this.allLine };
        out.push({ name, ...strip(binding) });
      }
    } else {
      for (const [name, binding] of this.bindings) {
        if (isPublic(name) && !binding.absolute) out.push({ name, ...strip(binding) });
      }
    }
    out.sort((a, b) => a.line - b.line || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { exports: out, starExports: explicit ? [] : [...new Set(this.starExports)] };
  }
}

function strip(binding: Binding): Omit<ExportedSymbol, "name"> {
  const { absolute: _absolute, ...rest } = binding;
  return rest;
}

export function analyzeFile(path: string, text: string, contentId: string): FileFacts {
  const tree = pythonParser().parse(text);
  if (!tree) throw new Error(`python analyzer: tree-sitter returned no tree for ${path}`);
  try {
    const root = tree.rootNode;
    const imports: RawImport[] = [];
    const dynamicImports: FileFacts["dynamicImports"] = [];
    const checksTypes = text.includes("TYPE_CHECKING");
    const kindOf = (node: Node): EdgeKind => (checksTypes && underTypeChecking(node) ? "type" : "static");

    for (const node of root.descendantsOfType(IMPORT_NODES)) {
      if (!node) continue;
      const line = lineOf(node);
      if (node.type === "import_statement") {
        for (const name of node.childrenForFieldName("name")) {
          const dotted = name.type === "aliased_import" ? name.childForFieldName("name") : name;
          if (dotted) imports.push({ specifier: dotted.text.replace(/\s+/g, ""), kind: kindOf(node), line });
        }
      } else {
        const specifier = node.type === "future_import_statement" ? "__future__" : fromModule(node);
        const names = [...new Set(fromNames(node).map(([original]) => original))];
        if (specifier) imports.push({ specifier, kind: kindOf(node), line, names });
      }
    }

    if (text.includes("import_module") || text.includes("__import__")) {
      for (const call of root.descendantsOfType("call")) {
        const fn = call?.childForFieldName("function");
        if (!call || !fn || !DYNAMIC_FUNCTIONS.has(fn.text)) continue;
        const args = call.childForFieldName("arguments")?.namedChildren.filter((c): c is Node => c !== null && c.type !== "comment") ?? [];
        const first = args[0];
        if (!first || first.type === "keyword_argument") continue;
        let name = literalString(first);
        if (name !== undefined && name.startsWith(".")) {
          const pkgArg = args.find((a) => a.type === "keyword_argument" && a.childForFieldName("name")?.text === "package")?.childForFieldName("value") ?? args[1];
          const pkg = fn.text === "__import__" ? undefined : literalString(pkgArg);
          name = pkg ? absoluteName(name, pkg) : undefined;
        }
        if (name) imports.push({ specifier: name, kind: "dynamic", line: lineOf(call) });
        else dynamicImports.push({ line: lineOf(call), expression: collapse(first.text).slice(0, MAX_EXPRESSION) });
      }
    }

    const collector = new ExportCollector();
    collector.visit(root);
    const { exports, starExports } = collector.exports();

    const facts: FileFacts = {
      path,
      language: "python",
      contentId,
      loc: text.split("\n").filter((l) => l.trim() !== "").length,
      imports: imports.sort((a, b) => a.line - b.line),
      exports,
      starExports,
      dynamicImports,
      writes: [],
    };
    const error = firstError(root);
    if (error) facts.parseError = error;
    return facts;
  } finally {
    tree.delete();
  }
}

