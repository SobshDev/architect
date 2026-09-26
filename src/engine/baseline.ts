import type { BaselineEntry } from "../model/index.ts";
import { evaluateRules, updateBaseline } from "../rules/index.ts";
import { CONTRACT_PATHS, serializeBaseline, writeRepoFile } from "../store/index.ts";
import { analyze, openWorkspace, requireValidContract } from "./workspace.ts";

export interface BaselineUpdateResult {
  path: string;
  entries: number;
  occurrences: number;
  added: BaselineEntry[];
  removed: BaselineEntry[];
  grown: BaselineEntry[];
  /** Occurrences dropped from entries that still exist or were removed. */
  shrunk: number;
}

/** Rewrites the baseline from the current findings. It only shrinks unless allowGrow is set. */
export async function runBaselineUpdate(cwd: string, options: { allowGrow: boolean; today?: string }): Promise<BaselineUpdateResult> {
  const ws = await openWorkspace(cwd, { today: options.today });
  requireValidContract(ws);
  const { graph } = await analyze(ws);
  const { architecture, rules, baseline } = ws.contract;
  const findings = evaluateRules({ graph, architecture, rules, today: ws.today });
  const update = updateBaseline(baseline, findings, { allowGrow: options.allowGrow });
  await writeRepoFile(ws.root, CONTRACT_PATHS.baseline, serializeBaseline(update.baseline));
  const total = (entries: readonly BaselineEntry[]) => entries.reduce((sum, entry) => sum + entry.count, 0);
  return {
    path: CONTRACT_PATHS.baseline,
    entries: update.baseline.entries.length,
    occurrences: total(update.baseline.entries),
    added: update.added,
    removed: update.removed,
    grown: update.grown,
    shrunk: Math.max(0, total(baseline.entries) - total(update.baseline.entries) + total(update.added) + growth(baseline.entries, update.grown)),
  };
}

/** How many occurrences grown entries gained over their previous counts. */
function growth(before: readonly BaselineEntry[], grown: readonly BaselineEntry[]): number {
  const previous = new Map(before.map((entry) => [entry.fingerprint, entry.count]));
  return grown.reduce((sum, entry) => sum + entry.count - (previous.get(entry.fingerprint) ?? 0), 0);
}

export function formatBaselineUpdate(result: BaselineUpdateResult): string {
  const lines = [`Wrote ${result.path}: ${result.entries} entries, ${result.occurrences} accepted violations.`];
  if (result.shrunk > 0) lines.push(`Dropped ${result.shrunk} fixed violations.`);
  if (result.added.length > 0 || result.grown.length > 0) {
    lines.push(`Accepted ${result.added.length} new and ${result.grown.length} grown entries (--allow-grow). CI reports baseline growth as a weakening that needs a decision.`);
  }
  if (result.shrunk === 0 && result.added.length === 0 && result.grown.length === 0) lines.push("Nothing changed.");
  return lines.join("\n");
}
