import type { Baseline, BaselineEntry, Finding } from "../model/index.ts";
import { compareText } from "../model/index.ts";

function isCandidate(f: Finding): boolean {
  return f.level !== "info";
}

function byFileLine(a: Finding, b: Finding): number {
  return compareText((a.location?.file ?? ""), b.location?.file ?? "") || (a.location?.line ?? 0) - (b.location?.line ?? 0);
}

function sortEntries(entries: BaselineEntry[]): BaselineEntry[] {
  return entries.sort((a, b) => compareText(a.rule, b.rule) || compareText((a.file ?? ""), b.file ?? "") || compareText(a.fingerprint, b.fingerprint));
}

/** Marks up to count new findings per baseline fingerprint as baselined; reports entries that no longer occur as fixed. */
export function applyBaseline(
  findings: readonly Finding[],
  baseline: Baseline,
  options: { files?: ReadonlySet<string> } = {},
): { findings: Finding[]; fixed: BaselineEntry[] } {
  const groups = new Map<string, Finding[]>();
  for (const f of findings) {
    if (f.status !== "new" || !isCandidate(f)) continue;
    const group = groups.get(f.fingerprint) ?? [];
    group.push(f);
    groups.set(f.fingerprint, group);
  }
  const baselined = new Set<Finding>();
  const fixed: BaselineEntry[] = [];
  for (const entry of baseline.entries) {
    const group = (groups.get(entry.fingerprint) ?? []).sort(byFileLine);
    for (const f of group.slice(0, entry.count)) baselined.add(f);
    const missing = entry.count - group.length;
    if (missing <= 0) continue;
    if (options.files && entry.file !== undefined && !options.files.has(entry.file)) continue;
    fixed.push({ ...entry, count: missing });
  }
  return {
    findings: findings.map((f) => (baselined.has(f) ? { ...f, status: "baselined" } : f)),
    fixed: sortEntries(fixed),
  };
}

function entryFor(f: Finding, count: number): BaselineEntry {
  const entry: BaselineEntry = { fingerprint: f.fingerprint, rule: f.rule, count };
  const file = f.kind === "acyclic" ? undefined : f.location?.file;
  if (file !== undefined) entry.file = file;
  if (f.from !== undefined) entry.from = f.from;
  if (f.to !== undefined) entry.to = f.to;
  entry.message = f.message;
  return entry;
}

/**
 * Rewrites the baseline from current findings. Counts only shrink unless allowGrow is set.
 * removed and grown carry the size of the change in count; added carries the full count.
 */
export function updateBaseline(
  baseline: Baseline,
  findings: readonly Finding[],
  options: { allowGrow: boolean },
): { baseline: Baseline; added: BaselineEntry[]; removed: BaselineEntry[]; grown: BaselineEntry[] } {
  const groups = new Map<string, Finding[]>();
  for (const f of [...findings].sort(byFileLine)) {
    if ((f.status !== "new" && f.status !== "baselined") || !isCandidate(f)) continue;
    const group = groups.get(f.fingerprint) ?? [];
    group.push(f);
    groups.set(f.fingerprint, group);
  }
  const entries: BaselineEntry[] = [];
  const added: BaselineEntry[] = [];
  const removed: BaselineEntry[] = [];
  const grown: BaselineEntry[] = [];
  const known = new Set<string>();
  for (const old of baseline.entries) {
    known.add(old.fingerprint);
    const group = groups.get(old.fingerprint) ?? [];
    const count = options.allowGrow ? group.length : Math.min(old.count, group.length);
    if (count < old.count) removed.push({ ...old, count: old.count - count });
    if (count > old.count) grown.push({ ...old, count: count - old.count });
    if (count === 0) continue;
    entries.push(group[0] ? entryFor(group[0], count) : { ...old, count });
  }
  if (options.allowGrow) {
    for (const [fingerprint, group] of groups) {
      if (known.has(fingerprint)) continue;
      const entry = entryFor(group[0]!, group.length);
      entries.push(entry);
      added.push(entry);
    }
  }
  return {
    baseline: { schema_version: 1, entries: sortEntries(entries) },
    added: sortEntries(added),
    removed: sortEntries(removed),
    grown: sortEntries(grown),
  };
}
