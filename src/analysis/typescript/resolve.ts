// Resolves TypeScript and JavaScript import specifiers to repo files, workspace packages, or external packages.
// Everything reads from preloaded data, so a worktree and a git commit with the same files resolve identically.
import { builtinModules } from "node:module";
import { posix } from "node:path";
import ts from "typescript";
import type { EdgeTarget, ImportResolver, RawImport, ResolverInput, WorkspacePackage } from "../../model/index.ts";
import { dirOf, globMatcher, toRepoPath } from "../../model/index.ts";

/** Node built-ins importable without the "node:" prefix. Prefix-only modules (node:test) are excluded. */
const BUILTINS = new Set(builtinModules.filter((name) => !name.startsWith("node:") && !name.startsWith("bun")));
/** Package "exports" conditions, in priority order. */
const CONDITIONS = ["types", "bun", "import", "module", "node", "require", "default"];
const BUILD_DIRS = new Set(["dist", "build", "lib", "out"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const PROBE_EXTENSIONS = [...SOURCE_EXTENSIONS, ".d.ts", ".json"];
const JS_TO_TS: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
const CONFIG_FILE = /^(tsconfig[^/]*|jsconfig)\.json$/;
const MAX_REFERENCE_DEPTH = 5;

type Json = Record<string, unknown>;

interface ParsedConfig {
  options: ts.CompilerOptions;
  /** Repo-relative paths of referenced tsconfig files. */
  references: string[];
  /** files: [] plus references: a root that only groups other projects. */
  solution: boolean;
}

interface Context {
  key: string;
  options: ts.CompilerOptions;
  nodeModes: boolean;
  cache: ts.ModuleResolutionCache;
  pathPatterns: string[];
  /** Repo-relative folder that "paths" substitutions are relative to, or null when outside the repo. */
  pathsBase: string | null;
}

export function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") && parts.length > 1 ? parts[0] + "/" + parts[1] : (parts[0] ?? specifier);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function inNodeModules(path: string): boolean {
  return path.startsWith("node_modules/") || path.includes("/node_modules/");
}

function isRelative(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/");
}

/** Drops a bundler query or hash suffix: "./worker.ts?worker&url" and "./a.svg#icon" name "./worker.ts" and "./a.svg". A leading "#" (subpath import) stays. */
function withoutQuery(specifier: string): string {
  const cut = specifier.slice(1).search(/[?#]/);
  return cut < 0 ? specifier : specifier.slice(0, cut + 1);
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesPattern(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (specifier.length < prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function builtinTarget(specifier: string): EdgeTarget | null {
  if (specifier === "bun" || specifier.startsWith("bun:")) return { package: specifier, builtin: true };
  if (specifier.startsWith("node:")) return { package: "node:" + specifier.slice(5).split("/")[0], builtin: true };
  if (BUILTINS.has(specifier)) return { package: "node:" + specifier.split("/")[0], builtin: true };
  return null;
}

/** Targets of a package "exports" field for one subpath ("." or "./x"), in condition priority order. */
export function exportTargets(exports: unknown, subpath: string): string[] {
  const map: Json | null =
    typeof exports === "string" || Array.isArray(exports) || (isObject(exports) && !Object.keys(exports).some((k) => k.startsWith(".")))
      ? { ".": exports }
      : isObject(exports)
        ? exports
        : null;
  if (!map) return [];
  if (Object.hasOwn(map, subpath)) return conditionTargets(map[subpath], null);
  let best: string | null = null;
  let captured = "";
  for (const key of Object.keys(map)) {
    const star = key.indexOf("*");
    if (star < 0) continue;
    const match = matchesPattern(key, subpath);
    if (match === null) continue;
    const bestStar = best?.indexOf("*") ?? -1;
    if (best === null || star > bestStar || (star === bestStar && key.length > best.length)) {
      best = key;
      captured = match;
    }
  }
  return best === null ? [] : conditionTargets(map[best], captured);
}

function conditionTargets(target: unknown, captured: string | null): string[] {
  if (typeof target === "string") return [captured === null ? target : target.replaceAll("*", captured)];
  if (Array.isArray(target)) return target.flatMap((t) => conditionTargets(t, captured));
  if (isObject(target)) return CONDITIONS.filter((c) => Object.hasOwn(target, c)).flatMap((c) => conditionTargets(target[c], captured));
  return [];
}

export async function createTypeScriptResolver(input: ResolverInput): Promise<ImportResolver> {
  const root = input.source.root.replace(/\/+$/, "");
  const toAbsolute = (path: string) => (path === "" ? root : root + "/" + path);
  const toRelative = (path: string): string | null => {
    if (path === root) return "";
    return path.startsWith(root + "/") ? toRepoPath(path.slice(root.length + 1)) : null;
  };

  const files = new Set(input.files);
  const dirs = new Set<string>([""]);
  for (const file of input.files) {
    for (let dir = dirOf(file); !dirs.has(dir); dir = dirOf(dir)) dirs.add(dir);
  }
  const workspaces = new Map<string, WorkspacePackage>(input.workspaces.map((w) => [w.name, w]));

  // ------------------------------------------------------------ preload

  const texts = new Map<string, string>();
  const extraDirs = new Set<string>();
  const configFiles = input.files.filter((f) => !inNodeModules(f) && CONFIG_FILE.test(baseName(f)));
  const packageFiles = input.files.filter((f) => !inNodeModules(f) && baseName(f) === "package.json");
  for (const [path, text] of await input.source.readFiles([...configFiles, ...packageFiles])) texts.set(path, text);

  const ensureText = async (path: string): Promise<boolean> => {
    if (texts.has(path)) return true;
    if (path === "" || path.startsWith("../")) return false;
    const text = await input.source.readFile(path);
    if (text === null) return false;
    texts.set(path, text);
    for (let dir = dirOf(path); !extraDirs.has(dir) && !dirs.has(dir); dir = dirOf(dir)) extraDirs.add(dir);
    return true;
  };

  const rawConfigs = new Map<string, Json>();
  const rawConfig = (path: string): Json => {
    let raw = rawConfigs.get(path);
    if (!raw) {
      const parsed = ts.parseConfigFileTextToJson(toAbsolute(path), texts.get(path) ?? "{}").config as unknown;
      raw = isObject(parsed) ? parsed : {};
      rawConfigs.set(path, raw);
    }
    return raw;
  };

  const locateExtends = async (dir: string, specifier: string): Promise<string | null> => {
    if (isRelative(specifier)) {
      const path = specifier.startsWith("/") ? toRelative(specifier) : toRepoPath(posix.join(dir, specifier));
      if (path === null) return null;
      for (const candidate of path.endsWith(".json") ? [path] : [path, path + ".json"]) if (await ensureText(candidate)) return candidate;
      return null;
    }
    for (let d = dir; ; d = dirOf(d)) {
      const modules = posix.join(d, "node_modules");
      await ensureText(posix.join(modules, packageName(specifier), "package.json"));
      const base = posix.join(modules, specifier);
      for (const candidate of [base, base + ".json", base + "/tsconfig.json"]) if (await ensureText(candidate)) return candidate;
      if (d === "") return null;
    }
  };

  const referencePath = (dir: string, path: string): string => {
    const joined = toRepoPath(posix.join(dir, path));
    return joined.endsWith(".json") ? joined : posix.join(joined, "tsconfig.json");
  };

  const queue = configFiles.filter((f) => texts.has(f));
  const seen = new Set(queue);
  while (queue.length > 0) {
    const path = queue.shift() as string;
    const raw = rawConfig(path);
    const dir = dirOf(path);
    const parents = typeof raw.extends === "string" ? [raw.extends] : Array.isArray(raw.extends) ? raw.extends : [];
    const next: string[] = [];
    for (const parent of parents) {
      if (typeof parent !== "string") continue;
      const found = await locateExtends(dir, parent);
      if (found) next.push(found);
    }
    for (const ref of Array.isArray(raw.references) ? raw.references : []) {
      if (!isObject(ref) || typeof ref.path !== "string") continue;
      const found = referencePath(dir, ref.path);
      if (await ensureText(found)) next.push(found);
    }
    for (const found of next) {
      if (!seen.has(found)) {
        seen.add(found);
        queue.push(found);
      }
    }
  }

  // ------------------------------------------------------------ hosts

  const parseHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: true,
    readDirectory: () => [],
    fileExists: (path) => {
      const rel = toRelative(path);
      return rel !== null && texts.has(rel);
    },
    readFile: (path) => {
      const rel = toRelative(path);
      return rel === null ? undefined : texts.get(rel);
    },
    directoryExists: (path) => {
      const rel = toRelative(path);
      return rel !== null && (dirs.has(rel) || extraDirs.has(rel));
    },
  };

  const moduleHost: ts.ModuleResolutionHost = {
    fileExists: (path) => {
      const rel = toRelative(path);
      return rel !== null && files.has(rel);
    },
    readFile: (path) => {
      const rel = toRelative(path);
      return rel !== null && files.has(rel) ? texts.get(rel) : undefined;
    },
    directoryExists: (path) => {
      const rel = toRelative(path);
      return rel !== null && dirs.has(rel);
    },
    realpath: (path) => path,
    getCurrentDirectory: () => root,
    useCaseSensitiveFileNames: true,
  };

  // ------------------------------------------------------------ configs

  const extendedConfigCache = new Map<string, ts.ExtendedConfigCacheEntry>();
  const parsedConfigs = new Map<string, ParsedConfig>();
  const parseConfig = (path: string): ParsedConfig => {
    let parsed = parsedConfigs.get(path);
    if (parsed) return parsed;
    const raw = rawConfig(path);
    const result = ts.parseJsonConfigFileContent(raw, parseHost, toAbsolute(dirOf(path)), undefined, toAbsolute(path), undefined, undefined, extendedConfigCache);
    const references: string[] = [];
    for (const ref of result.projectReferences ?? []) {
      const rel = toRelative(ref.path);
      if (rel !== null) references.push(rel.endsWith(".json") ? rel : posix.join(rel, "tsconfig.json"));
    }
    const emptyFiles = Array.isArray(raw.files) && raw.files.length === 0;
    const emptyInclude = raw.files === undefined && Array.isArray(raw.include) && raw.include.length === 0;
    parsed = { options: result.options, references, solution: (emptyFiles || emptyInclude) && references.length > 0 };
    parsedConfigs.set(path, parsed);
    return parsed;
  };

  const tsconfigSetting = input.settings.tsconfig;
  const allowed = tsconfigSetting === undefined ? null : globMatcher(typeof tsconfigSetting === "string" ? [tsconfigSetting] : tsconfigSetting);
  const configByDir = new Map<string, string>();
  for (const path of configFiles) {
    const name = baseName(path);
    if (allowed ? !allowed(path) : name !== "tsconfig.json" && name !== "jsconfig.json") continue;
    const dir = dirOf(path);
    const current = configByDir.get(dir);
    // Prefer tsconfig.json over other names in the same folder, then the first by path.
    if (current === undefined || (name === "tsconfig.json" && baseName(current) !== "tsconfig.json")) configByDir.set(dir, path);
  }

  const nearestConfig = new Map<string, string | null>();
  const configFor = (dir: string): string | null => {
    const cached = nearestConfig.get(dir);
    if (cached !== undefined) return cached;
    const found = configByDir.get(dir) ?? (dir === "" ? null : configFor(dirOf(dir)));
    nearestConfig.set(dir, found);
    return found;
  };

  const contains = (dir: string, child: string) => dir === "" || child === dir || child.startsWith(dir + "/");
  const pickProject = (config: string, dir: string, depth: number): string => {
    const parsed = parseConfig(config);
    if (!parsed.solution || depth >= MAX_REFERENCE_DEPTH) return config;
    let best: string | null = null;
    for (const ref of parsed.references) {
      if (!texts.has(ref) || !contains(dirOf(ref), dir)) continue;
      if (best === null || dirOf(ref).length > dirOf(best).length) best = ref;
    }
    return best === null ? config : pickProject(best, dir, depth + 1);
  };

  const contexts = new Map<string, Context>();
  const contextByDir = new Map<string, Context>();
  const contextFor = (dir: string): Context => {
    const cached = contextByDir.get(dir);
    if (cached) return cached;
    const nearest = configFor(dir);
    const key = nearest === null ? "" : pickProject(nearest, dir, 0);
    let context = contexts.get(key);
    if (!context) {
      const options: ts.CompilerOptions = { ...(key === "" ? {} : parseConfig(key).options), allowJs: true, resolveJsonModule: true };
      options.moduleResolution = moduleResolutionOf(options);
      const base = options.baseUrl ?? (options as { pathsBasePath?: unknown }).pathsBasePath;
      context = {
        key,
        options,
        nodeModes: options.moduleResolution !== ts.ModuleResolutionKind.Bundler,
        cache: ts.createModuleResolutionCache(root, (s) => s, options),
        pathPatterns: Object.keys(options.paths ?? {}),
        pathsBase: typeof base === "string" ? toRelative(base) : null,
      };
      contexts.set(key, context);
    }
    contextByDir.set(dir, context);
    return context;
  };

  // ------------------------------------------------------------ module formats

  const packageTypes = new Map<string, boolean>();
  const isEsmPackage = (dir: string): boolean => {
    const cached = packageTypes.get(dir);
    if (cached !== undefined) return cached;
    const text = texts.get(posix.join(dir, "package.json"));
    let esm: boolean;
    if (text !== undefined) esm = parsePackage(text)?.type === "module";
    else esm = dir === "" ? false : isEsmPackage(dirOf(dir));
    packageTypes.set(dir, esm);
    return esm;
  };

  const resolutionMode = (from: string, raw: RawImport, context: Context): ts.ResolutionMode => {
    if (raw.kind === "require") return ts.ModuleKind.CommonJS;
    if (!context.nodeModes) return undefined;
    if (raw.kind === "dynamic") return ts.ModuleKind.ESNext;
    if (from.endsWith(".mts") || from.endsWith(".mjs")) return ts.ModuleKind.ESNext;
    if (from.endsWith(".cts") || from.endsWith(".cjs")) return ts.ModuleKind.CommonJS;
    return isEsmPackage(dirOf(from)) ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS;
  };

  // ------------------------------------------------------------ targets

  const internal = (path: string | null): string | null => (path !== null && files.has(path) && !inNodeModules(path) ? path : null);

  const tsResolve = (specifier: string, from: string, context: Context, mode: ts.ResolutionMode): string | null => {
    const result = ts.resolveModuleName(specifier, toAbsolute(from), context.options, moduleHost, context.cache, undefined, mode);
    const resolved = result.resolvedModule?.resolvedFileName;
    return resolved === undefined ? null : internal(toRelative(resolved));
  };

  /** Fallback for relative imports TypeScript rejects, such as extensionless imports in Node16 ESM files or CSS files. */
  const probe = (dir: string, specifier: string): string | null => {
    const base = specifier.startsWith("/") ? toRelative(specifier) : toRepoPath(posix.join(dir, specifier));
    if (base === null || base.startsWith("../")) return null;
    const candidates: string[] = [];
    const ext = posix.extname(base);
    for (const replacement of JS_TO_TS[ext] ?? []) candidates.push(base.slice(0, -ext.length) + replacement);
    for (const e of PROBE_EXTENSIONS) candidates.push(base + e);
    for (const e of PROBE_EXTENSIONS) candidates.push(base + "/index" + e);
    candidates.push(base);
    for (const candidate of candidates) if (internal(candidate)) return candidate;
    return null;
  };

  /** The "paths" pattern TypeScript would apply: an exact key first, then the longest prefix before "*". */
  const pathsMatch = (context: Context, specifier: string): { pattern: string; captured: string } | null => {
    let best: { pattern: string; captured: string } | null = null;
    for (const pattern of context.pathPatterns) {
      const captured = matchesPattern(pattern, specifier);
      if (captured === null) continue;
      if (!pattern.includes("*")) return { pattern, captured };
      if (best === null || pattern.indexOf("*") > best.pattern.indexOf("*")) best = { pattern, captured };
    }
    return best;
  };

  /** A listed file a "paths" substitution names, including non-code files such as "@/index.css" that TypeScript skips. */
  const pathsFile = (context: Context, match: { pattern: string; captured: string }): string | null => {
    if (context.pathsBase === null) return null;
    for (const substitution of context.options.paths?.[match.pattern] ?? []) {
      const found = probe(context.pathsBase, substitution.replace("*", match.captured));
      if (found) return found;
    }
    return null;
  };

  const packages = new Map<string, Json | null>();
  const packageJson = (dir: string): Json | null => {
    if (!packages.has(dir)) {
      const text = texts.get(posix.join(dir, "package.json"));
      packages.set(dir, text === undefined ? null : parsePackage(text));
    }
    return packages.get(dir) ?? null;
  };

  /** Maps a package target (possibly build output or a declaration file) to a listed source or asset file. */
  const mapToSource = (pkgDir: string, target: string): string | null => {
    const path = toRepoPath(posix.join(pkgDir, target));
    if (!contains(pkgDir, path)) return null;
    const inPackage = pkgDir === "" ? path : path.slice(pkgDir.length + 1);
    const declaration = /\.d\.[mc]?ts$/.test(path);
    const segments = inPackage.split("/");
    const build = segments.length > 1 && BUILD_DIRS.has(segments[0] as string);
    if (!declaration && !build && internal(path)) return path;
    const stem = (p: string) => p.replace(/(\.d)?\.[mc]?[jt]sx?$/, "");
    const stems = build ? [posix.join(pkgDir, "src", stem(segments.slice(1).join("/"))), posix.join(pkgDir, stem(segments.slice(1).join("/")))] : [stem(path)];
    for (const s of stems) {
      for (const e of SOURCE_EXTENSIONS) if (internal(s + e)) return s + e;
      for (const e of SOURCE_EXTENSIONS) if (internal(s + "/index" + e)) return s + "/index" + e;
    }
    return null;
  };

  const workspaceTarget = (workspace: WorkspacePackage, specifier: string): string | null => {
    const pkg = packageJson(workspace.dir) ?? {};
    const subpath = "." + specifier.slice(workspace.name.length);
    let targets: string[];
    if (pkg.exports !== undefined && pkg.exports !== null) targets = exportTargets(pkg.exports, subpath);
    else if (subpath === ".") targets = [pkg.module, pkg.main, pkg.types, pkg.typings, "./index", "./src/index"].filter((t): t is string => typeof t === "string");
    else targets = [subpath];
    for (const target of targets) {
      const mapped = mapToSource(workspace.dir, target);
      if (mapped) return mapped;
    }
    return null;
  };

  const classify = (from: string, raw: RawImport): EdgeTarget => {
    const specifier = withoutQuery(raw.specifier);
    const builtin = builtinTarget(specifier);
    if (builtin) return builtin;
    const dir = dirOf(from);
    const context = contextFor(dir);
    const mode = resolutionMode(from, raw, context);
    if (isRelative(specifier)) {
      const to = tsResolve(specifier, from, context, mode) ?? probe(dir, specifier);
      return to ? { to } : { unresolved: true };
    }
    const name = packageName(specifier);
    const workspace = workspaces.get(name);
    // Subpath imports ("#x") come from the importing package's "imports" field.
    if (specifier.startsWith("#")) {
      const to = tsResolve(specifier, from, context, mode);
      return to ? { to } : { unresolved: true };
    }
    if (context.pathPatterns.length > 0 || context.options.baseUrl !== undefined) {
      const to = tsResolve(specifier, from, context, mode);
      if (to) return workspace ? { to, workspace: name } : { to };
    }
    const alias = pathsMatch(context, specifier);
    if (alias) {
      const to = pathsFile(context, alias);
      if (to) return workspace ? { to, workspace: name } : { to };
    }
    if (workspace) {
      const to = workspaceTarget(workspace, specifier);
      return to ? { to, workspace: name } : { workspace: name };
    }
    // A named alias ("@/x", "~lib") that finds no file is unresolved. A catch-all pattern ("*", "*.js") also
    // covers every package import, so a miss there is the external package the specifier names.
    if (alias && !alias.pattern.startsWith("*")) return { unresolved: true };
    return { package: name };
  };

  const memo = new Map<string, EdgeTarget>();
  return {
    resolve(from: string, raw: RawImport): EdgeTarget[] {
      const context = contextFor(dirOf(from));
      const key = context.key + "\0" + from + "\0" + raw.kind + "\0" + raw.specifier;
      let target = memo.get(key);
      if (!target) {
        target = classify(from, raw);
        memo.set(key, target);
      }
      return [{ ...target }];
    },
  };
}

function moduleResolutionOf(options: ts.CompilerOptions): ts.ModuleResolutionKind {
  const kind = options.moduleResolution;
  if (kind === ts.ModuleResolutionKind.Bundler || kind === ts.ModuleResolutionKind.Node16 || kind === ts.ModuleResolutionKind.NodeNext) return kind;
  if (kind === undefined) {
    if (options.module === ts.ModuleKind.Node16 || options.module === ts.ModuleKind.Node18) return ts.ModuleResolutionKind.Node16;
    if (options.module === ts.ModuleKind.Node20 || options.module === ts.ModuleKind.NodeNext) return ts.ModuleResolutionKind.NodeNext;
  }
  return ts.ModuleResolutionKind.Bundler;
}

function parsePackage(text: string): Json | null {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}
