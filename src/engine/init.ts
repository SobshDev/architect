import { basename, join, posix } from "node:path";
import { buildGraph, readHistory, WorktreeSource } from "../analysis/index.ts";
import {
  ArchitectureSchema,
  BaselineSchema,
  ComponentIndex,
  type Coverage,
  coveragePercent,
  type Evidence,
  globMatcher,
  isLowCoverage,
  notAnalyzedText,
  RulesFileSchema,
  type Component,
  type Decision,
} from "../model/index.ts";
import { componentGraph, evaluateRules, updateBaseline } from "../rules/index.ts";
import {
  CONTRACT_PATHS,
  decisionPath,
  fileDecisionId,
  loadContract,
  renderDecision,
  serializeArchitecture,
  serializeBaseline,
  serializeRules,
  writeRepoFile,
} from "../store/index.ts";
import { UsageError } from "./errors.ts";
import { inferMap } from "./graph.ts";
import { findGuardrails } from "./guardrails.ts";
import { coChangeClusters, inferLayers, previewFiles, type CoChangeCluster } from "./infer.ts";
import { proposeLayers, type LayerProposal } from "./layers.ts";
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
  /** Files that changed together across the inferred components, from git history. */
  coChange: CoChangeCluster[];
  /** What the analyzers read, against every source file of the repository. */
  coverage: Coverage | null;
  /** Layers proposed from repeated layer names, when the layout shows them. */
  layerNames: LayerProposal | null;
  /** Existing boundary rules quoted from docs and scripts. */
  guardrails: Evidence[];
}

