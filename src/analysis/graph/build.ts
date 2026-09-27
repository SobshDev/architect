// Builds the file dependency graph and its coverage, with three caches under cacheDir:
//  - facts: content-addressed per-file facts, shared by worktree and git builds;
//  - worktree: the last working-tree graph with per-file stamps, updated incrementally;
//  - commits: finished graphs keyed by commit sha.
//
// Incremental resolution trade-off: when configs, settings, and analyzers are unchanged, a warm build
// re-resolves only imports of changed files, imports that were unresolved, and imports that pointed at
// deleted files. A new file that shadows an existing resolution (for example "./a.ts" appearing next to
// a resolved "./a/index.ts") is only picked up on a config change or a cold build.
//
// Write sites (state ownership) depend on architecture.resources, so a hash of the resources with write
// matchers goes into the settings hash (worktree and commit caches) and into the facts key.
import type {
  Architecture,
  Coverage,
  Edge,
  EdgeTarget,
  FileFacts,
  FileSource,
  Graph,
  ImportResolver,
  LanguageAnalyzer,
  RawImport,
  Resource,
  WorkspacePackage,
} from "../../model/index.ts";
import { ComponentIndex, contentId, fingerprint } from "../../model/index.ts";
import { findWrites } from "../state/index.ts";
import type { CommitCache, StoredFacts, WorktreeCache } from "./cache.ts";
import {
  CACHE_FORMAT,
  FactsStore,
  commitCachePath,
  factsCachePath,
  readCache,
  stableStringify,
  worktreeCachePath,
  writeCache,
} from "./cache.ts";
import { extensionOf, selectFiles } from "./select.ts";
import { discoverWorkspaces } from "./workspaces.ts";

export interface BuildGraphOptions {
  /** Absolute cache directory, usually <root>/.architect/cache. Omit to disable caching. */
  cacheDir?: string;
  /** Hook mode: re-analyze only these existing files on top of the cached worktree graph, without listing or stating the whole repo. */
  only?: readonly string[];
  /** Hook mode: files deleted since the cached graph. */
  deleted?: readonly string[];
  /** Defaults to the built-in analyzers. */
  analyzers?: readonly LanguageAnalyzer[];
}

export interface BuildGraphResult {
  graph: Graph;
  coverage: Coverage;
  stats: { files: number; parsed: number; reused: number; ms: number; cache: "none" | "cold" | "warm" };
}

type CacheState = BuildGraphResult["stats"]["cache"];

/** Files whose stamps decide whether every import must be resolved again. */
const CONFIG_FILE = /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|package\.json|pnpm-workspace\.yaml|pyproject\.toml|setup\.cfg)$/;
const BATCH = 256;

interface Context {
  source: FileSource;
  architecture: Architecture;
  analyzers: readonly LanguageAnalyzer[];
  byExtension: Map<string, LanguageAnalyzer>;
  extensions: string[];
  versions: Record<string, string>;
  settingsHash: string;
  /** Resources with write matchers; empty when no file needs a write scan. */
  writeResources: readonly Resource[];
  /** Hash of writeResources, or "" when there are none. */
  resourcesHash: string;
}

interface Built {
  graph: Graph;
  parsed: number;
  cache: CacheState;
}

const preparing = new WeakMap<LanguageAnalyzer, Promise<void>>();

/** Runs an analyzer's one-time async setup, only when a file of its language actually has to be parsed. */
function prepared(analyzer: LanguageAnalyzer): Promise<void> {
  if (analyzer.prepare === undefined) return Promise.resolve();
  let done = preparing.get(analyzer);
  if (done === undefined) {
    done = analyzer.prepare();
    preparing.set(analyzer, done);
  }
  return done;
}

/** Builds the graph with the given analyzers. index.ts supplies the built-in ones by default. */
export async function buildGraphWith(
  analyzers: readonly LanguageAnalyzer[],
  source: FileSource,
  architecture: Architecture,
  options: Omit<BuildGraphOptions, "analyzers"> = {},
): Promise<BuildGraphResult> {
  const started = performance.now();
  const ctx = context(analyzers, source, architecture);
  const { cacheDir } = options;
  let built: Built;
  if (source.revision !== undefined) built = await buildCommit(ctx, source.revision, cacheDir);
  else if (cacheDir && (options.only !== undefined || options.deleted !== undefined))
    built = await buildHook(ctx, cacheDir, [...(options.only ?? []), ...(options.deleted ?? [])]);
  else built = await buildWorktree(ctx, cacheDir);
  const files = built.graph.files.length;
  return {
    graph: built.graph,
    coverage: computeCoverage(built.graph, architecture),
    stats: { files, parsed: built.parsed, reused: files - built.parsed, ms: Math.round(performance.now() - started), cache: built.cache },
  };
}

