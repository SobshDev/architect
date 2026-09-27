// The dependency graph and the facts analyzers extract per file. Plain data, safe to cache as JSON.
import type { Settings } from "./schema.ts";
import type { FileSource } from "./source.ts";

export type Language = "typescript" | "javascript" | "python";
export type AnalyzerId = "typescript" | "python";
/** static: value import. type: type-only import. dynamic: import() or importlib. require: CommonJS require.
 *  reexport: export ... from. side-effect: import "x" with no bindings. */
export type EdgeKind = "static" | "type" | "dynamic" | "require" | "reexport" | "side-effect";

export const EDGE_KINDS: readonly EdgeKind[] = ["static", "type", "dynamic", "require", "reexport", "side-effect"];

/** An import as written in a file, before resolution. */
export interface RawImport {
  specifier: string;
  kind: EdgeKind;
  line: number;
  /** Imported names, when known. Python uses them to tell submodules from attributes. */
  names?: string[];
}

export type ExportKind = "function" | "class" | "interface" | "type" | "enum" | "variable" | "namespace" | "default" | "reexport";

/** One exported symbol with its declaration printed without bodies or initializers. */
export interface ExportedSymbol {
  name: string;
  kind: ExportKind;
  signature: string;
  line: number;
  /** Source specifier for re-exports (export { a } from "./x"). */
  from?: string;
  /** Original name for renamed re-exports (export { a as b } from "./x"). */
  original?: string;
}

/** A line that writes to a declared resource (state ownership). */
export interface WriteSite {
  line: number;
  resource: string;
  text: string;
}

/** Everything an analyzer learns from one file. Cached by contentId. */
export interface FileFacts {
  path: string;
  language: Language;
  /** Git blob sha or content hash; identical content gives an identical id. */
  contentId: string;
  /** Non-blank lines. */
  loc: number;
  imports: RawImport[];
  exports: ExportedSymbol[];
  /** Specifiers of export * from "...". */
  starExports: string[];
  /** Dynamic imports whose target is not a string literal. */
  dynamicImports: { line: number; expression: string }[];
  writes: WriteSite[];
  parseError?: string;
}

/** A resolved import. Exactly one of to, workspace (without to), or package describes the target;
 *  unresolved edges have none of them. */
export interface Edge {
  from: string;
  /** Repo-relative path of the resolved internal file. It may lie outside the analyzed set. */
  to?: string;
  /** Workspace package named by the specifier, when the import crossed into one. */
  workspace?: string;
  /** External package name (react, @scope/pkg, node:fs, requests). */
  package?: string;
  /** True for runtime built-ins (node:*, bun:*, Python stdlib). */
  builtin?: boolean;
  specifier: string;
  kind: EdgeKind;
  line: number;
  analyzer: AnalyzerId;
  /** A relative or aliased import that did not resolve to a file. */
  unresolved?: boolean;
}

export interface WorkspacePackage {
  name: string;
  /** Repo-relative directory without a trailing slash. */
  dir: string;
}

/** Where an import points, as found by a resolver. Unresolved relative or aliased imports set only unresolved. */
export type EdgeTarget = Pick<Edge, "to" | "workspace" | "package" | "builtin" | "unresolved">;

export interface ResolverInput {
  source: FileSource;
  /** Every file in the version being analyzed (not only the analyzed ones), sorted. */
  files: readonly string[];
  workspaces: readonly WorkspacePackage[];
  settings: Settings;
}

export interface ImportResolver {
  /** Targets of one import. TypeScript returns exactly one; Python may return one per imported submodule. */
  resolve(from: string, raw: RawImport): EdgeTarget[];
}

/** One language: fact extraction per file and import resolution across files. */
export interface LanguageAnalyzer {
  readonly id: AnalyzerId;
  /** Bump when extraction or resolution changes, so cached facts are recomputed. */
  readonly version: string;
  /** Lowercase file extensions with the dot, such as ".ts". */
  readonly extensions: readonly string[];
  /** Async setup (such as loading a parser's wasm) run once before the first analyze call. Must be idempotent. */
  prepare?(): Promise<void>;
  analyze(path: string, text: string, contentId: string): FileFacts;
  createResolver(input: ResolverInput): Promise<ImportResolver>;
}

export interface Graph {
  version: 1;
  /** Analyzed files, sorted by path. */
  files: FileFacts[];
  /** Sorted by from, line, specifier. */
  edges: Edge[];
  workspaces: WorkspacePackage[];
}

export interface ComponentEdge {
  from: string;
  to: string;
  count: number;
  kinds: EdgeKind[];
  /** Up to a few example edges, for evidence. */
  samples: { file: string; line: number; target: string }[];
}

export interface ComponentGraph {
  components: string[];
  edges: ComponentEdge[];
}

// ---------------------------------------------------------------- history

export interface CoChangePair {
  /** a sorts before b. */
  a: string;
  b: string;
  /** Commits that touched both. */
  support: number;
  /** support divided by the commits that touched the less frequently changed side. */
  confidence: number;
}

export interface Hotspot {
  path: string;
  /** Lines added plus deleted in the window. */
  churn: number;
  loc: number;
  score: number;
}

export interface HistorySummary {
  head: string;
  since: string;
  commits: number;
  filePairs: CoChangePair[];
  componentPairs: CoChangePair[];
  hotspots: Hotspot[];
}
