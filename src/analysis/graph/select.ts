import type { LanguageAnalyzer, Settings } from "../../model/index.ts";
import { globMatcher, sourceLanguageOf } from "../../model/index.ts";

/** Paths never analyzed: dependencies, build output, virtualenvs, generated declarations, and Architect's own folder. */
export const BUILTIN_EXCLUDES: readonly string[] = [
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/out/**",
  "**/coverage/**",
  "**/vendor/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/.tox/**",
  "**/.mypy_cache/**",
  "**/.pytest_cache/**",
  "**/.ruff_cache/**",
  "**/.eggs/**",
  "**/*.egg-info/**",
  "**/site-packages/**",
  "**/*.d.ts",
  "**/*.min.js",
  ".architect/**",
];

/** Lowercase extension with the dot (".ts"), or "" when the file name has none. */
export function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "";
}

/** The extensions (".ts") and file names ("cargo.toml") analyzers claim, lowercase. */
export function analyzerKeys(analyzers: readonly LanguageAnalyzer[]): string[] {
  return analyzers.flatMap((analyzer) => [...analyzer.extensions, ...(analyzer.fileNames ?? [])]).map((key) => key.toLowerCase());
}

/** The key that picks a path's analyzer: its lowercase file name when an analyzer claims it, else its extension. */
export function analysisKey(path: string, known: ReadonlySet<string>): string {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return known.has(name) ? name : extensionOf(path);
}

/** Files in scope: restricted by settings.include, minus the built-in and configured excludes. */
function scopeMatcher(settings: Settings): (path: string) => boolean {
  const included = settings.include && settings.include.length > 0 ? globMatcher(settings.include) : null;
  const excluded = globMatcher([...BUILTIN_EXCLUDES, ...settings.exclude]);
  return (path) => (!included || included(path)) && !excluded(path);
}

/** Files an analyzer handles (by extension or file name), restricted by settings.include and minus the built-in and configured excludes. */
export function selectFiles(files: readonly string[], settings: Settings, keys: readonly string[]): string[] {
  const known = new Set(keys.map((e) => e.toLowerCase()));
  const inScope = scopeMatcher(settings);
  return files.filter((f) => known.has(analysisKey(f, known)) && inScope(f));
}

/** Source files in scope that no analyzer handles, counted per language. */
export function countNotAnalyzed(files: readonly string[], settings: Settings, keys: readonly string[]): Record<string, number> {
  const known = new Set(keys.map((e) => e.toLowerCase()));
  const inScope = scopeMatcher(settings);
  const counts = new Map<string, number>();
  for (const file of files) {
    const language = sourceLanguageOf(file);
    if (language === null || known.has(analysisKey(file, known)) || !inScope(file)) continue;
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const out: Record<string, number> = {};
  for (const language of [...counts.keys()].sort()) out[language] = counts.get(language) as number;
  return out;
}

/** Source files in scope in any recognized language, analyzed or not: the files history and init look at. */
export function selectSourceFiles(files: readonly string[], settings: Settings, keys: readonly string[]): string[] {
  const known = new Set(keys.map((e) => e.toLowerCase()));
  const inScope = scopeMatcher(settings);
  return files.filter((f) => (sourceLanguageOf(f) !== null || known.has(analysisKey(f, known))) && inScope(f));
}
