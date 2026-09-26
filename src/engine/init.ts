import { basename, join } from "node:path";
import { buildGraph, DEFAULT_ANALYZERS, discoverWorkspaces, selectFiles, WorktreeSource } from "../analysis/index.ts";
import {
  ArchitectureSchema,
  BaselineSchema,
  ComponentIndex,
  RulesFileSchema,
  SettingsSchema,
  type Component,
  type Decision,
} from "../model/index.ts";
import { componentGraph, evaluateRules, updateBaseline } from "../rules/index.ts";
import {
  CONTRACT_PATHS,
  decisionPath,
  loadContract,
  renderDecision,
  serializeArchitecture,
  serializeBaseline,
  serializeRules,
  writeRepoFile,
} from "../store/index.ts";
import { UsageError } from "./errors.ts";
import { inferComponents, inferLayers } from "./infer.ts";
import { findRoot, resolveToday } from "./workspace.ts";

export interface InitOptions {
  /** Write empty files for designing a new system instead of mapping the current code. */
  blank?: boolean;
  /** Regenerate the map, rules, and baseline when they already exist. */
  force?: boolean;
  today?: string;
}

export interface InitResult {
  root: string;
  written: string[];
  components: Component[];
  layers: string[][];
  excluded: string[];
  adrDirs: string[];
  baselined: number;
  decisions: string[];
}

const ADR_DIR_CANDIDATES = ["docs/adr", "docs/adrs", "doc/adr", "docs/decisions", "docs/architecture/decisions", "adr", "architecture/decisions"];
const RECORD_TITLE = "Record architecture decisions";
const MAP_TITLE = "Initial architecture map";

export async function runInit(cwd: string, options: InitOptions = {}): Promise<InitResult> {
  const root = await findRoot(cwd);
  const today = resolveToday(options.today);
  const source = new WorktreeSource(root);
  const existing = await loadContract(source, { today });
  if (existing.present.architecture && !options.force) {
    throw new UsageError(`${CONTRACT_PATHS.architecture} already exists. Use --force to regenerate the map, rules, and baseline.`);
  }
  const listed = await source.listFiles();
  const adrDirs = ADR_DIR_CANDIDATES.filter((dir) => listed.some((file) => file.startsWith(`${dir}/`) && /^\d+/.test(basename(file)) && file.endsWith(".md")));
  const name = basename(root);
  const written: string[] = [];
  const write = async (path: string, text: string) => {
    await writeRepoFile(root, path, text);
    written.push(path);
  };

  if (options.blank) {
    await write(CONTRACT_PATHS.architecture, serializeArchitecture({ version: 1, name, components: [], ...(adrDirs.length > 0 ? { settings: { adr_dirs: adrDirs } } : {}) }));
    await write(CONTRACT_PATHS.rules, serializeRules({ version: 1, rules: [] }));
    await write(CONTRACT_PATHS.baseline, serializeBaseline(BaselineSchema.parse({})));
    const decisions = await writeStarterDecisions(starterIds(existing.decisions), today, [], [], write);
    await write(`${CONTRACT_PATHS.dir}/.gitignore`, "cache/\n");
    return { root, written, components: [], layers: [], excluded: [], adrDirs, baselined: 0, decisions };
  }

  const workspaces = await discoverWorkspaces(source, listed);
  const extensions = DEFAULT_ANALYZERS.flatMap((analyzer) => analyzer.extensions);
  const analyzable = selectFiles(listed, SettingsSchema.parse({}), extensions);
  const { components, exclude } = inferComponents(analyzable, workspaces);
  const settings = {
    ...(exclude.length > 0 ? { exclude } : {}),
    ...(adrDirs.length > 0 ? { adr_dirs: adrDirs } : {}),
  };
  const architectureInput = { version: 1 as const, name, components, ...(Object.keys(settings).length > 0 ? { settings } : {}) };
  const architecture = ArchitectureSchema.parse(architectureInput);

  const { graph } = await buildGraph(source, architecture, { cacheDir: join(root, CONTRACT_PATHS.cache) });
  const layers = inferLayers(componentGraph(graph, new ComponentIndex(architecture.components, graph.workspaces)));
  const ids = starterIds(existing.decisions);
  // The rules cite the map decision, which exists only when components were found.
  const cited = components.length > 0 ? ids.map.id : ids.record.id;
  const rulesInput = {
    version: 1 as const,
    rules: [
      {
        id: "no-cycles",
        kind: "acyclic" as const,
        level: "warn" as const,
        description: "Components must not depend on each other in a cycle.",
        because: [cited],
      },
      ...(layers.length >= 2
        ? [
            {
              id: "inferred-layers",
              kind: "layers" as const,
              level: "warn" as const,
              description: "The dependency direction observed when Architect was set up. Review it, then raise it to error with a decision.",
              layers: layers.map((layer) => (layer.length === 1 ? (layer[0] ?? "") : layer)),
              because: [cited],
            },
          ]
        : []),
    ],
  };
  const rules = RulesFileSchema.parse(rulesInput);
  const findings = evaluateRules({ graph, architecture, rules, today });
  const baseline = updateBaseline(BaselineSchema.parse({}), findings, { allowGrow: true }).baseline;

  await write(CONTRACT_PATHS.architecture, serializeArchitecture(architectureInput));
  await write(CONTRACT_PATHS.rules, serializeRules(rulesInput));
  await write(CONTRACT_PATHS.baseline, serializeBaseline(baseline));
  const decisions = await writeStarterDecisions(ids, today, components, layers, write);
  await write(`${CONTRACT_PATHS.dir}/.gitignore`, "cache/\n");
  return {
    root,
    written,
    components,
    layers,
    excluded: exclude,
    adrDirs,
    baselined: baseline.entries.reduce((sum, entry) => sum + entry.count, 0),
    decisions,
  };
}

