import { buildGraph, DEFAULT_ANALYZERS, discoverWorkspaces, selectFiles } from "../analysis/index.ts";
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

/** Infers components from the layout of the files in source. Used by init, and by graph before init. */
export async function inferMap(source: FileSource): Promise<InferredMap & { files: string[] }> {
  const files = await source.listFiles();
  const workspaces = await discoverWorkspaces(source, files);
  const extensions = DEFAULT_ANALYZERS.flatMap((analyzer) => analyzer.extensions);
  return { ...inferComponents(selectFiles(files, SettingsSchema.parse({}), extensions), workspaces), files };
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