function context(analyzers: readonly LanguageAnalyzer[], source: FileSource, architecture: Architecture): Context {
  const byExtension = new Map<string, LanguageAnalyzer>();
  const versions: Record<string, string> = {};
  for (const analyzer of analyzers) {
    versions[analyzer.id] = analyzer.version;
    for (const ext of analyzer.extensions) if (!byExtension.has(ext.toLowerCase())) byExtension.set(ext.toLowerCase(), analyzer);
  }
  const writeResources = architecture.resources.filter((r) => r.writes.length > 0);
  // Only ids and matchers change which lines count as writes; owners and descriptions do not.
  const resourcesHash =
    writeResources.length === 0 ? "" : fingerprint([stableStringify(writeResources.map((r) => ({ id: r.id, writes: r.writes })))]);
  // Compile the matchers now, so an invalid pattern fails before any work.
  findWrites("", "typescript", writeResources);
  return {
    source,
    architecture,
    analyzers,
    byExtension,
    extensions: [...byExtension.keys()],
    versions,
    settingsHash: fingerprint([stableStringify(architecture.settings), ...(resourcesHash === "" ? [] : [resourcesHash])]),
    writeResources,
    resourcesHash,
  };
}

function analyzerOf(ctx: Context, path: string): LanguageAnalyzer {
  const analyzer = ctx.byExtension.get(extensionOf(path));
  if (!analyzer) throw new Error(`no analyzer for ${path}`);
  return analyzer;
}

function compatible(ctx: Context, cache: { analyzers: Record<string, string>; settings: string } | null): boolean {
  return cache !== null && cache.settings === ctx.settingsHash && stableStringify(cache.analyzers) === stableStringify(ctx.versions);
}

// ---------------------------------------------------------------- modes

/** Full build of the working tree (or any source without a revision), reusing the worktree cache when present. */
async function buildWorktree(ctx: Context, cacheDir: string | undefined): Promise<Built> {
  const { source, architecture } = ctx;
  const listed = await source.listFiles();
  const selected = selectFiles(listed, architecture.settings, ctx.extensions);
  if (!cacheDir) {
    const workspaces = await discoverWorkspaces(source, listed);
    const { facts, parsed } = await extractFacts(ctx, selected, null);
    const edges = await resolveImports(ctx, listed, workspaces, [...facts.values()]);
    return { graph: assemble(facts, edges, workspaces), parsed, cache: "none" };
  }

  const loaded = await readCache<WorktreeCache>(worktreeCachePath(cacheDir), "worktree");
  const prev = compatible(ctx, loaded) ? loaded : null;
  const [stamps, configs] = await Promise.all([stampAll(source, selected), stampAll(source, listed.filter((f) => CONFIG_FILE.test(f)))]);
  const configsSame = prev !== null && stableStringify(prev.configs) === stableStringify(configs);
  const workspaces = configsSame ? prev.graph.workspaces : await discoverWorkspaces(source, listed);

  const facts = new Map<string, FileFacts>();
  const fresh: string[] = [];
  const cachedFacts = new Map(prev?.graph.files.map((f) => [f.path, f]));
  for (const path of selected) {
    const old = cachedFacts.get(path);
    if (old && stamps[path] !== undefined && prev?.stamps[path] === stamps[path]) facts.set(path, old);
    else fresh.push(path);
  }
  const store = new FactsStore(factsCachePath(cacheDir));
  const extracted = await extractFacts(ctx, fresh, store);
  for (const [path, f] of extracted.facts) facts.set(path, f);

  let edges: Edge[];
  if (!prev || !configsSame) {
    edges = await resolveImports(ctx, listed, workspaces, [...facts.values()]);
  } else {
    const listedSet = new Set(listed);
    const removed = new Set(prev.files.filter((f) => !listedSet.has(f)));
    edges = await updateEdges(ctx, listed, workspaces, facts, prev.graph.edges, new Set(fresh), removed);
  }
  const graph = assemble(facts, edges, workspaces);

  const unchanged = prev !== null && configsSame && fresh.length === 0 && stableStringify(prev.files) === stableStringify(listed);
  if (!unchanged) {
    const kept: Record<string, string> = {};
    for (const path of facts.keys()) {
      const stamp = stamps[path];
      // No stamp for unreadable files, so the next build tries them again.
      if (stamp !== undefined && !extracted.unreadable.has(path)) kept[path] = stamp;
    }
    await saveWorktree(ctx, cacheDir, { files: listed, stamps: kept, configs, graph });
  }
  await store.save();
  return { graph, parsed: extracted.parsed, cache: prev ? "warm" : "cold" };
}

