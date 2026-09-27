import type { Architecture, Card, Coverage, Decision, Finding, Graph, HistorySummary, RulesFile } from "../model/index.ts";

export interface ContextInput {
  architecture: Architecture;
  rules: RulesFile;
  decisions: readonly Decision[];
  /** When given, component contracts list observed dependencies and dependents. */
  graph?: Graph;
  /** Open violations; the caller has already scoped them. */
  findings?: readonly Finding[];
  /** Change partners. */
  history?: HistorySummary;
  /** Knowledge cards. */
  cards?: readonly Card[];
  /** Repo-relative paths the task touches. */
  paths?: readonly string[];
  /** Touched paths that no analyzer reads: the brief warns that nothing is checked on them. */
  unanalyzed?: readonly string[];
  /** Repository coverage; the session brief warns when most source files are not analyzed. */
  coverage?: Pick<Coverage, "files_analyzed" | "source_files" | "not_analyzed">;
  /** Free text describing the task. */
  task?: string;
  /** Tokens, estimated as Math.ceil(characters / 4). Default 1500 (6000 when detail is "full"). */
  budget?: number;
  detail?: "concise" | "full";
}

export type ContextItemKind = "decision" | "rule" | "component" | "partner" | "violation" | "card";

export interface ContextLink {
  kind: ContextItemKind;
  id: string;
  uri: string;
  reason: string;
}

export interface ContextItem extends ContextLink {
  markdown: string;
  tokens: number;
}

export interface ContextBrief {
  /** The complete brief, never over the budget. */
  markdown: string;
  /** Estimate for markdown. */
  tokens: number;
  /** Included, in rank order. */
  items: ContextItem[];
  /** Ranked but cut by the budget, in rank order. */
  omitted: ContextLink[];
  /** Components touched by paths or named in the task, sorted. */
  components: string[];
}

export interface PromptMatch {
  components: string[];
  paths: string[];
  decisions: string[];
}
