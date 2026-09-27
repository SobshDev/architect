import type { Architecture, CoChangePair, HistorySettings, HistorySummary, Hotspot } from "../../model/index.ts";
import { ComponentIndex, compareText, isNonProduction } from "../../model/index.ts";
import type { CommitRecord } from "./log.ts";

export interface SummarizeInput {
  head: string;
  since: string;
  /**
   * Current source files in any language, parsed or not, with their size; changes to other paths (deleted files,
   * docs, data) are ignored. History needs no parser, so it covers languages the graph cannot read.
   */
  files: readonly { path: string; loc: number }[];
  architecture: Architecture;
  settings: HistorySettings;
}

const HOTSPOTS = 20;
/** A file changed in fewer commits is not a hotspot, however large the changes. */
const MIN_HOTSPOT_COMMITS = 3;

/**
 * Co-change pairs of files and components, and hotspots: production files whose churn times current size is in
 * the top quarter of the files changed in the window, that are at least as large as the median changed file, and
 * that changed in at least three commits. The thresholds are relative to the repository, so an ordinary
 * 100-line file changed a few times does not qualify.
 */
export function summarizeHistory(commits: readonly CommitRecord[], input: SummarizeInput): HistorySummary {
  const loc = new Map(input.files.map((f) => [f.path, f.loc]));
  const index = new ComponentIndex(input.architecture.components);
  const fileCounts = new Counter();
  const filePairs = new Counter();
  const componentCounts = new Counter();
  const componentPairs = new Counter();
  const churn = new Map<string, number>();

  for (const commit of commits) {
    const files = commit.files.filter((f) => loc.has(f.path));
    for (const f of files) churn.set(f.path, (churn.get(f.path) ?? 0) + f.added + f.deleted);
    const paths = files.map((f) => f.path);
    count(paths, fileCounts, filePairs);
    const components = [...new Set(paths.map((p) => index.of(p)).filter((c): c is string => c !== null))].sort(compareText);
    count(components, componentCounts, componentPairs);
  }

  return {
    head: input.head,
    since: input.since,
    commits: commits.length,
    filePairs: pairs(filePairs, fileCounts, input.settings),
    componentPairs: pairs(componentPairs, componentCounts, input.settings),
    hotspots: hotspots(churn, fileCounts, loc),
  };
}

function hotspots(churn: ReadonlyMap<string, number>, commits: ReadonlyMap<string, number>, loc: ReadonlyMap<string, number>): Hotspot[] {
  const changed: Hotspot[] = [];
  for (const [path, lines] of churn) {
    const size = loc.get(path) ?? 0;
    if (lines === 0 || size === 0 || isNonProduction(path)) continue;
    changed.push({ path, churn: lines, commits: commits.get(path) ?? 0, loc: size, score: lines * size });
  }
  const minScore = quantile(changed.map((h) => h.score), 0.75);
  const minLoc = quantile(changed.map((h) => h.loc), 0.5);
  return changed
    .filter((h) => h.commits >= MIN_HOTSPOT_COMMITS && h.score >= minScore && h.loc >= minLoc)
    .sort((a, b) => b.score - a.score || compareText(a.path, b.path))
    .slice(0, HOTSPOTS);
}

/** Nearest-rank quantile, or 0 for no values. */
function quantile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] as number;
}

class Counter extends Map<string, number> {
  add(key: string): void {
    this.set(key, (this.get(key) ?? 0) + 1);
  }
}

/** Counts each item once and each unordered pair once. items must be unique and sorted. */
function count(items: readonly string[], counts: Counter, pairCounts: Counter): void {
  for (let i = 0; i < items.length; i++) {
    counts.add(items[i] as string);
    for (let j = i + 1; j < items.length; j++) pairCounts.add(`${items[i]}\u0000${items[j]}`);
  }
}

function pairs(pairCounts: Counter, counts: Counter, settings: HistorySettings): CoChangePair[] {
  const out: CoChangePair[] = [];
  for (const [key, support] of pairCounts) {
    if (support < settings.min_support) continue;
    const [a, b] = key.split("\u0000") as [string, string];
    const confidence = support / Math.min(counts.get(a) ?? support, counts.get(b) ?? support);
    if (confidence < settings.min_confidence) continue;
    out.push({ a, b, support, confidence: Math.round(confidence * 1000) / 1000 });
  }
  return out.sort((x, y) => y.support - x.support || y.confidence - x.confidence || compareText(x.a, y.a) || compareText(x.b, y.b));
}
