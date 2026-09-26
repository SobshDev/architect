// Extracts imports, exports, and dynamic imports from one TypeScript or JavaScript file, using syntax only.
import ts from "typescript";
import type { EdgeKind, ExportKind, ExportedSymbol, FileFacts, RawImport } from "../../model/index.ts";

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ".ts": ts.ScriptKind.TS,
  ".mts": ts.ScriptKind.TS,
  ".cts": ts.ScriptKind.TS,
  ".tsx": ts.ScriptKind.TSX,
  ".js": ts.ScriptKind.JS,
  ".mjs": ts.ScriptKind.JS,
  ".cjs": ts.ScriptKind.JS,
  ".jsx": ts.ScriptKind.JSX,
};
const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const DROPPED_MODIFIERS = new Set([ts.SyntaxKind.ExportKeyword, ts.SyntaxKind.DefaultKeyword, ts.SyntaxKind.DeclareKeyword]);
const MAX_EXPRESSION = 120;

const printer = ts.createPrinter({ removeComments: true });

/** Rebuilds string literals so the printer uses one quote style instead of the source text. */
const literalTransformer: ts.TransformerFactory<ts.Node> = (context) => {
  const visit = (node: ts.Node): ts.Node => {
    if (ts.isStringLiteral(node)) return ts.factory.createStringLiteral(node.text);
    if (ts.isNoSubstitutionTemplateLiteral(node)) return ts.factory.createNoSubstitutionTemplateLiteral(node.text);
    return ts.visitEachChild(node, visit, context);
  };
  return visit;
};