/** A source read from git objects: its content never changes, so the finished graph is cached by sha. */
async function buildCommit(ctx: Context, revision: string, cacheDir: string | undefined): Promise<Built> {
  const { source, architecture } = ctx;
  const path = cacheDir ? commitCachePath(cacheDir, revision) : null;
  if (path) {
    const cached = await readCache<CommitCache>(path, "commit");
    if (cached && cached.revision === revision && compatible(ctx, cached)) return { graph: cached.graph, parsed: 0, cache: "warm" };
  }
  const listed = await source.listFiles();
  const selected = selectFiles(listed, architecture.settings, ctx.extensions);
  const workspaces = await discoverWorkspaces(source, listed);
  // Git sources stamp files with their blob sha, which is exactly contentId, so cached facts need no read.
  const ids = cacheDir ? await stampAll(source, selected) : {};
  const store = cacheDir ? new FactsStore(factsCachePath(cacheDir)) : null;
  const { facts, parsed } = await extractFacts(ctx, selected, store, ids);
  const edges = await resolveImports(ctx, listed, workspaces, [...facts.values()]);
  const graph = assemble(facts, edges, workspaces);
  if (path && store) {
    const entry: CommitCache = { format: CACHE_FORMAT, kind: "commit", revision, analyzers: ctx.versions, settings: ctx.settingsHash, graph };
    await writeCache(path, entry);
    await store.save();
  }
  return { graph, parsed, cache: path ? "cold" : "none" };
}

/** Updates the cached worktree graph for a few touched paths without listing or stating the whole repo. */
async function buildHook(ctx: Context, cacheDir: string, touchedPaths: readonly string[]): Promise<Built> {
  const { source, architecture } = ctx;
  const loaded = await readCache<WorktreeCache>(worktreeCachePath(cacheDir), "worktree");
  const touched = [...new Set(touchedPaths)].sort();
  // A config edit can change any resolution; the full build notices it through the config stamps.
  if (!loaded || !compatible(ctx, loaded) || touched.some((p) => CONFIG_FILE.test(p))) return buildWorktree(ctx, cacheDir);
  const prev = loaded;

  const stamps = await stampAll(source, touched);
  const listedSet = new Set(prev.files);
  const present: string[] = [];
  const removed = new Set<string>();
  for (const path of touched) {
    if (stamps[path] === undefined) {
      if (listedSet.delete(path)) removed.add(path);
    } else {
      listedSet.add(path);
      present.push(path);
    }
  }
  const listed = [...listedSet].sort();

  const facts = new Map(prev.graph.files.map((f) => [f.path, f]));
  const nextStamps = { ...prev.stamps };
  for (const path of removed) {
    facts.delete(path);
    delete nextStamps[path];
  }
  const fresh = selectFiles(present, architecture.settings, ctx.extensions).filter(
    (p) => !(facts.has(p) && prev.stamps[p] === stamps[p]),
  );
  for (const path of fresh) {
    facts.delete(path);
    delete nextStamps[path];
  }
  const extracted = await extractFacts(ctx, fresh, null);
  for (const [path, f] of extracted.facts) {
    facts.set(path, f);
    if (!extracted.unreadable.has(path)) nextStamps[path] = stamps[path] as string;
  }

  const edges = await updateEdges(ctx, listed, prev.graph.workspaces, facts, prev.graph.edges, new Set(fresh), removed);
  // The cached file list misses files created or restored outside hooks (a shell command, git checkout), so an
  // import of such a file looks unresolved here. Relisting the repository tells; a full build runs only when the
  // listing changed, so imports that never resolve keep the fast path.
  const edited = new Set(fresh);
  if (edges.some((edge) => edited.has(edge.from) && missingTarget(edge)) && !sameList(await source.listFiles(), listed)) {
    return buildWorktree(ctx, cacheDir);
  }
  const graph = assemble(facts, edges, prev.graph.workspaces);
  await saveWorktree(ctx, cacheDir, { files: listed, stamps: nextStamps, configs: prev.configs, graph });
  return { graph, parsed: extracted.parsed, cache: "warm" };
}

