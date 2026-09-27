import type { Architecture, Graph, HistorySummary } from "../../model/index.ts";
import { fingerprint } from "../../model/index.ts";
import { CACHE_FORMAT, historyCachePath, readCache, stableStringify, writeCache } from "../graph/cache.ts";
import type { CommitRecord } from "./log.ts";
import { historyWindow, logCommits } from "./log.ts";
import { summarizeHistory } from "./summarize.ts";

/**
 * One file, replaced whenever HEAD moves. The commits depend only on HEAD and the window settings; the summary
 * also depends on the thresholds, the component map, and the graph's files and sizes, so an edited working tree
 * re-summarizes the cached commits without running git log again.
 */
interface HistoryCache {
  format: typeof CACHE_FORMAT;
  kind: "history";
  commitsKey: string;
  commits: CommitRecord[];
  summaryKey: string;
  summary: HistorySummary;
}

/** Change history of the repository at root (the top of its work tree), or null outside git or without commits. */
export async function readHistory(
  root: string,
  graph: Graph,
  architecture: Architecture,
  options: { cacheDir?: string } = {},
): Promise<HistorySummary | null> {
  const settings = architecture.settings.history;
  const window = await historyWindow(root, settings.months);
  if (!window) return null;
  const files = graph.files.map((f) => ({ path: f.path, loc: f.loc }));
  const commitsKey = fingerprint(["history-commits", window.head, window.since, String(settings.max_files_per_commit)]);
  const components = architecture.components.map((c) => ({ id: c.id, paths: c.paths }));
  const summaryKey = fingerprint([
    "history-summary",
    commitsKey,
    stableStringify(settings),
    fingerprint([stableStringify(components)]),
    fingerprint([stableStringify(files)]),
  ]);

  const path = options.cacheDir ? historyCachePath(options.cacheDir) : null;
  const cached = path ? await readCache<HistoryCache>(path, "history") : null;
  if (cached?.summaryKey === summaryKey) return cached.summary;
  const commits = cached?.commitsKey === commitsKey ? cached.commits : await logCommits(root, window, settings);
  const summary = summarizeHistory(commits, { head: window.head, since: window.since, files, architecture, settings });
  if (path) {
    const entry: HistoryCache = { format: CACHE_FORMAT, kind: "history", commitsKey, commits, summaryKey, summary };
    await writeCache(path, entry);
  }
  return summary;
}
