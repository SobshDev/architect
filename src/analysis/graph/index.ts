import type { Architecture, FileSource, LanguageAnalyzer } from "../../model/index.ts";
import { cargoAnalyzer } from "../cargo/index.ts";
import { pythonAnalyzer } from "../python/index.ts";
import { typescriptAnalyzer } from "../typescript/index.ts";
import type { BuildGraphOptions, BuildGraphResult } from "./build.ts";
import { buildGraphWith } from "./build.ts";

export type { BuildGraphOptions, BuildGraphResult } from "./build.ts";
export { computeCoverage } from "./build.ts";
export { analyzerKeys, BUILTIN_EXCLUDES, selectFiles, selectSourceFiles } from "./select.ts";
export { discoverWorkspaces } from "./workspaces.ts";

export const DEFAULT_ANALYZERS: readonly LanguageAnalyzer[] = [typescriptAnalyzer, pythonAnalyzer, cargoAnalyzer];

/** Builds the file dependency graph and its coverage, using the caches under options.cacheDir when set. */
export function buildGraph(source: FileSource, architecture: Architecture, options: BuildGraphOptions = {}): Promise<BuildGraphResult> {
  const { analyzers, ...rest } = options;
  return buildGraphWith(analyzers ?? DEFAULT_ANALYZERS, source, architecture, rest);
}