async function saveWorktree(ctx: Context, cacheDir: string, data: Pick<WorktreeCache, "files" | "stamps" | "configs" | "graph">): Promise<void> {
  const entry: WorktreeCache = { format: CACHE_FORMAT, kind: "worktree", analyzers: ctx.versions, settings: ctx.settingsHash, ...data };
  await writeCache(worktreeCachePath(cacheDir), entry);
}

// ---------------------------------------------------------------- steps

/** Stamps of the paths that exist, in batches. */
async function stampAll(source: FileSource, paths: readonly string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (let i = 0; i < paths.length; i += BATCH) {
    const batch = paths.slice(i, i + BATCH);
    const stamps = await Promise.all(batch.map((p) => source.stamp(p)));
    batch.forEach((p, j) => {
      const stamp = stamps[j];
      if (stamp !== null && stamp !== undefined) out[p] = stamp;
    });
  }
  return out;
}

/**
 * Facts for the paths, from the content-addressed store when possible. knownIds maps paths to their
 * contentId when the source already knows it (git blobs), which skips reading cached files.
 * Missing and binary paths are left out. Paths that exist but cannot be read get empty facts with a
 * parseError such as "unreadable: EACCES"; they are listed in `unreadable` and never stored.
 */
async function extractFacts(
  ctx: Context,
  paths: readonly string[],
  store: FactsStore | null,
  knownIds: Record<string, string> = {},
): Promise<{ facts: Map<string, FileFacts>; parsed: number; unreadable: Set<string> }> {
  const facts = new Map<string, FileFacts>();
  const unreadable = new Set<string>();
  let parsed = 0;
  const toRead: string[] = [];
  for (const path of paths) {
    const id = knownIds[path];
    const hit = store && id && /^[0-9a-f]{40}$/.test(id) ? await store.get(factsKey(ctx, analyzerOf(ctx, path), id)) : undefined;
    if (hit) facts.set(path, withPath(path, hit));
    else toRead.push(path);
  }
  for (let i = 0; i < toRead.length; i += BATCH) {
    const batch = toRead.slice(i, i + BATCH);
    const texts = await ctx.source.readFiles(batch);
    for (const path of batch) {
      if (texts.has(path)) continue;
      const message = await readFailure(ctx.source, path);
      if (message === null) continue;
      const fallback = analyzerOf(ctx, path);
      await prepared(fallback);
      const empty = withPath(path, fallback.analyze(path, "", contentId("")));
      facts.set(path, { ...empty, parseError: message });
      unreadable.add(path);
    }
    for (const [path, text] of texts) {
      const analyzer = analyzerOf(ctx, path);
      const id = contentId(text);
      const key = factsKey(ctx, analyzer, id);
      const hit = store ? await store.get(key) : undefined;
      if (hit) {
        facts.set(path, withPath(path, hit));
        continue;
      }
      await prepared(analyzer);
      const result = withPath(path, analyzer.analyze(path, text, id));
      if (ctx.writeResources.length > 0) result.writes = findWrites(text, result.language, ctx.writeResources);
      parsed++;
      facts.set(path, result);
      if (store) {
        const { path: _path, ...stored } = result;
        store.set(key, stored);
      }
    }
  }
  return { facts, parsed, unreadable };
}

/** Why a path left out of readFiles cannot be read ("unreadable: EACCES"), or null when it is just missing or binary. */
async function readFailure(source: FileSource, path: string): Promise<string | null> {
  try {
    await source.readFile(path);
    return null;
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return `unreadable: ${typeof code === "string" ? code : (error as Error).message}`;
  }
}

function factsKey(ctx: Context, analyzer: LanguageAnalyzer, id: string): string {
  const writes = ctx.resourcesHash === "" ? "" : `+w${ctx.resourcesHash}`;
  return `${analyzer.id}@${analyzer.version}${writes}:${id}`;
}

/** Facts with path first, so cached and fresh facts serialize identically. */
function withPath(path: string, facts: StoredFacts | FileFacts): FileFacts {
  const { path: _path, ...rest } = facts as FileFacts;
  return { path, ...rest };
}

/** Keeps cached edges of untouched files and re-resolves changed files, unresolved imports, and imports of removed files. */
async function updateEdges(
  ctx: Context,
  listed: readonly string[],
  workspaces: readonly WorkspacePackage[],
  facts: ReadonlyMap<string, FileFacts>,
  previous: readonly Edge[],
  changed: ReadonlySet<string>,
  removed: ReadonlySet<string>,
): Promise<Edge[]> {
  const redo = new Set(changed);
  for (const edge of previous) if (missingTarget(edge) || (edge.to !== undefined && removed.has(edge.to))) redo.add(edge.from);
  const kept = previous.filter((e) => facts.has(e.from) && !redo.has(e.from));
  const again = [...redo].flatMap((path) => facts.get(path) ?? []);
  return [...kept, ...(await resolveImports(ctx, listed, workspaces, again))];
}

