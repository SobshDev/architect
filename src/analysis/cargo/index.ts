import type { LanguageAnalyzer } from "../../model/index.ts";
import { analyzeCargoManifest } from "./analyze.ts";
import { createCargoResolver } from "./resolve.ts";

export { repoCrates } from "./resolve.ts";

/** Crate dependencies from Cargo.toml manifests: a component graph for Rust without parsing Rust. */
export const cargoAnalyzer: LanguageAnalyzer = {
  id: "cargo",
  version: "1",
  extensions: [],
  fileNames: ["cargo.toml"],
  analyze: analyzeCargoManifest,
  createResolver: createCargoResolver,
};
