import type { Settings } from "../../model/index.ts";
import { globMatcher } from "../../model/index.ts";

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

/** Files an analyzer handles, restricted by settings.include and minus the built-in and configured excludes. */
export function selectFiles(files: readonly string[], settings: Settings, extensions: readonly string[]): string[] {
  const known = new Set(extensions.map((e) => e.toLowerCase()));
  const included = settings.include && settings.include.length > 0 ? globMatcher(settings.include) : null;
  const excluded = globMatcher([...BUILTIN_EXCLUDES, ...settings.exclude]);
  return files.filter((f) => known.has(extensionOf(f)) && (!included || included(f)) && !excluded(f));
}
