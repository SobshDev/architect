// What a rule requires, which components it involves, and what it allows a component to depend on.
import { type Architecture, globMatcher, parseSelector, type Rule } from "../model/index.ts";
import { code, codeList } from "./text.ts";

function deprecatedIds(architecture: Architecture): string[] {
  return architecture.components.filter((c) => c.deprecated !== undefined && c.deprecated !== false).map((c) => c.id);
}

function layerMembers(layer: string | string[]): string[] {
  return Array.isArray(layer) ? layer : [layer];
}

/** Every selector a rule applies to, including components implied by resources or deprecation. */
export function ruleSelectors(rule: Rule, architecture: Architecture): string[] {
  switch (rule.kind) {
    case "forbid":
    case "allow-only":
      return [...rule.from, ...rule.to];
    case "layers":
      return rule.layers.flatMap(layerMembers);
    case "acyclic":
      return rule.within ?? ["*"];
    case "independent":
      return rule.members;
    case "entrypoints":
      return rule.targets;
    case "external-imports":
      return rule.from ?? rule.allow_from ?? [];
    case "state-owner": {
      const wanted = rule.resources;
      return architecture.resources.filter((r) => wanted === undefined || wanted.includes(r.id)).map((r) => r.owner);
    }
    case "api-stability":
      return rule.components;
    case "deprecated":
      return rule.components ?? deprecatedIds(architecture);
  }
}

/** True when a selector of the rule names a touched component, matches a touched path, or is "*". */
export function ruleInvolves(rule: Rule, architecture: Architecture, components: ReadonlySet<string>, paths: readonly string[]): boolean {
  if (components.size === 0 && paths.length === 0) return false;
  return ruleSelectors(rule, architecture).some((raw) => {
    const selector = parseSelector(raw);
    if (selector.type === "all") return true;
    if (selector.type === "component") return components.has(selector.id);
    if (selector.type === "path") return paths.some((p) => selector.match(p));
    return false;
  });
}

/** One generated sentence describing what the rule requires. */
export function describeRule(rule: Rule): string {
  switch (rule.kind) {
    case "forbid":
      return `${codeList(rule.from)} must not depend on ${codeList(rule.to)}.`;
    case "allow-only": {
      const targets = rule.to.length > 0 ? ` and ${codeList(rule.to)}` : "";
      return `${codeList(rule.from)} may depend only on itself${targets}${rule.scope === "all" ? ", external packages included" : ""}.`;
    }
    case "layers": {
      const order = rule.layers.map((l) => layerMembers(l).map(code).join(" + ")).join(" > ");
      const skip = rule.allow_skip ? "" : ", and only on the layer directly below";
      return `Layers from top to bottom: ${order}. A layer must not depend on a layer above it${skip}.`;
    }
    case "acyclic":
      return `No dependency cycles between ${rule.scope}${rule.within ? ` within ${codeList(rule.within)}` : ""}.`;
    case "independent":
      return `${codeList(rule.members)} must not depend on each other.`;
    case "entrypoints":
      return `Other components may import ${codeList(rule.targets)} only through ${rule.entrypoints ? codeList(rule.entrypoints) : "their declared entrypoints"}.`;
    case "external-imports": {
      if (rule.packages !== undefined) return `Only ${codeList(rule.allow_from ?? [])} may import ${codeList(rule.packages)}.`;
      const parts: string[] = [];
      if (rule.allow !== undefined) parts.push(rule.allow.length === 0 ? "must not import external packages" : `may import only the packages ${codeList(rule.allow)}`);
      if (rule.forbid !== undefined) parts.push(`must not import ${codeList(rule.forbid)}`);
      return `${codeList(rule.from ?? [])} ${parts.join(" and ")}.`;
    }
    case "state-owner":
      return `Only the owning component may write ${rule.resources ? codeList(rule.resources) : "each declared resource"}.`;
    case "api-stability":
      return `The public API of ${codeList(rule.components)} must not break${rule.allow_growth ? "" : " or grow"}.`;
    case "deprecated":
      return `Nothing new may depend on ${rule.components ? codeList(rule.components) : "deprecated components"}.`;
  }
}

export interface Constraints {
  mayOnly: string[];
  may: string[];
  mustNot: string[];
}

/** Dependency constraints on one component from the active rules, one entry per rule. */
export function constraintsFor(component: string, rules: readonly Rule[], architecture: Architecture): Constraints {
  const result: Constraints = { mayOnly: [], may: [], mustNot: [] };
  const names = (selectors: readonly string[]) => selectors.includes(component) || selectors.includes("*");
  const add = (list: string[], targets: readonly string[], rule: Rule) => {
    const others = targets.filter((t) => t !== component);
    if (others.length > 0) list.push(`${codeList(others)} (rule ${code(rule.id)})`);
  };
  for (const rule of rules) {
    if (rule.level === "off") continue;
    if (rule.kind === "forbid" && names(rule.from)) add(result.mustNot, rule.to, rule);
    if (rule.kind === "allow-only" && names(rule.from)) {
      result.mayOnly.push(`${rule.to.length > 0 ? codeList(rule.to) : "nothing else"} (rule ${code(rule.id)})`);
    }
    if (rule.kind === "independent" && rule.members.includes(component)) add(result.mustNot, rule.members, rule);
    if (rule.kind === "deprecated") add(result.mustNot, rule.components ?? deprecatedIds(architecture), rule);
    if (rule.kind === "layers") {
      const at = rule.layers.findIndex((l) => layerMembers(l).includes(component));
      if (at < 0) continue;
      const below = rule.layers.slice(at + 1, rule.allow_skip ? undefined : at + 2).flatMap(layerMembers);
      add(result.may, below, rule);
      add(result.mustNot, rule.layers.slice(0, at).flatMap(layerMembers), rule);
    }
  }
  return result;
}

/** Governs entries: "*", a component id, or a path glob. */
export function governsMatch(
  governs: readonly string[],
  architecture: Architecture,
  components: ReadonlySet<string>,
  paths: readonly string[],
): { specific: string | null; wildcard: boolean } {
  let specific: string | null = null;
  let wildcard = false;
  for (const entry of governs) {
    if (entry === "*") wildcard = true;
    else if (architecture.components.some((c) => c.id === entry)) {
      if (specific === null && components.has(entry)) specific = `governs component ${entry}`;
    } else if (specific === null) {
      const match = globMatcher([entry]);
      const hit = paths.find((p) => match(p));
      if (hit !== undefined) specific = `governs ${hit}`;
    }
  }
  return { specific, wildcard };
}
