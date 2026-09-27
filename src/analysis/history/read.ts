import type { Architecture, Graph, HistorySummary } from "../../model/index.ts";
import { fingerprint } from "../../model/index.ts";
import { CACHE_FORMAT, historyCachePath, readCache, stableStringify, writeCache } from "../graph/cache.ts";
import { selectSourceFiles } from "../graph/select.ts";
import { WorktreeSource } from "../source/index.ts";
import type { CommitRecord } from "./log.ts";
import { historyWindow, logCommits } from "./log.ts";
import { summarizeHistory } from "./summarize.ts";

/**
 * One file, replaced whenever HEAD moves. The commits depend only on HEAD and the window settings; the summary
 * also depends on the thresholds, the component map, and the current source files and their sizes, so an edited
 * working tree re-summarizes the cached commits without running git log again.
 */
interface HistoryCache {
  format: typeof CACHE_FORMAT;
  kind: "history";
  commitsKey: string;
  commits: CommitRecord[];
  summaryKey: string;
  summary: HistorySummary;
}

/**
 * Change history of the repository at root (the top of its work tree), or null outside git or without commits.
 * It covers every current source file in scope, in any language: files the graph holds keep their size from the
 * graph, and other files that changed in the window are read to count their lines.
 */
export async function readHistory(
  root: string,
  graph: Graph,
  architecture: Architecture,
  options: { cacheDir?: string } = {},
): Promise<HistorySummary | null> {
  const settings = architecture.settings.history;
  const window = await historyWindow(root, settings.months);
  if (!window) return null;
  const commitsKey = fingerprint(["history-commits", window.head, window.since, String(settings.max_files_per_commit)]);
  const path = options.cacheDir ? historyCachePath(options.cacheDir) : null;
  const cached = path ? await readCache<HistoryCache>(path, "history") : null;
  const commits = cached?.commitsKey === commitsKey ? cached.commits : await logCommits(root, window, settings);

  // Source files outside the graph that the window's commits touched; their stamps stand in for their sizes in the key.
  const source = new WorktreeSource(root);
  const inGraph = new Map(graph.files.map((f) => [f.path, f.loc]));
  const touched = new Set(commits.flatMap((c) => c.files.map((f) => f.path)));
  const others = selectSourceFiles(await source.listFiles(), architecture.settings, []).filter((p) => touched.has(p) && !inGraph.has(p));
  const stamps = await Promise.all(others.map((p) => source.stamp(p)));
  const components = architecture.components.map((c) => ({ id: c.id, paths: c.paths }));
  const summaryKey = fingerprint([
    "history-summary",
    commitsKey,
    stableStringify(settings),
    fingerprint([stableStringify(components)]),
    fingerprint([stableStringify(graph.files.map((f) => [f.path, f.loc]))]),
    fingerprint([stableStringify(others.map((p, i) => [p, stamps[i] ?? null]))]),
  ]);
  if (cached?.summaryKey === summaryKey) return cached.summary;

  const texts = await source.readFiles(others);
  const files = [
    ...graph.files.map((f) => ({ path: f.path, loc: f.loc })),
    ...[...texts].map(([p, text]) => ({ path: p, loc: nonBlankLines(text) })),
  ];
  const summary = summarizeHistory(commits, { head: window.head, since: window.since, files, architecture, settings });
  if (path) {
    const entry: HistoryCache = { format: CACHE_FORMAT, kind: "history", commitsKey, commits, summaryKey, summary };
    await writeCache(path, entry);
  }
  return summary;
}

/** Non-blank lines, the size measure analyzers report as loc. */
function nonBlankLines(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) if (line.trim() !== "") count++;
  return count;
}
