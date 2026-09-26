import { posix } from "node:path";
import picomatch from "picomatch";
import {
  type Architecture,
  ArchitectureSchema,
  type Baseline,
  BaselineSchema,
  type ConfigIssue,
  type Decision,
  dirOf,
  type FileSource,
  type RulesFile,
  RulesFileSchema,
} from "../model/index.ts";
import { CONTRACT_PATHS } from "./contract-paths.ts";
import { fileDecisionId, parseDecision } from "./decision.ts";
import { cmp, compareIssues, issue, readYaml, salvage } from "./parse.ts";
import { validateContract } from "./validate.ts";

export interface Contract {
  architecture: Architecture;
  /** With expired waivers removed. */
  rules: RulesFile;
  /** Sorted by id. Imported decisions whose id is already taken are dropped with a warning. */
  decisions: Decision[];
  baseline: Baseline;
  /** Sorted by file, path, message. */
  issues: ConfigIssue[];
  present: { architecture: boolean; rules: boolean; baseline: boolean; decisions: number };
}

function readJson(file: string, text: string): { value: unknown; issues: ConfigIssue[] } {
  try {
    return { value: JSON.parse(text) as unknown, issues: [] };
  } catch (error) {
    return { value: null, issues: [issue("error", file, `JSON syntax error: ${(error as Error).message}`)] };
  }
}

function adrDirMatcher(globs: readonly string[]): (dir: string) => boolean {
  const patterns = globs.map((g) => g.replace(/^\.\//, "").replace(/\/+$/, "")).filter((g) => g !== "");
  return patterns.length === 0 ? () => false : picomatch(patterns, { dot: true });
}

/** Reads and validates the .architect/ contract of one version of a repository. Missing files fall back to defaults. */
export async function loadContract(source: FileSource, options: { today: string }): Promise<Contract> {
  const issues: ConfigIssue[] = [];
  const files = await source.listFiles();
  const texts = await source.readFiles([CONTRACT_PATHS.architecture, CONTRACT_PATHS.rules, CONTRACT_PATHS.baseline]);

  const rawYaml = (file: string): unknown => {
    const text = texts.get(file);
    if (text === undefined) return {};
    const parsed = readYaml(file, text, "error");
    issues.push(...parsed.issues);
    return parsed.value;
  };
  const architectureParsed = salvage(ArchitectureSchema, rawYaml(CONTRACT_PATHS.architecture), CONTRACT_PATHS.architecture, "error");
  const rulesParsed = salvage(RulesFileSchema, rawYaml(CONTRACT_PATHS.rules), CONTRACT_PATHS.rules, "error");
  issues.push(...architectureParsed.issues, ...rulesParsed.issues);
  const architecture: Architecture = architectureParsed.value;
  const rules: RulesFile = rulesParsed.value;

  const baselineText = texts.get(CONTRACT_PATHS.baseline);
  const baselineRaw = baselineText === undefined ? { value: {}, issues: [] } : readJson(CONTRACT_PATHS.baseline, baselineText);
  issues.push(...baselineRaw.issues);
  const baselineParsed = salvage(BaselineSchema, baselineRaw.value, CONTRACT_PATHS.baseline, "error");
  issues.push(...baselineParsed.issues);

  const nativeFiles: string[] = [];
  const importedFiles: string[] = [];
  const inAdrDir = adrDirMatcher(architecture.settings.adr_dirs);
  for (const file of files) {
    if (posix.extname(file).toLowerCase() !== ".md") continue;
    const dir = dirOf(file);
    if (dir === CONTRACT_PATHS.decisions) {
      if (fileDecisionId(file) === null) issues.push(issue("warn", file, "decision file names must start with a number, such as 0007-use-postgres.md; skipped"));
      else nativeFiles.push(file);
    } else if (inAdrDir(dir) && fileDecisionId(file) !== null) {
      importedFiles.push(file);
    }
  }
  const decisionTexts = await source.readFiles([...nativeFiles, ...importedFiles]);
  const decisions: Decision[] = [];
  const nativeIds = new Set<string>();
  const load = (file: string, imported: boolean): Decision | null => {
    const text = decisionTexts.get(file);
    if (text === undefined) return null;
    const parsed = parseDecision(file, text, { imported });
    issues.push(...parsed.issues);
    return parsed.decision;
  };
  for (const file of nativeFiles) {
    const decision = load(file, false);
    if (decision === null) continue;
    decisions.push(decision);
    nativeIds.add(decision.id);
  }
  const importedIds = new Set<string>();
  for (const file of importedFiles) {
    const decision = load(file, true);
    if (decision === null) continue;
    if (nativeIds.has(decision.id) || importedIds.has(decision.id)) {
      issues.push(issue("warn", file, `decision id ${decision.id} is already used by another decision; skipped`));
      continue;
    }
    importedIds.add(decision.id);
    decisions.push(decision);
  }
  decisions.sort((a, b) => cmp(a.id, b.id) || cmp(a.file, b.file));

  const validated = validateContract({ architecture, rules, decisions }, options);
  issues.push(...validated.issues);
  issues.sort(compareIssues);

  return {
    architecture,
    rules: validated.rules,
    decisions,
    baseline: baselineParsed.value,
    issues,
    present: {
      architecture: texts.has(CONTRACT_PATHS.architecture),
      rules: texts.has(CONTRACT_PATHS.rules),
      baseline: baselineText !== undefined,
      decisions: nativeFiles.length,
    },
  };
}
