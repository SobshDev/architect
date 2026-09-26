import type { Graph } from "./graph.ts";
import type { Architecture, Baseline, Decision, RulesFile } from "./schema.ts";

/** Everything needed to evaluate one version (base or head) of a repository. */
export interface WorkspaceState {
  /** Where the state came from: "worktree" or "<ref>@<short sha>". */
  label: string;
  graph: Graph;
  architecture: Architecture;
  rules: RulesFile;
  decisions: Decision[];
  baseline: Baseline;
}
