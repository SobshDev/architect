import type { Architecture, CoChangePair, HistorySettings, HistorySummary, Hotspot } from "../../model/index.ts";
import { ComponentIndex, compareText } from "../../model/index.ts";
import type { CommitRecord } from "./log.ts";

export interface SummarizeInput {
  head: string;
  since: string;
  /** Files currently in the graph; changes to other paths are ignored. */
  files: readonly { path: string; loc: number }[];
  architecture: Architecture;
  settings: HistorySettings;
}

const HOTSPOTS = 20;

/** Co-change pairs of files and components, and hotspots (churn times current size). */
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

  const hotspots: Hotspot[] = [];
  for (const [path, lines] of churn) {
    const size = loc.get(path) ?? 0;
    const score = lines * size;
    if (score > 0) hotspots.push({ path, churn: lines, loc: size, score });
  }
  hotspots.sort((a, b) => b.score - a.score || compareText(a.path, b.path));

  return {
    head: input.head,
    since: input.since,
    commits: commits.length,
    filePairs: pairs(filePairs, fileCounts, input.settings),
    componentPairs: pairs(componentPairs, componentCounts, input.settings),
    hotspots: hotspots.slice(0, HOTSPOTS),
  };
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
