import type { LanguageAnalyzer } from "../../model/index.ts";
import { analyzeFile } from "./analyze.ts";
import { createTypeScriptResolver } from "./resolve.ts";

export const typescriptAnalyzer: LanguageAnalyzer = {
  id: "typescript",
  version: "2",
  extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
  analyze: analyzeFile,
  createResolver: createTypeScriptResolver,
};
