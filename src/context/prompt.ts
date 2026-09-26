// Decides whether a user prompt is about the architecture, and what it names.
import { type Architecture, ComponentIndex, type Decision, toRepoPath, tokenize } from "../model/index.ts";
import { build, namedComponents } from "./build.ts";
import type { ContextBrief, ContextInput, PromptMatch } from "./types.ts";

const PROBES = ["__architect_probe__.ts", "__architect_probe__.tsx", "__architect_probe__.js", "__architect_probe__.py", "__architect_probe__/__architect_probe__.ts"];

/** Tokens that look like repo paths or file names. */
function pathTokens(prompt: string): string[] {
  const tokens: string[] = [];
  for (const raw of prompt.split(/\s+/)) {
    const token = raw.replace(/^[`"'([{<]+/, "").replace(/[`"')\]}>,;:!?.]+$/, "");
    if (token === "" || token.includes("://") || token.startsWith("/")) continue;
    const folder = raw.replace(/[`"')\]}>,;:!?]+$/, "").endsWith("/");
    if (token.includes("/") || /\.[A-Za-z0-9]{1,6}$/.test(token) || folder) tokens.push(toRepoPath(token));
  }
  return tokens.filter((t) => t !== "" && t !== "." && !t.startsWith("../"));
}

function componentOfPath(path: string, index: ComponentIndex): string | null {
  const direct = index.of(path);
  if (direct !== null) return direct;
  for (const probe of PROBES) {
    const hit = index.of(`${path}/${probe}`);
    if (hit !== null) return hit;
  }
  return null;
}

function significantTerms(text: string): Set<string> {
  return new Set(tokenize(text).filter((t) => t.length >= 3));
}

/**
 * Matches a prompt that names a component id, a path inside a component, or at least two distinct
 * significant terms from one decision title. Returns null when nothing matches.
 */
export function matchPrompt(prompt: string, architecture: Architecture, decisions: readonly Decision[]): PromptMatch | null {
  const index = new ComponentIndex(architecture.components);
  const components = new Set(namedComponents(prompt, architecture));
  const paths = new Set<string>();
  for (const token of pathTokens(prompt)) {
    const component = componentOfPath(token, index);
    if (component === null) continue;
    paths.add(token);
    components.add(component);
  }
  const promptTerms = significantTerms(prompt);
  const matched = decisions
    .filter((d) => [...significantTerms(d.title)].filter((t) => promptTerms.has(t)).length >= 2)
    .map((d) => d.id);
  if (components.size === 0 && paths.size === 0 && matched.length === 0) return null;
  return { components: [...components].sort(), paths: [...paths].sort(), decisions: [...new Set(matched)].sort() };
}

/** A brief for the matched components, paths, and decisions (matched decisions rank first), at most 800 tokens. */
export function promptBrief(input: ContextInput, match: PromptMatch): ContextBrief {
  const paths = [...(input.paths ?? []), ...match.paths];
  return build({ ...input, paths }, { cap: 800, components: match.components, pinned: match.decisions });
}