/** An import whose file was not found: unresolved, or into a workspace package without a matching file (pkg/missing). */
function missingTarget(edge: Edge): boolean {
  return edge.unresolved === true || (edge.workspace !== undefined && edge.to === undefined);
}

/** True when two sorted path lists are equal. */
function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((path, i) => path === b[i]);
}

async function resolveImports(
  ctx: Context,
  listed: readonly string[],
  workspaces: readonly WorkspacePackage[],
  facts: readonly FileFacts[],
): Promise<Edge[]> {
  const resolvers = new Map<string, ImportResolver>();
  const edges: Edge[] = [];
  for (const file of facts) {
    if (file.imports.length === 0) continue;
    const analyzer = analyzerOf(ctx, file.path);
    let resolver = resolvers.get(analyzer.id);
    if (!resolver) {
      resolver = await analyzer.createResolver({ source: ctx.source, files: listed, workspaces, settings: ctx.architecture.settings });
      resolvers.set(analyzer.id, resolver);
    }
    for (const raw of file.imports) {
      for (const target of resolver.resolve(file.path, raw)) edges.push(makeEdge(file.path, raw, analyzer, target));
    }
  }
  return edges;
}

/** Fixed key order, so edges serialize identically however they were produced. */
function makeEdge(from: string, raw: RawImport, analyzer: LanguageAnalyzer, target: EdgeTarget): Edge {
  return {
    from,
    ...(target.to !== undefined && { to: target.to }),
    ...(target.workspace !== undefined && { workspace: target.workspace }),
    ...(target.package !== undefined && { package: target.package }),
    ...(target.builtin !== undefined && { builtin: target.builtin }),
    specifier: raw.specifier,
    kind: raw.kind,
    line: raw.line,
    analyzer: analyzer.id,
    ...(target.unresolved !== undefined && { unresolved: target.unresolved }),
  };
}

function cmp(a: string | undefined, b: string | undefined): number {
  const x = a ?? "";
  const y = b ?? "";
  return x < y ? -1 : x > y ? 1 : 0;
}

function compareEdges(a: Edge, b: Edge): number {
  return (
    cmp(a.from, b.from) ||
    a.line - b.line ||
    cmp(a.specifier, b.specifier) ||
    cmp(a.to, b.to) ||
    cmp(a.workspace, b.workspace) ||
    cmp(a.package, b.package) ||
    cmp(a.kind, b.kind)
  );
}

function assemble(facts: ReadonlyMap<string, FileFacts>, edges: Edge[], workspaces: readonly WorkspacePackage[]): Graph {
  return {
    version: 1,
    files: [...facts.values()].sort((a, b) => cmp(a.path, b.path)),
    edges: edges.sort(compareEdges),
    workspaces: [...workspaces],
  };
}

/** What the graph covers and what it could not see, every list sorted. */
export function computeCoverage(graph: Graph, architecture: Architecture): Coverage {
  const index = new ComponentIndex(architecture.components, graph.workspaces);
  const counts = new Map<string, number>();
  const unmapped: string[] = [];
  const dynamic: Coverage["dynamic_imports"] = [];
  const parseErrors: Coverage["parse_errors"] = [];
  for (const file of graph.files) {
    counts.set(file.language, (counts.get(file.language) ?? 0) + 1);
    if (index.of(file.path) === null) unmapped.push(file.path);
    for (const d of file.dynamicImports) dynamic.push({ file: file.path, line: d.line, expression: d.expression });
    if (file.parseError !== undefined) parseErrors.push({ file: file.path, message: file.parseError });
  }
  const languages: Record<string, number> = {};
  for (const lang of [...counts.keys()].sort()) languages[lang] = counts.get(lang) as number;
  const unresolved = graph.edges
    .filter(missingTarget)
    .map((e) => ({ file: e.from, line: e.line, specifier: e.specifier }))
    .sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.specifier, b.specifier));
  return {
    files_analyzed: graph.files.length,
    languages,
    unmapped_files: unmapped,
    unresolved_imports: unresolved,
    dynamic_imports: dynamic.sort((a, b) => cmp(a.file, b.file) || a.line - b.line || cmp(a.expression, b.expression)),
    parse_errors: parseErrors,
  };
}
