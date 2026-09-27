// Source languages Architect recognizes by file extension, whether or not an analyzer reads them. Coverage counts
// files of every language here, so a repository written mostly in a language without an analyzer shows up as such.
import picomatch from "picomatch";
import type { Coverage } from "./schema.ts";

const LANGUAGE_EXTENSIONS: Record<string, readonly string[]> = {
  c: [".c", ".h"],
  clojure: [".clj", ".cljs", ".cljc"],
  cpp: [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
  csharp: [".cs"],
  dart: [".dart"],
  elixir: [".ex", ".exs"],
  erlang: [".erl"],
  fsharp: [".fs"],
  go: [".go"],
  haskell: [".hs"],
  java: [".java"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  julia: [".jl"],
  kotlin: [".kt", ".kts"],
  lua: [".lua"],
  objc: [".m", ".mm"],
  ocaml: [".ml", ".mli"],
  php: [".php"],
  python: [".py", ".pyi"],
  ruby: [".rb"],
  rust: [".rs"],
  scala: [".scala"],
  svelte: [".svelte"],
  swift: [".swift"],
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  vue: [".vue"],
  zig: [".zig"],
};

const BY_EXTENSION = new Map<string, string>(
  Object.entries(LANGUAGE_EXTENSIONS).flatMap(([language, exts]) => exts.map((ext) => [ext, language] as const)),
);

/** Every recognized source extension, sorted. */
export const SOURCE_EXTENSIONS: readonly string[] = [...BY_EXTENSION.keys()].sort();

/** The source language of a path by its extension, or null for files that are not source code. */
export function sourceLanguageOf(path: string): string | null {
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  if (dot <= slash + 1) return null;
  return BY_EXTENSION.get(path.slice(dot).toLowerCase()) ?? null;
}

/** Below this share of analyzed source files, results describe a sample, and Architect says so. */
export const LOW_COVERAGE = 0.5;

type CoverageCounts = Pick<Coverage, "files_analyzed" | "source_files">;

/** Analyzed files as a share of all source files, or 1 when the repository has no recognized source files. */
export function coverageRatio(coverage: CoverageCounts): number {
  if (coverage.source_files <= 0) return 1;
  return Math.min(1, coverage.files_analyzed / coverage.source_files);
}

export function isLowCoverage(coverage: CoverageCounts): boolean {
  return coverageRatio(coverage) < LOW_COVERAGE;
}

/** The share of source files analyzed, such as "5%", or "<1%" for a sliver. */
export function coveragePercent(coverage: CoverageCounts): string {
  const ratio = coverageRatio(coverage);
  return ratio > 0 && ratio < 0.01 ? "<1%" : `${Math.floor(ratio * 100)}%`;
}

/** Source files no analyzer read, as "rust 612, swift 700", largest first. Empty when every source file was analyzed. */
export function notAnalyzedText(coverage: Pick<Coverage, "not_analyzed">): string {
  return Object.entries(coverage.not_analyzed)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([language, count]) => `${language} ${count}`)
    .join(", ");
}

/**
 * Tests, fixtures, examples, benchmarks, and scripts. They change for reasons other than the design, so hotspots
 * leave them out. Matched case-insensitively, so "Tests/" and "Fixtures/" count too.
 */
export const NON_PRODUCTION_GLOBS: readonly string[] = [
  "**/*.test.*",
  "**/*.spec.*",
  "**/*_test.*",
  "**/test_*.py",
  "**/*Tests.swift",
  "**/test/**",
  "**/tests/**",
  "**/testdata/**",
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/fixtures/**",
  "**/__fixtures__/**",
  "**/e2e/**",
  "**/examples/**",
  "**/benches/**",
  "**/benchmarks/**",
  "**/scripts/**",
];

const nonProduction = picomatch([...NON_PRODUCTION_GLOBS], { dot: true, nocase: true });

export function isNonProduction(path: string): boolean {
  return nonProduction(path);
}
