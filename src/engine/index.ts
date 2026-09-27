export { UsageError } from "./errors.ts";
export {
  analyze,
  changedSince,
  contractIssues,
  findRoot,
  localDate,
  openWorkspace,
  repoPaths,
  requireValidContract,
  resolveToday,
  type Changes,
  type Workspace,
} from "./workspace.ts";
export { checkWorkspace, runCheck, type CheckOptions, type CheckOutcome } from "./check.ts";
export { formatInit, runInit, type InitOptions, type InitResult } from "./init.ts";
export { inferMap, runGraph, type GraphResult } from "./graph.ts";
export { explainTarget, runExplain, type Explanation, type ExplainKind } from "./explain.ts";
export { formatBaselineUpdate, runBaselineUpdate, type BaselineUpdateResult } from "./baseline.ts";
export { formatStatus, runStatus, type StatusResult } from "./status.ts";
export { jsonSchemas, SCHEMA_NAMES, type SchemaName } from "./schema.ts";
export { runCi, runDiff, type CiOptions, type CiOutcome, type DiffOptions, type DiffOutcome } from "./diff.ts";
export { openFindings, runContext, type ContextOptions } from "./context.ts";
export { runHook, type HookRun } from "./hooks.ts";
export { driftFindings, formatInstall, runInstall, runSync, type InstallResult } from "./install.ts";
export {
  formatDecisionLint,
  formatDecisionList,
  proposeDecision,
  runDecisionLint,
  runDecisionList,
  runDecisionNew,
  type DecisionLintResult,
  type DecisionSummary,
  type NewDecisionOptions,
  type ProposalInput,
  type ProposalResult,
} from "./decision.ts";