const ADR_DIR_CANDIDATES = ["docs/adr", "docs/adrs", "doc/adr", "docs/decisions", "docs/architecture/decisions", "adr", "architecture/decisions"];
const RECORD_TITLE = "Record architecture decisions";
const MAP_TITLE = "Initial architecture map";
const GUARDRAILS_TITLE = "Existing boundary rules";

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
  // The ADRs this init starts importing: the starter decisions take ids after theirs, so no ADR is shadowed.
  const adrIds = listed.flatMap((file) => (adrDirs.includes(posix.dirname(file)) && file.endsWith(".md") ? [fileDecisionId(file) ?? ""] : [])).filter((id) => id !== "");
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
    const decisions = await writeStarterDecisions(starterIds(existing.decisions, adrIds), today, { components: [], layers: [], coChange: [], guardrails: [] }, write);
    await write(`${CONTRACT_PATHS.dir}/.gitignore`, "cache/\n");
    return { root, written, components: [], layers: [], excluded: [], adrDirs, baselined: 0, decisions, coChange: [], coverage: null, layerNames: null, guardrails: [] };
  }

  const { components, exclude } = await inferMap(source);
  const settings = {
    ...(exclude.length > 0 ? { exclude } : {}),
    ...(adrDirs.length > 0 ? { adr_dirs: adrDirs } : {}),
  };
  const architectureInput = { version: 1 as const, name, components, ...(Object.keys(settings).length > 0 ? { settings } : {}) };
  const architecture = ArchitectureSchema.parse(architectureInput);

  const cacheDir = join(root, CONTRACT_PATHS.cache);
  const { graph, coverage } = await buildGraph(source, architecture, { cacheDir });
  const index = new ComponentIndex(architecture.components, graph.workspaces);
  const layers = inferLayers(componentGraph(graph, index));
  const isExcluded = globMatcher(exclude);
  const layerNames = proposeLayers(listed.filter((file) => !isExcluded(file)), components);
  const guardrails = await findGuardrails(source, listed);
  const history = await readHistory(root, graph, architecture, { cacheDir });
  const coChange = history ? coChangeClusters(history.filePairs, (file) => index.of(file)) : [];
  const ids = starterIds(existing.decisions, adrIds);
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
      ...(layerNames !== null
        ? [
            {
              id: "inferred-layer-names",
              kind: "layers" as const,
              level: "warn" as const,
              description: `A layering convention suggested by the layout (${layerNames.evidence}). Review the order, then raise it to error with a decision.`,
              layers: layerNames.layers.map((layer) => (layer.length === 1 ? (layer[0] ?? "") : layer)),
              allow_skip: true,
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
  const decisions = await writeStarterDecisions(ids, today, { components, layers, coChange, guardrails }, write);
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
    coChange,
    coverage,
    layerNames,
    guardrails,
  };
}

/** The next free decision ids after every existing one, native or imported, and after the given taken ids. */
function nextIds(decisions: readonly Decision[], taken: readonly string[], count: number): string[] {
  const highest = [...decisions.map((decision) => decision.id), ...taken].reduce((max, id) => Math.max(max, Number.parseInt(id, 10) || 0), 0);
  return Array.from({ length: count }, (_, i) => String(highest + i + 1).padStart(4, "0"));
}

interface StarterId {
  id: string;
  /** The existing native decision with this title, which init reuses instead of adding a duplicate. */
  existing?: Decision;
}

interface StarterIds {
  record: StarterId;
  map: StarterId;
  guardrails: StarterId;
}

/** Ids for the starter decisions: existing ones are reused (so init --force never stacks duplicates), new ones take the next free ids. */
function starterIds(decisions: readonly Decision[], taken: readonly string[]): StarterIds {
  const find = (title: string) => decisions.find((decision) => !decision.imported && decision.title.toLowerCase() === title.toLowerCase());
  const fresh = nextIds(decisions, taken, 3);
  const take = () => fresh.shift() ?? "0001";
  const pick = (title: string): StarterId => {
    const found = find(title);
    return found ? { id: found.id, existing: found } : { id: take() };
  };
  return { record: pick(RECORD_TITLE), map: pick(MAP_TITLE), guardrails: pick(GUARDRAILS_TITLE) };
}

interface StarterContent {
  components: readonly Component[];
  layers: readonly string[][];
  coChange: readonly CoChangeCluster[];
  guardrails: readonly Evidence[];
}

async function writeStarterDecisions(
  ids: StarterIds,
  today: string,
  content: StarterContent,
  write: (path: string, text: string) => Promise<void>,
): Promise<string[]> {
  const { components, layers, coChange, guardrails } = content;
  const written: string[] = [];
  if (ids.record.existing === undefined) {
    const recordId = ids.record.id;
    await write(
      decisionPath(recordId, RECORD_TITLE),
      renderDecision({
        id: recordId,
        title: RECORD_TITLE,
        // People accept decisions; init only proposes, this one included.
        status: "proposed",
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
    const coChangeLines = coChange.slice(0, 5).map((c) => `- ${c.components.join(", ")} (${c.support} commits): ${previewFiles(c.files)}`);
    await write(
      previousMap?.file ?? decisionPath(mapId, MAP_TITLE),
      renderDecision({
        id: mapId,
        title: MAP_TITLE,
        status: "proposed",
        date: today,
        governs: components.map((component) => component.id),
        context: [
          `Architect inferred this map on ${today} from the repository layout (workspace packages, crates, and source folders in every language) and the dependencies it can read. It describes the code as it is, which may differ from the intended design.`,
          "",
          `Components: ${components.map((component) => component.id).join(", ")}.`,
          ...(layerLines.length > 0 ? ["", "Observed dependency direction, highest layer first:", "", ...layerLines] : []),
          ...(coChangeLines.length > 0
            ? ["", "Files that changed together across these components, from git history; a boundary may cut through one reason to change:", "", ...coChangeLines]
            : []),
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
  // Like the map, a guardrails decision the team already accepted or rejected is theirs.
  const previousGuardrails = ids.guardrails.existing;
  if (guardrails.length > 0 && (previousGuardrails === undefined || previousGuardrails.status === "proposed")) {
    const id = ids.guardrails.id;
    const sources = [...new Set(guardrails.map((g) => g.source))];
    await write(
      previousGuardrails?.file ?? decisionPath(id, GUARDRAILS_TITLE),
      renderDecision({
        id,
        title: GUARDRAILS_TITLE,
        status: "proposed",
        date: today,
        evidence: [...guardrails],
        context: [
          `The repository already states boundary rules in ${sources.join(", ")}. They are quoted verbatim in the evidence of this decision. Nothing checks prose, so agents and reviewers have to remember them.`,
        ].join("\n"),
        options: ["Turn each statement into a rule in .architect/rules.yaml that cites this decision", "Keep the rules as prose only"],
        outcome: "a checked rule fails the build when an edit breaks it, while prose depends on every agent reading and following it",
        consequences: [
          "Good, because the existing rules are enforced on every change, for agents and people alike.",
          "Bad, because some statements may be out of date; review each quote before encoding it.",
        ],
      }),
    );
    written.push(id);
  }
  return written;
}

export function formatInit(result: InitResult): string {
  const lines: string[] = [];
  const c = result.coverage;
  if (c !== null && c.source_files > c.files_analyzed) {
    const summary = `Architect analyzes ${c.files_analyzed} of ${c.source_files} source files (${coveragePercent(c)}); not analyzed: ${notAnalyzedText(c)}.`;
    if (isLowCoverage(c)) {
      lines.push(
        `WARNING: ${summary}`,
        "Rules, metrics, and context briefs see only the analyzed files, so a clean check says nothing about the rest. History (hotspots, co-change) covers every file, and Cargo.toml manifests give crate-level dependencies.",
        "",
      );
    } else {
      lines.push(summary, "");
    }
  }
  lines.push(...result.written.map((path) => `Created ${path}`));
  if (result.components.length > 0) {
    lines.push("", `Components (${result.components.length}):`);
    for (const component of result.components) lines.push(`  ${component.id}: ${component.paths.join(", ")}`);
  }
  if (result.layers.length >= 2) {
    lines.push("", "Observed layers, highest first:");
    result.layers.forEach((layer, i) => lines.push(`  ${i + 1}. ${layer.join(", ")}`));
  }
  if (result.layerNames !== null) {
    lines.push("", `Proposed layers from ${result.layerNames.evidence} (rule inferred-layer-names, warn):`);
    result.layerNames.layers.forEach((layer, i) => lines.push(`  ${i + 1}. ${layer.join(", ")}`));
  }
  if (result.guardrails.length > 0) {
    const sources = [...new Set(result.guardrails.map((g) => g.source))];
    const count = result.guardrails.length === 1 ? "1 existing boundary rule" : `${result.guardrails.length} existing boundary rules`;
    lines.push("", `Quoted ${count} from ${sources.join(", ")} in a proposed decision; turn them into checked rules.`);
  }
  if (result.excluded.length > 0) lines.push("", `Left out as test code: ${result.excluded.join(", ")}`);
  if (result.coChange.length > 0) {
    lines.push("", "Files that change together across components (review these boundaries):");
    for (const c of result.coChange) lines.push(`  ${c.components.join(" + ")}, ${c.support} commits: ${previewFiles(c.files)}`);
  }
  if (result.adrDirs.length > 0) lines.push(`Imported existing decisions from: ${result.adrDirs.join(", ")}`);
  if (result.baselined > 0) lines.push(`Froze ${result.baselined} existing violations in the baseline.`);
  lines.push(
    "",
    "Next steps:",
    "  1. Review .architect/architecture.yaml and the proposed decisions; fix component boundaries.",
    "  2. Accept the decisions you agree with: set status: accepted. Architect only proposes.",
    "  3. Run `architect check` and `architect graph` to see the current state.",
    "  4. Protect the contract in CODEOWNERS, for example: /.architect/ @your-team",
  );
  return lines.join("\n");
}