function normalizeLiterals(node: ts.Node): ts.Node {
  const result = ts.transform(node, [literalTransformer]);
  const transformed = result.transformed[0] ?? node;
  result.dispose();
  return transformed;
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot < 0 ? "" : path.slice(dot).toLowerCase();
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isTypeOnlyClause(clause: ts.ImportClause): boolean {
  return clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

function stringLiteralText(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return node.text;
  return undefined;
}

export function analyzeFile(path: string, text: string, contentId: string): FileFacts {
  const ext = extensionOf(path);
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[ext] ?? ts.ScriptKind.TS);
  const lineOf = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const print = (node: ts.Node) => collapse(printer.printNode(ts.EmitHint.Unspecified, normalizeLiterals(node), sf));

  const imports: RawImport[] = [];
  const dynamicImports: { line: number; expression: string }[] = [];
  const starExports: string[] = [];

  const addImport = (specifier: string, kind: EdgeKind, node: ts.Node, names?: string[]) => {
    const raw: RawImport = { specifier, kind, line: lineOf(node) };
    if (names) raw.names = names;
    imports.push(raw);
  };

  // ---------------------------------------------------------------- imports

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = stringLiteralText(statement.moduleSpecifier);
      if (specifier === undefined) continue;
      const clause = statement.importClause;
      if (!clause) {
        addImport(specifier, "side-effect", statement);
        continue;
      }
      const names: string[] = [];
      let typeOnly = isTypeOnlyClause(clause);
      if (clause.name) names.push("default");
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
        if (!clause.name && bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly)) typeOnly = true;
      }
      addImport(specifier, typeOnly ? "type" : "static", statement, names);
    } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
      const specifier = stringLiteralText(statement.moduleReference.expression);
      if (specifier !== undefined) addImport(specifier, statement.isTypeOnly ? "type" : "require", statement, ["default"]);
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      const specifier = stringLiteralText(statement.moduleSpecifier);
      if (specifier === undefined) continue;
      const clause = statement.exportClause;
      let typeOnly = statement.isTypeOnly;
      let names: string[];
      if (clause && ts.isNamedExports(clause)) {
        names = clause.elements.map((e) => (e.propertyName ?? e.name).text);
        if (clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly)) typeOnly = true;
      } else {
        names = ["*"];
        if (!clause) starExports.push(specifier);
      }
      addImport(specifier, typeOnly ? "type" : "reexport", statement, names);
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      const arg = node.arguments[0];
      if ((isImport || isRequire) && arg) {
        const specifier = stringLiteralText(arg);
        if (specifier !== undefined) addImport(specifier, isImport ? "dynamic" : "require", node);
        else dynamicImports.push({ line: lineOf(node), expression: collapse(arg.getText(sf)).slice(0, MAX_EXPRESSION) });
      }
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = stringLiteralText(node.argument.literal);
      if (specifier !== undefined) addImport(specifier, "type", node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  // ---------------------------------------------------------------- exports

  const locals = new Map<string, { kind: ExportKind; signature: string }>();
  const importedBindings = new Map<string, { from: string; original: string }>();
  const exported: ExportedSymbol[] = [];

  const record = (name: string, kind: ExportKind, signature: string, isExported: boolean, node: ts.Node) => {
    const previous = locals.get(name);
    if (previous && previous.kind === kind) previous.signature += " " + signature;
    else if (!previous) locals.set(name, { kind, signature });
    if (!isExported) return;
    const exportName = hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default" : name;
    const existing = exported.find((e) => e.name === exportName && e.kind === kind && e.from === undefined);
    if (existing) existing.signature += " " + signature;
    else exported.push({ name: exportName, kind, signature, line: lineOf(node) });
  };

  for (const statement of sf.statements) {
    const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement)) {
      // An implementation that follows overloads is not part of the public signature.
      const name = statement.name?.text ?? "default";
      if (statement.body && locals.get(name)?.kind === "function") {
        const previous = sf.statements[sf.statements.indexOf(statement) - 1];
        if (previous && ts.isFunctionDeclaration(previous) && !previous.body && previous.name?.text === name) continue;
      }
      record(name, "function", print(stripFunction(statement)), isExported, statement);
    } else if (ts.isClassDeclaration(statement)) {
      record(statement.name?.text ?? "default", "class", print(stripClass(statement)), isExported, statement);
    } else if (ts.isInterfaceDeclaration(statement)) {
      const node = ts.factory.updateInterfaceDeclaration(statement, keptModifiers(statement), statement.name, statement.typeParameters, statement.heritageClauses, statement.members);
      record(statement.name.text, "interface", print(node), isExported, statement);
    } else if (ts.isTypeAliasDeclaration(statement)) {
      const node = ts.factory.updateTypeAliasDeclaration(statement, keptModifiers(statement), statement.name, statement.typeParameters, statement.type);
      record(statement.name.text, "type", print(node), isExported, statement);
    } else if (ts.isEnumDeclaration(statement)) {
      const node = ts.factory.updateEnumDeclaration(statement, keptModifiers(statement), statement.name, statement.members);
      record(statement.name.text, "enum", print(node), isExported, statement);
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && !(statement.flags & ts.NodeFlags.GlobalAugmentation)) {
      record(statement.name.text, "namespace", namespaceSignature(statement), isExported, statement);
    } else if (ts.isVariableStatement(statement)) {
      const keyword = variableKeyword(statement.declarationList);
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          const signature = ts.isIdentifier(declaration.name) ? variableSignature(keyword, name, declaration, print) : keyword + " " + name;
          record(name, "variable", signature, isExported, statement);
        }
      }
    } else if (ts.isImportDeclaration(statement) && statement.importClause) {
      const from = stringLiteralText(statement.moduleSpecifier);
      if (from === undefined) continue;
      const clause = statement.importClause;
      if (clause.name) importedBindings.set(clause.name.text, { from, original: "default" });
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) importedBindings.set(bindings.name.text, { from, original: "*" });
      if (bindings && ts.isNamedImports(bindings)) {
        for (const e of bindings.elements) importedBindings.set(e.name.text, { from, original: (e.propertyName ?? e.name).text });
      }
    } else if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
      const from = stringLiteralText(statement.moduleReference.expression);
      if (from !== undefined) importedBindings.set(statement.name.text, { from, original: "default" });
    }
  }

  // Export lists, re-exports, and export assignments refer to declarations anywhere in the file, so they run second.
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      const from = stringLiteralText(statement.moduleSpecifier);
      const typePrefix = statement.isTypeOnly ? "type " : "";
      if (from !== undefined) {
        if (clause && ts.isNamespaceExport(clause)) {
          exported.push({ name: clause.name.text, kind: "reexport", signature: collapse("export " + typePrefix + "* as " + clause.name.text + " from " + JSON.stringify(from)), line: lineOf(statement), from, original: "*" });
        } else if (clause && ts.isNamedExports(clause)) {
          for (const element of clause.elements) {
            const name = element.name.text;
            const original = (element.propertyName ?? element.name).text;
            const symbol: ExportedSymbol = { name, kind: "reexport", signature: reexportSignature(typePrefix, element, from), line: lineOf(statement), from };
            if (original !== name) symbol.original = original;
            exported.push(symbol);
          }
        }
        continue;
      }
      if (!clause || !ts.isNamedExports(clause)) continue;
      for (const element of clause.elements) {
        const name = element.name.text;
        const local = (element.propertyName ?? element.name).text;
        const declaration = locals.get(local);
        const imported = importedBindings.get(local);
        if (declaration) {
          exported.push({ name, kind: declaration.kind, signature: declaration.signature, line: lineOf(statement) });
        } else if (imported) {
          const symbol: ExportedSymbol = { name, kind: "reexport", signature: reexportSignature(typePrefix, element, imported.from), line: lineOf(statement), from: imported.from };
          if (imported.original !== name) symbol.original = imported.original;
          exported.push(symbol);
        } else {
          exported.push({ name, kind: "variable", signature: collapse("export { " + element.getText(sf) + " }"), line: lineOf(statement) });
        }
      }
    } else if (ts.isExportAssignment(statement)) {
      exported.push({ name: "default", kind: "default", signature: defaultSignature(statement, locals, print), line: lineOf(statement) });
    }
  }

  const facts: FileFacts = {
    path,
    language: TS_EXTENSIONS.has(ext) ? "typescript" : "javascript",
    contentId,
    loc: countLines(text),
    imports,
    exports: exported,
    starExports,
    dynamicImports,
    writes: [],
  };
  const diagnostics = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  const first = diagnostics?.[0];
  if (first) facts.parseError = ts.flattenDiagnosticMessageText(first.messageText, "\n");
  return facts;
}

