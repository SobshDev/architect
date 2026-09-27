// Cargo.toml as a file of imports: each dependency is one import of the crate it names. Crates in the repository
// resolve to their own Cargo.toml, so crate dependencies become edges between the components that hold the crates.
// dev-dependencies are left out: like test files, they do not describe the design.
import type { FileFacts, RawImport } from "../../model/index.ts";

/** The dependency tables that count, as written in headers: [dependencies], [build-dependencies], and their target.<cfg> forms. */
function isDependencyTable(header: string): boolean {
  if (header === "dependencies" || header === "build-dependencies") return true;
  return header.startsWith("target.") && (header.endsWith(".dependencies") || header.endsWith(".build-dependencies")) && !header.endsWith(".dev-dependencies");
}

/** A header without spaces around dots: [ target.'cfg(unix)' . dependencies ] becomes target.'cfg(unix)'.dependencies. */
function normalizeHeader(raw: string): string {
  return raw.trim().replace(/\s*\.\s*/g, ".");
}

const HEADER = /^\s*\[([^[\]]+)\]\s*(#.*)?$/;
const KEY = /^\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=/;

/** Dependency keys renamed with the package field (serde_json2 = { package = "serde_json" }) mapped to the crate name. */
function renames(doc: Record<string, unknown>): Map<string, string> {
  const out = new Map<string, string>();
  const take = (table: unknown) => {
    if (table === null || typeof table !== "object") return;
    for (const [key, spec] of Object.entries(table as Record<string, unknown>)) {
      const pkg = spec !== null && typeof spec === "object" ? (spec as Record<string, unknown>).package : undefined;
      if (typeof pkg === "string" && pkg !== "" && !out.has(key)) out.set(key, pkg);
    }
  };
  take(doc.dependencies);
  take(doc["build-dependencies"]);
  const target = doc.target;
  if (target !== null && typeof target === "object") {
    for (const cfg of Object.values(target as Record<string, unknown>)) {
      if (cfg === null || typeof cfg !== "object") continue;
      take((cfg as Record<string, unknown>).dependencies);
      take((cfg as Record<string, unknown>)["build-dependencies"]);
    }
  }
  return out;
}

/** Dependencies with the line that declares them, in file order, one import per crate. */
export function cargoImports(text: string, doc: Record<string, unknown>): RawImport[] {
  const renamed = renames(doc);
  const imports: RawImport[] = [];
  const seen = new Set<string>();
  const add = (key: string, line: number) => {
    const name = renamed.get(key) ?? key;
    if (seen.has(name)) return;
    seen.add(name);
    imports.push({ specifier: name, kind: "static", line });
  };
  let inDeps = false;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\s*\[\[/.test(line)) {
      inDeps = false;
      continue;
    }
    const header = HEADER.exec(line);
    if (header) {
      const name = normalizeHeader(header[1] as string);
      inDeps = isDependencyTable(name);
      // [dependencies.serde] declares serde in a table of its own.
      const dot = name.lastIndexOf(".");
      if (!inDeps && dot > 0 && isDependencyTable(name.slice(0, dot))) add(name.slice(dot + 1).replace(/^["']|["']$/g, ""), i + 1);
      continue;
    }
    if (!inDeps) continue;
    const key = KEY.exec(line);
    if (key) add((key[1] ?? key[2] ?? key[3]) as string, i + 1);
  }
  return imports;
}

export function analyzeCargoManifest(path: string, text: string, contentId: string): FileFacts {
  const base: FileFacts = {
    path,
    language: "cargo",
    contentId,
    loc: text.split("\n").filter((l) => l.trim() !== "").length,
    imports: [],
    exports: [],
    starExports: [],
    dynamicImports: [],
    writes: [],
  };
  let doc: Record<string, unknown>;
  try {
    doc = Bun.TOML.parse(text) as Record<string, unknown>;
  } catch (error) {
    return { ...base, parseError: `invalid TOML: ${(error as Error).message}` };
  }
  return { ...base, imports: cargoImports(text, doc) };
}
