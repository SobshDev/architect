import { describe, expect, test } from "bun:test";
import { ArchitectureSchema, MemorySource } from "../../model/index.ts";
import { buildGraph } from "../graph/index.ts";
import { analyzeCargoManifest } from "./analyze.ts";

describe("Cargo.toml", () => {
  test("every dependency table counts except dev-dependencies, and renamed crates keep their real name", () => {
    const text = [
      "[package]",
      'name = "api"',
      "",
      "[dependencies]",
      'serde = "1"',
      'json = { package = "serde_json", version = "1" }',
      "",
      "[dev-dependencies]",
      'insta = "1"',
      "",
      "[build-dependencies]",
      'cc = "1"',
      "",
      "[target.'cfg(unix)'.dependencies]",
      'nix = "0.29"',
      "",
      "[dependencies.store]",
      'path = "../store"',
    ].join("\n");
    const facts = analyzeCargoManifest("api/Cargo.toml", text, "id");
    expect(facts.imports.map((i) => [i.specifier, i.line])).toEqual([
      ["serde", 5],
      ["serde_json", 6],
      ["cc", 12],
      ["nix", 15],
      ["store", 17],
    ]);
  });

  test("invalid TOML is a parse error, not a crash", () => {
    expect(analyzeCargoManifest("Cargo.toml", 'name = "unterminated\n', "id").parseError).toStartWith("invalid TOML");
  });

  test("crates in the repository resolve to their manifest and other crates are packages; pyproject.toml is not read", async () => {
    const source = new MemorySource({
      "crates/api/Cargo.toml": '[package]\nname = "api"\n[dependencies]\ncore = { workspace = true }\ntokio = "1"\n',
      "crates/core/Cargo.toml": '[package]\nname = "core"\n',
      "vendor/tokio/Cargo.toml": '[package]\nname = "tokio"\n',
      "tools/pyproject.toml": "[project]\nname = 'x'\n",
    });
    const { graph } = await buildGraph(source, ArchitectureSchema.parse({}));
    expect(graph.files.map((f) => f.path)).toEqual(["crates/api/Cargo.toml", "crates/core/Cargo.toml"]);
    expect(graph.edges.map((e) => [e.specifier, e.to ?? e.package])).toEqual([
      ["core", "crates/core/Cargo.toml"],
      ["tokio", "tokio"],
    ]);
  });
});
