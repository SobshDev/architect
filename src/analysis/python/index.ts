import type { LanguageAnalyzer } from "../../model/index.ts";
import { analyzeFile } from "./analyze.ts";
import { preparePython } from "./parser.ts";
import { createPythonResolver } from "./resolve.ts";

export const pythonAnalyzer: LanguageAnalyzer = {
  id: "python",
  version: "1",
  extensions: [".py"],
  prepare: preparePython,
  analyze: analyzeFile,
  createResolver: createPythonResolver,
};
