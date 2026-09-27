import { posix } from "node:path";
import { analyzerKeys, buildGraph, DEFAULT_ANALYZERS, discoverWorkspaces, repoCrates, selectSourceFiles } from "../analysis/index.ts";
import { ArchitectureSchema, ComponentIndex, SettingsSchema, type Architecture, type ComponentGraph, type Coverage, type FileSource } from "../model/index.ts";
import { componentGraph, findCycles } from "../rules/index.ts";
import { inferComponents, type InferredMap } from "./infer.ts";
import { openWorkspace, requireValidContract } from "./workspace.ts";

export interface GraphResult {
  graph: ComponentGraph;
  cycles: string[][];
  coverage: Coverage;
  /** True when the repository has no architecture file yet and the components were inferred. */
  inferred: boolean;
}

/**
 * Infers components from the layout of the source files in source, in every language, with workspace packages
 * and crates as components of their own. Used by init, and by graph before init.
 */
export async function inferMap(source: FileSource): Promise<InferredMap & { files: string[] }> {
  const files = await source.listFiles();
  const settings = SettingsSchema.parse({});
  const workspaces = await discoverWorkspaces(source, files);
  const crates = await repoCrates({ source, files, settings });
  const dirs = new Set(workspaces.map((w) => w.dir));
  const packages = [
    ...workspaces.map((w) => ({ ...w, workspace: true })),
    ...[...crates].map(([name, manifest]) => ({ name, dir: posix.dirname(manifest) })).filter((c) => c.dir !== "." && !dirs.has(c.dir)),
  ];
  const sourceFiles = selectSourceFiles(files, settings, analyzerKeys(DEFAULT_ANALYZERS));
  return { ...inferComponents(sourceFiles, packages), files };
}

export async function runGraph(cwd: string, options: { includeTypeImports?: boolean; today?: string } = {}): Promise<GraphResult> {
  const ws = await openWorkspace(cwd, { today: options.today });
  let architecture: Architecture = ws.contract.architecture;
  let cacheDir: string | undefined = ws.cacheDir;
  const inferred = !ws.contract.present.architecture;
  if (inferred) {
    const map = await inferMap(ws.source);
    architecture = ArchitectureSchema.parse({ components: map.components, settings: { exclude: map.exclude } });
    // Before init there is no .architect/ directory, and graph should not create one.
    cacheDir = undefined;
  } else {
    requireValidContract(ws);
  }
  const { graph, coverage } = await buildGraph(ws.source, architecture, { cacheDir });
  const index = new ComponentIndex(architecture.components, graph.workspaces);
  const components = componentGraph(graph, index, { includeTypeImports: options.includeTypeImports ?? true });
  return { graph: components, cycles: findCycles(components.components, components.edges), coverage, inferred };
}
