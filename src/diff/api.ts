import {
  type ApiChange,
  type ApiStabilityRule,
  anySelectorMatches,
  ComponentIndex,
  type Edge,
  type ExportKind,
  type Finding,
  type Graph,
  keyFingerprint,
  sortFindings,
  type WorkspaceState,
} from "../model/index.ts";

export interface ApiSymbol {
  component: string;
  file: string;
  name: string;
  kind: ExportKind;
  signature: string;
}

type Exported = { kind: ExportKind; signature: string };

const MAX_DEPTH = 10;

/** Public API per component: the exports of its entry files, with re-exports resolved through the graph. */
export function publicApi(graph: Graph, index: ComponentIndex, componentIds?: readonly string[]): Map<string, ApiSymbol[]> {
  const files = new Map(graph.files.map((f) => [f.path, f]));
  const edgesFrom = new Map<string, Edge[]>();
  for (const edge of graph.edges) {
    const list = edgesFrom.get(edge.from) ?? [];
    list.push(edge);
    edgesFrom.set(edge.from, list);
  }
  const memo = new Map<string, Map<string, Exported>>();

  const edgeFor = (file: string, specifier: string): Edge | undefined => {
    const matching = (edgesFrom.get(file) ?? []).filter((e) => e.specifier === specifier);
    return matching.find((e) => e.kind === "reexport") ?? matching[0];
  };

  const exportsOf = (path: string, depth: number, visiting: Set<string>): Map<string, Exported> => {
    const cached = memo.get(path);
    if (cached) return cached;
    const facts = files.get(path);
    const result = new Map<string, Exported>();
    if (!facts || depth > MAX_DEPTH || visiting.has(path)) return result;
    visiting.add(path);
    for (const sym of facts.exports) {
      if (sym.kind !== "reexport" || sym.from === undefined) {
        result.set(sym.name, { kind: sym.kind, signature: sym.signature });
        continue;
      }
      const target = edgeFor(path, sym.from)?.to;
      const resolved = target === undefined ? undefined : exportsOf(target, depth + 1, visiting).get(sym.original ?? sym.name);
      result.set(sym.name, resolved ?? { kind: sym.kind, signature: sym.signature });
    }
    // Explicit exports win over star exports, as in ES modules; default never travels through export *.
    for (const specifier of facts.starExports) {
      const target = edgeFor(path, specifier)?.to;
      if (target === undefined) {
        const name = `* from ${specifier}`;
        if (!result.has(name)) result.set(name, { kind: "reexport", signature: `export * from "${specifier}"` });
        continue;
      }
      for (const [name, sym] of exportsOf(target, depth + 1, visiting)) {
        if (name !== "default" && !result.has(name)) result.set(name, sym);
      }
    }
    visiting.delete(path);
    memo.set(path, result);
    return result;
  };

  const api = new Map<string, ApiSymbol[]>();
  for (const id of componentIds ?? index.ids()) {
    if (!index.hasEntrypoints(id)) continue;
    const symbols: ApiSymbol[] = [];
    for (const facts of graph.files) {
      if (index.of(facts.path) !== id || !index.isEntrypoint(id, facts.path)) continue;
      for (const [name, sym] of exportsOf(facts.path, 0, new Set())) {
        symbols.push({ component: id, file: facts.path, name, kind: sym.kind, signature: sym.signature });
      }
    }
    symbols.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
    api.set(id, symbols);
  }
  return api;
}

/** Formatting-insensitive form of a signature: whitespace runs collapse, spaces next to punctuation and trailing commas disappear. */
function normalize(signature: string): string {
  return signature
    .replace(/\s+/g, " ")
    .replace(/ ?([(){}[\]<>,;:=|&?.]) ?/g, "$1")
    .replace(/,([)\]}>])/g, "$1")
    .trim();
}

const CHANGE_ORDER = { removed: 0, changed: 1, added: 2 } as const;

/** API changes at declared entrypoints, measured under head's component map for both versions. */
export function diffApi(base: WorkspaceState, head: WorkspaceState): ApiChange[] {
  const components = head.architecture.components;
  const ids = components.map((c) => c.id);
  const baseApi = publicApi(base.graph, new ComponentIndex(components, base.graph.workspaces), ids);
  const headApi = publicApi(head.graph, new ComponentIndex(components, head.graph.workspaces), ids);
  const key = (s: ApiSymbol) => `${s.file}\u0000${s.name}`;
  const changes: ApiChange[] = [];
  for (const id of ids) {
    const before = new Map((baseApi.get(id) ?? []).map((s) => [key(s), s]));
    const after = new Map((headApi.get(id) ?? []).map((s) => [key(s), s]));
    for (const [k, old] of before) {
      const now = after.get(k);
      if (!now) changes.push({ component: id, file: old.file, symbol: old.name, change: "removed", before: old.signature });
      else if (normalize(old.signature) !== normalize(now.signature)) {
        changes.push({ component: id, file: old.file, symbol: old.name, change: "changed", before: old.signature, after: now.signature });
      }
    }
    for (const [k, now] of after) {
      if (!before.has(k)) changes.push({ component: id, file: now.file, symbol: now.name, change: "added", after: now.signature });
    }
  }
  return changes.sort(
    (a, b) =>
      a.component.localeCompare(b.component) ||
      a.file.localeCompare(b.file) ||
      a.symbol.localeCompare(b.symbol) ||
      CHANGE_ORDER[a.change] - CHANGE_ORDER[b.change],
  );
}

function describeChange(change: ApiChange): string {
  const where = `${change.symbol} in ${change.file}`;
  switch (change.change) {
    case "removed":
      return `Public API of ${change.component} lost ${where}. Before: ${change.before ?? ""}`;
    case "changed":
      return `Public API of ${change.component} changed ${where}. Before: ${change.before ?? ""} After: ${change.after ?? ""}`;
    case "added":
      return `Public API of ${change.component} gained ${where}. After: ${change.after ?? ""}`;
  }
}

/** Findings from head's api-stability rules: breaks at the rule's level, growth as warnings when allow_growth is false. */
export function apiStabilityFindings(changes: readonly ApiChange[], head: WorkspaceState): Finding[] {
  const rules = head.rules.rules.filter((r): r is ApiStabilityRule => r.kind === "api-stability" && r.level !== "off");
  const findings: Finding[] = [];
  for (const rule of rules) {
    for (const change of changes) {
      if (!anySelectorMatches(rule.components, { file: change.file, component: change.component, external: false })) continue;
      const growth = change.change === "added";
      if (growth && rule.allow_growth) continue;
      findings.push({
        rule: rule.id,
        kind: "api-stability",
        level: growth || rule.level === "warn" ? "warn" : "error",
        message: describeChange(change),
        from: change.component,
        location: { file: change.file },
        because: rule.because,
        fix_hint: growth
          ? `Keep the export private, or record a decision that lists ${rule.id} in weakens.`
          : `Keep the old signature working (add an overload or a new name and deprecate the old one), or record a decision that lists ${rule.id} in weakens.`,
        fingerprint: keyFingerprint(rule.id, change.file, change.symbol, change.change),
        status: "new",
      });
    }
  }
  return sortFindings(findings);
}
