import type { ComponentEdge, ComponentGraph, ComponentIndex, Edge, EdgeKind, Graph } from "../model/index.ts";

/** Component of an edge's internal target: the file's component, or the workspace package's component. */
export function targetComponent(edge: Edge, index: ComponentIndex): string | null {
  if (edge.unresolved) return null;
  if (edge.to !== undefined) return index.of(edge.to);
  if (edge.workspace !== undefined) return index.ofPackage(edge.workspace);
  return null;
}

/** Component-level dependencies: one edge per ordered pair of different mapped components. */
export function componentGraph(graph: Graph, index: ComponentIndex, options: { includeTypeImports?: boolean } = {}): ComponentGraph {
  const includeTypes = options.includeTypeImports ?? true;
  const pairs = new Map<string, { from: string; to: string; edges: Edge[]; kinds: Set<EdgeKind> }>();
  for (const edge of graph.edges) {
    if (!includeTypes && edge.kind === "type") continue;
    const from = index.of(edge.from);
    const to = targetComponent(edge, index);
    if (from === null || to === null || from === to) continue;
    const key = `${from}\u0000${to}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { from, to, edges: [], kinds: new Set() };
      pairs.set(key, pair);
    }
    pair.edges.push(edge);
    pair.kinds.add(edge.kind);
  }
  const edges: ComponentEdge[] = [...pairs.values()]
    .map((p) => ({
      from: p.from,
      to: p.to,
      count: p.edges.length,
      kinds: [...p.kinds].sort(),
      samples: [...p.edges]
        .sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line)
        .slice(0, 3)
        .map((e) => ({ file: e.from, line: e.line, target: e.to ?? e.workspace ?? "" })),
    }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { components: index.ids(), edges };
}

/** Strongly connected components of size 2 or more (Tarjan, iterative). Members sorted; list sorted. */
export function findCycles(nodes: readonly string[], edges: readonly { from: string; to: string }[]): string[][] {
  const known = new Set(nodes);
  const adjacency = new Map<string, string[]>();
  for (const node of known) adjacency.set(node, []);
  for (const edge of edges) {
    if (edge.from === edge.to || !known.has(edge.from) || !known.has(edge.to)) continue;
    adjacency.get(edge.from)?.push(edge.to);
  }
  for (const list of adjacency.values()) list.sort();

  const indexOf = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  for (const root of [...known].sort()) {
    if (indexOf.has(root)) continue;
    const work: { node: string; next: number }[] = [{ node: root, next: 0 }];
    indexOf.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const targets = adjacency.get(frame.node) ?? [];
      if (frame.next < targets.length) {
        const target = targets[frame.next++]!;
        if (!indexOf.has(target)) {
          indexOf.set(target, counter);
          low.set(target, counter);
          counter++;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, next: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node)!, indexOf.get(target)!));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node)!, low.get(frame.node)!));
      if (low.get(frame.node) === indexOf.get(frame.node)) {
        const members: string[] = [];
        let member: string;
        do {
          member = stack.pop()!;
          onStack.delete(member);
          members.push(member);
        } while (member !== frame.node);
        if (members.length >= 2) result.push(members.sort());
      }
    }
  }
  return result.sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")));
}

/** Shortest cycle through start inside the member set, as a closed path [start, ..., start]. */
export function cyclePath(start: string, members: ReadonlySet<string>, edges: readonly { from: string; to: string }[]): string[] {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (e.from === e.to || !members.has(e.from) || !members.has(e.to)) continue;
    const list = adjacency.get(e.from) ?? [];
    list.push(e.to);
    adjacency.set(e.from, list);
  }
  for (const list of adjacency.values()) list.sort();
  const previous = new Map<string, string>();
  const queue = [start];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of adjacency.get(node) ?? []) {
      if (next === start) {
        const path = [start];
        for (let at: string | undefined = node; at !== undefined && at !== start; at = previous.get(at)) path.splice(1, 0, at);
        path.push(start);
        return path;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, node);
      queue.push(next);
    }
  }
  return [start, start];
}
