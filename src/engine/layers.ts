// Layer names that repeat across components (core/application/adapters folders, or *Core/*Feature/*Adapter
// targets) usually mean a layering convention the team already follows. Init proposes it as a warn-level rule.
import { basename } from "node:path";
import { ComponentIndex, compareText, type Component } from "../model/index.ts";

/** Tiers from the top layer down, as folder names. */
const FOLDER_TIERS: readonly (readonly string[])[] = [
  ["adapters", "adapter", "infrastructure", "infra", "presentation"],
  ["application", "usecases", "use_cases", "use-cases", "features", "feature"],
  ["domain", "core"],
];

/** Tiers from the top layer down, as name suffixes of components (ChatAdapter, chat-feature, chat_core). */
const SUFFIX_TIERS: readonly (readonly string[])[] = [
  ["adapter", "adapters", "infrastructure", "ui"],
  ["feature", "features", "application"],
  ["core", "domain"],
];

export interface LayerProposal {
  /** Selector groups, highest layer first. */
  layers: string[][];
  /** One sentence on what was found, for the map decision. */
  evidence: string;
}

/** A component's name as written: the last folder of its first path, which keeps CamelCase that ids lose. */
function writtenName(component: Component): string {
  return basename(component.paths[0] ?? component.id);
}

function suffixTier(name: string): number {
  const lower = name.toLowerCase();
  for (let tier = 0; tier < SUFFIX_TIERS.length; tier++) {
    for (const word of SUFFIX_TIERS[tier] ?? []) {
      if (lower === word || !lower.endsWith(word)) continue;
      const before = name.slice(0, name.length - word.length);
      const first = name.charAt(name.length - word.length);
      // A separator or a CamelCase boundary: "chat-core" and "ChatCore", never "score".
      if (/[-_.]$/.test(before) || (first === first.toUpperCase() && first !== first.toLowerCase())) return tier;
    }
  }
  return -1;
}

/**
 * Proposes layers from components named by tier suffix (at least three components over two tiers), else from tier
 * folder names repeated inside at least two components. Null when neither convention shows.
 */
export function proposeLayers(files: readonly string[], components: readonly Component[]): LayerProposal | null {
  const byTier: string[][] = SUFFIX_TIERS.map(() => []);
  for (const c of components) {
    const tier = suffixTier(writtenName(c));
    if (tier >= 0) byTier[tier]?.push(c.id);
  }
  const suffixed = byTier.filter((ids) => ids.length > 0);
  if (suffixed.length >= 2 && suffixed.flat().length >= 3) {
    const layers = suffixed.map((ids) => [...ids].sort(compareText));
    return { layers, evidence: `components named by layer suffix: ${layers.map((ids) => ids.join(", ")).join(" above ")}` };
  }

  const index = new ComponentIndex(components);
  const seen = new Map<string, Set<number>>();
  const words = FOLDER_TIERS.map(() => new Set<string>());
  for (const file of files) {
    const component = index.of(file);
    if (component === null) continue;
    const segments = file.split("/").slice(0, -1);
    for (const segment of segments) {
      const tier = FOLDER_TIERS.findIndex((names) => names.includes(segment.toLowerCase()));
      if (tier < 0) continue;
      const tiers = seen.get(component) ?? new Set<number>();
      tiers.add(tier);
      seen.set(component, tiers);
      words[tier]?.add(segment);
    }
  }
  const layered = [...seen].filter(([, tiers]) => tiers.size >= 2).map(([id]) => id).sort(compareText);
  if (layered.length < 2) return null;
  const layers = words.filter((w) => w.size > 0).map((w) => [...w].sort(compareText).map((name) => `path:**/${name}/**`));
  if (layers.length < 2) return null;
  return {
    layers,
    evidence: `layer folders (${words.flatMap((w) => [...w].sort(compareText)).join(", ")}) repeat in ${layered.join(", ")}`,
  };
}