function countLines(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") count++;
  return count;
}

function keptModifiers(node: ts.Node): ts.ModifierLike[] | undefined {
  if (!ts.canHaveModifiers(node)) return undefined;
  const modifiers = node.modifiers?.filter((m) => !DROPPED_MODIFIERS.has(m.kind));
  return modifiers && modifiers.length > 0 ? modifiers : undefined;
}

function isPrivate(member: ts.ClassElement): boolean {
  return (member.name !== undefined && ts.isPrivateIdentifier(member.name)) || hasModifier(member, ts.SyntaxKind.PrivateKeyword);
}

/** Drops default values; a parameter with a default becomes optional. */
function stripParameters(parameters: ts.NodeArray<ts.ParameterDeclaration>): ts.ParameterDeclaration[] {
  return parameters.map((p) =>
    ts.factory.updateParameterDeclaration(
      p,
      p.modifiers,
      p.dotDotDotToken,
      p.name,
      p.initializer && !p.dotDotDotToken ? ts.factory.createToken(ts.SyntaxKind.QuestionToken) : p.questionToken,
      p.type,
      undefined,
    ),
  );
}

function stripFunction(node: ts.FunctionDeclaration): ts.FunctionDeclaration {
  return ts.factory.updateFunctionDeclaration(node, keptModifiers(node), node.asteriskToken, node.name, node.typeParameters, stripParameters(node.parameters), node.type, undefined);
}

