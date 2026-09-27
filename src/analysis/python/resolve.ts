// Resolves Python imports to repo files, standard library modules, or external packages.
// Everything reads from preloaded data (input.files and project files read through input.source),
// so a worktree and a git commit with the same files resolve identically.
//
// Namespace packages (directories of .py files without __init__.py) have no file. An import that names
// only a namespace package resolves to no target at all, so it adds no edge: it is found, so it is not
// unresolved, and the modules inside it get their own edges when they are imported.
import { posix } from "node:path";
import type { EdgeTarget, ImportResolver, RawImport, ResolverInput } from "../../model/index.ts";
import { dirOf, globMatcher, toRepoPath } from "../../model/index.ts";
import { STDLIB_MODULES } from "./stdlib.ts";

const PROJECT_FILES = new Set(["pyproject.toml", "setup.cfg", "setup.py"]);
/** Project files under these folders belong to dependencies or tooling, not to the repo's own projects. */
const IGNORED = /(^|\/)(node_modules|\.venv|venv|site-packages|\.tox|\.eggs|__pycache__)(\/|$)/;
const GLOB_CHARS = /[*?[\]{}!]/;

/** A found module: its file, or NAMESPACE for a namespace package. */
type Found = { file: string } | typeof NAMESPACE | null;
const NAMESPACE = "namespace" as const;

type Table = Record<string, unknown>;

function join(dir: string, rel: string): string {
  return dir === "" ? rel : rel === "" ? dir : `${dir}/${rel}`;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function table(value: unknown): Table {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Table) : {};
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** A small INI reader for setup.cfg: sections, "key = value" or "key: value", indented continuation lines, # and ; comments. */
export function parseIni(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let section: Map<string, string> | undefined;
  let key: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    if (/^\s/.test(raw) && section && key !== undefined) {
      section.set(key, `${section.get(key)}\n${trimmed}`);
      continue;
    }
    const header = /^\[(.+)\]$/.exec(trimmed);
    if (header) {
      const name = (header[1] as string).trim();
      section = sections.get(name) ?? new Map();
      sections.set(name, section);
      key = undefined;
      continue;
    }
    const match = /^([^=:]+)[=:](.*)$/.exec(trimmed);
    if (match && section) {
      key = (match[1] as string).trim();
      section.set(key, (match[2] as string).trim());
    }
  }
  return sections;
}

/** Source roots declared by one project, relative to the project directory, in priority order. */
function declaredRoots(pyproject: string | undefined, setupCfg: string | undefined): string[] {
  const roots: string[] = [];
  // package-dir maps a package to its folder; "" maps the root package. Other packages sit in their folder's parent.
  const packageDir = (key: string, value: string) => roots.push(key === "" ? value : posix.dirname(value));
  if (pyproject !== undefined) {
    let data: Table = {};
    try {
      data = table(Bun.TOML.parse(pyproject));
    } catch {
      // An invalid pyproject.toml declares nothing; the defaults still apply.
    }
    const tool = table(data.tool);
    const setuptools = table(tool.setuptools);
    roots.push(...strings(table(table(setuptools.packages).find).where));
    for (const [key, value] of Object.entries(table(setuptools["package-dir"]))) {
      if (typeof value === "string" && !key.includes(".")) packageDir(key, value);
    }
    const poetry = Array.isArray(table(tool.poetry).packages) ? (table(tool.poetry).packages as unknown[]) : [];
    for (const entry of poetry) roots.push(typeof table(entry).from === "string" ? (table(entry).from as string) : "");
    const wheel = table(table(table(table(tool.hatch).build).targets).wheel);
    for (const pkg of strings(wheel.packages)) roots.push(posix.dirname(pkg));
  }
  if (setupCfg !== undefined) {
    const ini = parseIni(setupCfg);
    for (const line of (ini.get("options")?.get("package_dir") ?? "").split("\n")) {
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (value !== "" && !key.includes(".")) packageDir(key, value);
    }
    roots.push(...(ini.get("options.packages.find")?.get("where") ?? "").split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== ""));
  }
  return roots;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

class PythonResolver implements ImportResolver {
  private readonly files: ReadonlySet<string>;
  /** Every folder that holds a .py file at any depth: the candidates for (namespace) packages. */
  private readonly packageDirs = new Set<string>();
  private readonly projectRoots = new Map<string, string[]>();
  private readonly configuredRoots: string[] | null;
  private readonly rootsByDir = new Map<string, string[]>();
  private readonly lookups = new Map<string, Found>();

  constructor(files: readonly string[], projects: Map<string, { pyproject?: string; setupCfg?: string }>, sourceRoots: readonly string[] | undefined) {
    this.files = new Set(files);
    for (const file of files) {
      if (!file.endsWith(".py")) continue;
      for (let dir = dirOf(file); !this.packageDirs.has(dir); dir = dirOf(dir)) {
        this.packageDirs.add(dir);
        if (dir === "") break;
      }
    }
    for (const [dir, config] of [...projects].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      const declared = declaredRoots(config.pyproject, config.setupCfg).map((r) => toRepoPath(posix.join(dir || ".", r)));
      const src = join(dir, "src");
      const roots = [...declared, ...(this.packageDirs.has(src) ? [src] : []), dir].filter((r) => r !== ".." && !r.startsWith("../"));
      this.projectRoots.set(dir, dedupe(roots));
    }
    this.configuredRoots = sourceRoots && sourceRoots.length > 0 ? this.expand(sourceRoots) : null;
  }

  /** settings.source_roots: plain paths as written, globs expanded against the package folders. */
  private expand(patterns: readonly string[]): string[] {
    const dirs = [...this.packageDirs].filter((d) => d !== "").sort();
    return dedupe(
      patterns.flatMap((pattern) => {
        const path = toRepoPath(pattern);
        if (!GLOB_CHARS.test(path)) return [path];
        const matches = globMatcher([path]);
        return dirs.filter((d) => matches(d));
      }),
    );
  }