/** The next free decision ids after every existing one, native or imported. */
function nextIds(decisions: readonly Decision[], count: number): string[] {
  const highest = decisions.reduce((max, decision) => Math.max(max, Number.parseInt(decision.id, 10) || 0), 0);
  return Array.from({ length: count }, (_, i) => String(highest + i + 1).padStart(4, "0"));
}

interface StarterId {
  id: string;
  /** The existing native decision with this title, which init reuses instead of adding a duplicate. */
  existing?: Decision;
}

/** Ids for the two starter decisions: existing ones are reused (so init --force never stacks duplicates), new ones take the next free ids. */
function starterIds(decisions: readonly Decision[]): { record: StarterId; map: StarterId } {
  const find = (title: string) => decisions.find((decision) => !decision.imported && decision.title.toLowerCase() === title.toLowerCase());
  const fresh = nextIds(decisions, 2);
  const take = () => fresh.shift() ?? "0001";
  const record = find(RECORD_TITLE);
  const map = find(MAP_TITLE);
  const recordId: StarterId = record ? { id: record.id, existing: record } : { id: take() };
  const mapId: StarterId = map ? { id: map.id, existing: map } : { id: take() };
  return { record: recordId, map: mapId };
}

async function writeStarterDecisions(
  ids: { record: StarterId; map: StarterId },
  today: string,
  components: readonly Component[],
  layers: readonly string[][],
  write: (path: string, text: string) => Promise<void>,
): Promise<string[]> {
  const written: string[] = [];
  if (ids.record.existing === undefined) {
    const recordId = ids.record.id;
    await write(
      decisionPath(recordId, RECORD_TITLE),
      renderDecision({
        id: recordId,
        title: RECORD_TITLE,
        status: "accepted",
        date: today,
        context:
          "Design knowledge lives in people's heads and in scattered documents, and coding agents cannot see it. We need a record of significant decisions that agents and reviewers read before changing code, and that the rules in .architect/rules.yaml can cite.",
        options: [
          "Record decisions as MADR files in .architect/decisions, cited by rules",
          "Keep decisions in a wiki",
          "Do not record decisions",
        ],
        outcome: "each decision sits next to the code it governs, is reviewed in pull requests, and can be cited by the rules that enforce it",
        consequences: [
          "Good, because agents receive the reasons behind rules along with the rules.",
          "Good, because loosening a rule requires a decision that lists it in weakens, so CI shows every loosening to reviewers.",
          "Bad, because decisions need upkeep; Architect reports stale ones.",
        ],
      }),
    );
    written.push(recordId);
  }
  // A map decision the team already accepted (or rejected) is theirs; only a still-proposed one is regenerated in place.
  const previousMap = ids.map.existing;
  if (components.length > 0 && (previousMap === undefined || previousMap.status === "proposed")) {
    const mapId = ids.map.id;
    const layerLines = layers.map((layer, i) => `${i + 1}. ${layer.join(", ")}`);
    await write(
      previousMap?.file ?? decisionPath(mapId, MAP_TITLE),
      renderDecision({
        id: mapId,
        title: MAP_TITLE,
        status: "proposed",
        date: today,
        governs: components.map((component) => component.id),
        context: [
          `Architect inferred this map on ${today} from the repository layout (workspace packages and top source folders) and the imports in the code. It describes the code as it is, which may differ from the intended design.`,
          "",
          `Components: ${components.map((component) => component.id).join(", ")}.`,
          ...(layerLines.length > 0 ? ["", "Observed dependency direction, highest layer first:", "", ...layerLines] : []),
        ].join("\n"),
        options: [
          "Adopt the inferred map as a starting point, with warn-level rules and the current violations frozen in the baseline",
          "Design the target architecture first and enforce it right away",
        ],
        outcome:
          "it makes the current structure visible without blocking work. The team reviews the components and layers, accepts or edits this decision, and raises rules to error with decisions of their own",
        consequences: [
          "Good, because agents see the component boundaries and dependency direction from the first session.",
          "Good, because the baseline lets existing violations shrink over time without blocking new work.",
          "Bad, because an inferred map can encode accidental structure; review it before relying on it.",
        ],
      }),
    );
    written.push(mapId);
  }
  return written;
}

export function formatInit(result: InitResult): string {
  const lines = result.written.map((path) => `Created ${path}`);
  if (result.components.length > 0) {
    lines.push("", `Components (${result.components.length}):`);
    for (const component of result.components) lines.push(`  ${component.id}: ${component.paths.join(", ")}`);
  }
  if (result.layers.length >= 2) {
    lines.push("", "Observed layers, highest first:");
    result.layers.forEach((layer, i) => lines.push(`  ${i + 1}. ${layer.join(", ")}`));
  }
  if (result.excluded.length > 0) lines.push("", `Left out as test code: ${result.excluded.join(", ")}`);
  if (result.adrDirs.length > 0) lines.push(`Imported existing decisions from: ${result.adrDirs.join(", ")}`);
  if (result.baselined > 0) lines.push(`Froze ${result.baselined} existing violations in the baseline.`);
  lines.push(
    "",
    "Next steps:",
    "  1. Review .architect/architecture.yaml and the proposed map decision; fix component boundaries.",
    "  2. Run `architect check` and `architect graph` to see the current state.",
    "  3. Protect the contract in CODEOWNERS, for example: /.architect/ @your-team",
  );
  return lines.join("\n");
}