function stripClass(node: ts.ClassDeclaration | ts.ClassExpression): ts.ClassDeclaration {
  const f = ts.factory;
  const members: ts.ClassElement[] = [];
  for (const m of node.members) {
    if (isPrivate(m)) continue;
    if (ts.isMethodDeclaration(m)) {
      members.push(f.updateMethodDeclaration(m, m.modifiers, m.asteriskToken, m.name, m.questionToken, m.typeParameters, stripParameters(m.parameters), m.type, undefined));
    } else if (ts.isConstructorDeclaration(m)) {
      members.push(f.updateConstructorDeclaration(m, m.modifiers, stripParameters(m.parameters), undefined));
    } else if (ts.isGetAccessorDeclaration(m)) {
      members.push(f.updateGetAccessorDeclaration(m, m.modifiers, m.name, stripParameters(m.parameters), m.type, undefined));
    } else if (ts.isSetAccessorDeclaration(m)) {
      members.push(f.updateSetAccessorDeclaration(m, m.modifiers, m.name, stripParameters(m.parameters), undefined));
    } else if (ts.isPropertyDeclaration(m)) {
      members.push(f.updatePropertyDeclaration(m, m.modifiers, m.name, m.questionToken ?? m.exclamationToken, m.type, undefined));
    } else if (ts.isIndexSignatureDeclaration(m)) {
      members.push(m);
    }
  }
  return f.createClassDeclaration(keptModifiers(node), node.name, node.typeParameters, node.heritageClauses, members);
}

function namespaceSignature(node: ts.ModuleDeclaration): string {
  const parts: string[] = [];
  let body: ts.ModuleBody | undefined = node.body;
  let name = node.name.text;
  while (body && ts.isModuleDeclaration(body)) {
    name += "." + body.name.text;
    body = body.body;
  }
  if (body && ts.isModuleBlock(body)) {
    for (const statement of body.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const d of statement.declarationList.declarations) parts.push(...bindingNames(d.name));
      } else if ("name" in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) {
        parts.push((statement.name as ts.Identifier).text);
      }
    }
  }
  return "namespace " + name + " { " + parts.join(", ") + " }";
}

function variableKeyword(list: ts.VariableDeclarationList): string {
  if (list.flags & ts.NodeFlags.Const) return "const";
  if (list.flags & ts.NodeFlags.Let) return "let";
  return "var";
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  const out: string[] = [];
  for (const element of name.elements) if (!ts.isOmittedExpression(element)) out.push(...bindingNames(element.name));
  return out;
}

function functionLikeSignature(prefix: string, node: ts.ArrowFunction | ts.FunctionExpression, print: (n: ts.Node) => string): string {
  const typeParameters = node.typeParameters ? "<" + node.typeParameters.map(print).join(", ") + ">" : "";
  const parameters = stripParameters(node.parameters).map(print).join(", ");
  const returns = node.type ? ": " + print(node.type) : "";
  const isAsync = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? "async " : "";
  return prefix + " = " + isAsync + typeParameters + "(" + parameters + ")" + returns;
}

function variableSignature(keyword: string, name: string, declaration: ts.VariableDeclaration, print: (n: ts.Node) => string): string {
  if (declaration.type) return keyword + " " + name + ": " + print(declaration.type);
  let init = declaration.initializer;
  while (init && ts.isParenthesizedExpression(init)) init = init.expression;
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return functionLikeSignature(keyword + " " + name, init, print);
  return keyword + " " + name;
}

function defaultSignature(node: ts.ExportAssignment, locals: Map<string, { signature: string }>, print: (n: ts.Node) => string): string {
  const prefix = node.isExportEquals ? "export =" : "export default";
  let e = node.expression;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isIdentifier(e)) return locals.get(e.text)?.signature ?? prefix + " " + e.text;
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return functionLikeSignature(prefix, e, print);
  if (ts.isClassExpression(e)) return print(stripClass(e));
  if (ts.isObjectLiteralExpression(e)) {
    const names = e.properties.map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : "…"));
    return prefix + " { " + names.join(", ") + " }";
  }
  if (ts.isCallExpression(e)) return prefix + " " + collapse(print(e.expression)) + "(…)";
  return prefix + " " + ts.SyntaxKind[e.kind];
}

function reexportSignature(typePrefix: string, element: ts.ExportSpecifier, from: string): string {
  const original = (element.propertyName ?? element.name).text;
  const name = element.name.text;
  const typeWord = element.isTypeOnly ? "type " : "";
  const binding = original === name ? name : original + " as " + name;
  return "export " + typePrefix + "{ " + typeWord + binding + " } from " + JSON.stringify(from);
}