  /** Roots for files in dir: the nearest project's roots first, then every other project's, so imports across projects resolve. */
  private rootsFor(dir: string): string[] {
    if (this.configuredRoots) return this.configuredRoots;
    const cached = this.rootsByDir.get(dir);
    if (cached) return cached;
    let nearest: string | undefined;
    for (let d = dir; ; d = dirOf(d)) {
      if (this.projectRoots.has(d)) {
        nearest = d;
        break;
      }
      if (d === "") break;
    }
    const own = nearest !== undefined ? (this.projectRoots.get(nearest) as string[]) : [...(this.packageDirs.has("src") ? ["src"] : []), ""];
    const others = [...this.projectRoots].flatMap(([d, roots]) => (d === nearest ? [] : roots));
    const roots = dedupe([...own, ...others]);
    this.rootsByDir.set(dir, roots);
    return roots;
  }

  /** A module at a path without extension: a package's __init__.py first, then a .py module, then a namespace folder. */
  private probe(base: string): Found {
    const init = join(base, "__init__.py");
    if (this.files.has(init)) return { file: init };
    if (base !== "" && this.files.has(`${base}.py`)) return { file: `${base}.py` };
    return this.packageDirs.has(base) ? NAMESPACE : null;
  }

  /** A dotted module searched through the roots in order. Regular modules win; namespace portions only count when none is found. */
  private lookup(roots: readonly string[], dotted: string): Found {
    const key = `${roots.join("\0")}\u0001${dotted}`;
    const cached = this.lookups.get(key);
    if (cached !== undefined) return cached;
    const rel = dotted.replaceAll(".", "/");
    let found: Found = null;
    for (const root of roots) {
      const hit = this.probe(join(root, rel));
      if (hit === NAMESPACE) found = NAMESPACE;
      else if (hit) {
        found = hit;
        break;
      }
    }
    this.lookups.set(key, found);
    return found;
  }

  resolve(from: string, raw: RawImport): EdgeTarget[] {
    return raw.specifier.startsWith(".") ? this.resolveRelative(from, raw) : this.resolveAbsolute(from, raw);
  }

  private resolveAbsolute(from: string, raw: RawImport): EdgeTarget[] {
    const roots = this.rootsFor(dirOf(from));
    const dotted = raw.specifier;
    const found = this.lookup(roots, dotted);
    const top = dotted.split(".")[0] as string;
    const missing = (): EdgeTarget => {
      if (STDLIB_MODULES.has(top)) return { package: top, builtin: true };
      // A regular internal top-level package makes the miss an internal import that does not resolve.
      const topFound = this.lookup(roots, top);
      return topFound !== null && topFound !== NAMESPACE ? { unresolved: true } : { package: top };
    };
    if (found === null || (found === NAMESPACE && STDLIB_MODULES.has(top))) return [missing()];
    return targets(found, raw.names, (name) => this.lookup(roots, `${dotted}.${name}`), missing);
  }

  private resolveRelative(from: string, raw: RawImport): EdgeTarget[] {
    const rest = raw.specifier.replace(/^\.+/, "");
    const dots = raw.specifier.length - rest.length;
    let dir = dirOf(from);
    for (let i = 1; i < dots; i++) {
      if (dir === "") return [{ unresolved: true }];
      dir = dirOf(dir);
    }
    const base = rest === "" ? dir : join(dir, rest.replaceAll(".", "/"));
    // "." and ".." name a package folder, never a sibling module file of the same name.
    const found: Found = rest === "" ? (this.files.has(join(dir, "__init__.py")) ? { file: join(dir, "__init__.py") } : NAMESPACE) : this.probe(base);
    if (found === null) return [{ unresolved: true }];
    return targets(found, raw.names, (name) => this.probe(join(base, name)), () => ({ unresolved: true }));
  }
}

/**
 * Targets of a found module. Without names (import a.b) or with "*", the module itself. Otherwise each name that is a
 * submodule gets its own file, and the other names are attributes of the module's file. One target per distinct file.
 */
function targets(found: Found, names: readonly string[] | undefined, submodule: (name: string) => Found, missing: () => EdgeTarget): EdgeTarget[] {
  const out: EdgeTarget[] = [];
  const seen = new Set<string>();
  const add = (target: EdgeTarget) => {
    const key = target.to ?? JSON.stringify(target);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(target);
  };
  const own = found !== null && found !== NAMESPACE ? found.file : undefined;
  if (names === undefined || names.length === 0 || names.includes("*")) return own ? [{ to: own }] : [];
  for (const name of names) {
    const sub = submodule(name);
    if (sub !== null && sub !== NAMESPACE) add({ to: sub.file });
    else if (sub === NAMESPACE) continue;
    else if (own) add({ to: own });
    else add(missing());
  }
  return out;
}

export async function createPythonResolver(input: ResolverInput): Promise<ImportResolver> {
  const projectFiles = input.files.filter((f) => PROJECT_FILES.has(baseName(f)) && !IGNORED.test(f));
  const texts = await input.source.readFiles(projectFiles.filter((f) => !f.endsWith("setup.py")));
  const projects = new Map<string, { pyproject?: string; setupCfg?: string }>();
  for (const file of projectFiles) {
    const dir = dirOf(file);
    const project = projects.get(dir) ?? {};
    const text = texts.get(file);
    if (text !== undefined && file.endsWith("pyproject.toml")) project.pyproject = text;
    if (text !== undefined && file.endsWith("setup.cfg")) project.setupCfg = text;
    projects.set(dir, project);
  }
  return new PythonResolver(input.files, projects, input.settings.source_roots);
}

