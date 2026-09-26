// Every file format and wire shape Architect reads or writes, defined once.
// Types are inferred from these schemas; nothing else redeclares them.
import { z } from "zod";

export const Id = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, { error: "use lowercase letters, digits, '.', '_' or '-', starting with a letter or digit" });
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { error: "use an ISO date such as 2026-09-26" });
const Globs = z.array(z.string().min(1));

// ---------------------------------------------------------------- architecture.yaml

export const DeprecationSchema = z.union([
  z.boolean(),
  z.strictObject({
    reason: z.string().min(1),
    replacement: Id.optional(),
    since: IsoDate.optional(),
  }),
]);

export const ComponentSchema = z.strictObject({
  id: Id,
  description: z.string().optional(),
  /** Ordered globs. A file belongs to the first component (in file order) whose globs match it. */
  paths: Globs.min(1),
  kind: z.string().optional(),
  owner: z.string().optional(),
  /** Workspace package name, when the component is a package. */
  package: z.string().optional(),
  /** Globs of the files other components may import. */
  entrypoints: Globs.optional(),
  deprecated: DeprecationSchema.optional(),
});

export const WritePresetSchema = z.enum(["convex", "prisma", "drizzle", "sql", "sqlalchemy", "django"]);

export const WriteMatcherSchema = z
  .strictObject({
    preset: WritePresetSchema.optional(),
    /** Regular expression source matched against each line. */
    pattern: z.string().optional(),
    /** Name used for the resource in code (table, model, collection). Defaults to the resource id. */
    name: z.string().optional(),
  })
  .refine((m) => m.preset !== undefined || m.pattern !== undefined, { error: "a write matcher needs a preset or a pattern" });

export const ResourceSchema = z.strictObject({
  id: z.string().min(1),
  kind: z.string().optional(),
  owner: Id,
  description: z.string().optional(),
  writes: z.array(WriteMatcherSchema).default([]),
});

export const HistorySettingsSchema = z.strictObject({
  months: z.number().int().positive().default(12),
  max_files_per_commit: z.number().int().positive().default(50),
  min_support: z.number().int().positive().default(5),
  min_confidence: z.number().min(0).max(1).default(0.5),
});

export const SettingsSchema = z.strictObject({
  /** Globs of files to analyze. Defaults to every supported source file. */
  include: Globs.optional(),
  /** Extra globs to skip, on top of the built-in excludes (node_modules, build output, vendored code). */
  exclude: Globs.default([]),
  /** Python source roots. Defaults to pyproject/setup.cfg settings, then "src" and ".". */
  source_roots: Globs.optional(),
  /** tsconfig file(s). Defaults to the nearest tsconfig.json above each file. */
  tsconfig: z.union([z.string(), Globs]).optional(),
  /** Folders of existing MADR decision records to import, such as docs/adr. */
  adr_dirs: Globs.default([]),
  history: HistorySettingsSchema.prefault({}),
});

export const ArchitectureSchema = z.strictObject({
  version: z.literal(1).default(1),
  name: z.string().optional(),
  description: z.string().optional(),
  components: z.array(ComponentSchema).default([]),
  resources: z.array(ResourceSchema).default([]),
  settings: SettingsSchema.prefault({}),
});

// ---------------------------------------------------------------- rules.yaml

export const RuleLevelSchema = z.enum(["error", "warn", "off"]);
/** A component id, "path:<glob>", "pkg:<name glob>", or "*" for every internal file. */
export const SelectorSchema = z.string().min(1);
const Selectors = z.array(SelectorSchema);

const ruleBase = {
  id: Id,
  description: z.string().optional(),
  level: RuleLevelSchema.default("error"),
  /** Decision ids that justify the rule. Required when the level is error. */
  because: z.array(z.string().min(1)).default([]),
  include_type_imports: z.boolean().default(true),
};

const needsBecause = (rule: { level: string; because: string[] }): boolean => rule.level !== "error" || rule.because.length > 0;
const needsBecauseError = { error: "rules at level error must cite at least one decision in because", path: ["because"] };

export const ForbidRuleSchema = z
  .strictObject({ ...ruleBase, kind: z.literal("forbid"), from: Selectors.min(1), to: Selectors.min(1) })
  .refine(needsBecause, needsBecauseError);

export const AllowOnlyRuleSchema = z
  .strictObject({
    ...ruleBase,
    kind: z.literal("allow-only"),
    from: Selectors.min(1),
    /** Targets the from side may depend on, besides its own component. */
    to: Selectors.default([]),
    /** "internal" restricts internal files only; "all" also restricts external packages to pkg: selectors in to. */
    scope: z.enum(["internal", "all"]).default("internal"),
  })
  .refine(needsBecause, needsBecauseError);

export const LayersRuleSchema = z
  .strictObject({
    ...ruleBase,
    kind: z.literal("layers"),
    /** Highest layer first. A layer may depend on layers after it, never on layers before it. */
    layers: z.array(z.union([SelectorSchema, Selectors.min(1)])).min(2),
    /** When false, a layer may depend only on the layer directly after it. */
    allow_skip: z.boolean().default(true),
  })
  .refine(needsBecause, needsBecauseError);

export const AcyclicRuleSchema = z
  .strictObject({
    ...ruleBase,
    kind: z.literal("acyclic"),
    scope: z.enum(["components", "files"]).default("components"),
    /** Limits the check to these selectors. */
    within: Selectors.optional(),
  })
  .refine(needsBecause, needsBecauseError);

export const IndependentRuleSchema = z
  .strictObject({ ...ruleBase, kind: z.literal("independent"), members: Selectors.min(2) })
  .refine(needsBecause, needsBecauseError);

export const EntrypointsRuleSchema = z
  .strictObject({
    ...ruleBase,
    kind: z.literal("entrypoints"),
    targets: Selectors.min(1),
    /** Overrides the targets' own entrypoints. */
    entrypoints: Globs.optional(),
  })
  .refine(needsBecause, needsBecauseError);

export const ExternalImportsRuleSchema = z
  .strictObject({
    ...ruleBase,
    kind: z.literal("external-imports"),
    /** Form 1: restrict what these files may import. */
    from: Selectors.optional(),
    allow: z.array(z.string().min(1)).optional(),
    forbid: z.array(z.string().min(1)).optional(),
    /** Form 2: restrict who may import these packages. */
    packages: z.array(z.string().min(1)).optional(),
    allow_from: Selectors.optional(),
    /** Built-in modules (node:*, bun:*, Python stdlib) are always allowed unless this is false. */
    allow_builtins: z.boolean().default(true),
  })
  .refine(
    (r) =>
      (r.packages !== undefined && r.allow_from !== undefined && r.from === undefined && r.allow === undefined && r.forbid === undefined) ||
      (r.from !== undefined && (r.allow !== undefined || r.forbid !== undefined) && r.packages === undefined && r.allow_from === undefined),
    { error: "external-imports takes either packages + allow_from, or from + allow/forbid" },
  )
  .refine(needsBecause, needsBecauseError);

export const StateOwnerRuleSchema = z
  .strictObject({
    ...ruleBase,
    kind: z.literal("state-owner"),
    level: RuleLevelSchema.default("warn"),
    /** Resource ids to check. Defaults to every resource. */
    resources: z.array(z.string().min(1)).optional(),
  })
  .refine(needsBecause, needsBecauseError);

export const ApiStabilityRuleSchema = z
  .strictObject({
    ...ruleBase,
    kind: z.literal("api-stability"),
    components: Selectors.min(1),
    /** When false, new exports at entrypoints are reported as warnings. */
    allow_growth: z.boolean().default(true),
  })
  .refine(needsBecause, needsBecauseError);

export const DeprecatedRuleSchema = z
  .strictObject({
    ...ruleBase,
    kind: z.literal("deprecated"),
    /** Components that must not gain dependents. Defaults to components marked deprecated. */
    components: Selectors.optional(),
  })
  .refine(needsBecause, needsBecauseError);

export const RuleSchema = z.discriminatedUnion("kind", [
  ForbidRuleSchema,
  AllowOnlyRuleSchema,
  LayersRuleSchema,
  AcyclicRuleSchema,
  IndependentRuleSchema,
  EntrypointsRuleSchema,
  ExternalImportsRuleSchema,
  StateOwnerRuleSchema,
  ApiStabilityRuleSchema,
  DeprecatedRuleSchema,
]);

export const WaiverSchema = z.strictObject({
  rule: Id,
  /** Selector for the source side of the waived findings. */
  from: SelectorSchema,
  /** Selector for the target side. Omit to waive every target. */
  to: SelectorSchema.optional(),
  reason: z.string().min(1),
  /** Must be at most 180 days after the day the rules are loaded. */
  expires: IsoDate,
  decision: z.string().optional(),
});

export const RulesFileSchema = z.strictObject({
  version: z.literal(1).default(1),
  rules: z.array(RuleSchema).default([]),
  waivers: z.array(WaiverSchema).default([]),
});

// ---------------------------------------------------------------- decisions/NNNN-slug.md

export const DecisionStatusSchema = z.enum(["proposed", "accepted", "rejected", "deprecated", "superseded"]);

export const AssumptionSchema = z
  .strictObject({
    text: z.string().min(1),
    /** Rule id that keeps the assumption true. */
    check: z.string().optional(),
    review_by: IsoDate.optional(),
  })
  .refine((a) => a.check !== undefined || a.review_by !== undefined, { error: "an assumption needs a check (rule id) or a review_by date" });

export const EvidenceSchema = z.strictObject({
  /** A repo path, git:<sha>:<path>, or an http(s) URL. */
  source: z.string().min(1),
  /** Text that appears verbatim in the source. */
  quote: z.string().min(1),
  note: z.string().optional(),
});

const StringOrList = z.union([z.string(), z.array(z.string())]);

/** Front matter as written. MADR allows extra fields, so unknown keys pass through. */
export const DecisionFrontMatterSchema = z.looseObject({
  title: z.string().optional(),
  status: z.string().optional(),
  date: z.string().optional(),
  "decision-makers": StringOrList.optional(),
  consulted: StringOrList.optional(),
  informed: StringOrList.optional(),
  governs: z.array(z.string()).default([]),
  supersedes: z.array(z.string()).default([]),
  "superseded-by": z.string().optional(),
  weakens: z.array(z.string()).default([]),
  assumptions: z.array(AssumptionSchema).default([]),
  evidence: z.array(EvidenceSchema).default([]),
});

/** A decision after parsing and normalization. */
export const DecisionSchema = z.object({
  id: z.string(),
  file: z.string(),
  title: z.string(),
  status: DecisionStatusSchema,
  superseded_by: z.string().optional(),
  date: z.string().optional(),
  decision_makers: z.array(z.string()),
  /** Component ids or path globs the decision governs. */
  governs: z.array(z.string()),
  supersedes: z.array(z.string()),
  /** Rule ids (or "baseline") whose loosening this decision approves. */
  weakens: z.array(z.string()),
  assumptions: z.array(AssumptionSchema),
  evidence: z.array(EvidenceSchema),
  body: z.string(),
  /** True when loaded from settings.adr_dirs instead of .architect/decisions. */
  imported: z.boolean(),
});

// ---------------------------------------------------------------- baseline.json

export const BaselineEntrySchema = z.strictObject({
  fingerprint: z.string().min(1),
  rule: z.string().min(1),
  count: z.number().int().positive(),
  /** Source file of an edge finding. Cycle and other keyed findings omit it. */
  file: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  message: z.string().optional(),
});

export const BaselineSchema = z.strictObject({
  schema_version: z.literal(1).default(1),
  entries: z.array(BaselineEntrySchema).default([]),
});

// ---------------------------------------------------------------- knowledge cards

export const CardKindSchema = z.enum(["principle", "smell", "pattern"]);

export const CardSourceSchema = z.strictObject({
  title: z.string().optional(),
  url: z.string().min(1),
  retrieved: IsoDate,
  /** SPDX id (MIT, CC0-1.0, CC-BY-4.0, CC-BY-SA-4.0), "proprietary" for books and papers, or "none". */
  license: z.string().min(1),
  relation: z.enum(["adapted", "see-also"]),
  /** What changed relative to the source. Required when relation is adapted. */
  changes: z.string().optional(),
});

export const CardFrontMatterSchema = z.strictObject({
  id: Id,
  kind: CardKindSchema,
  title: z.string().min(1),
  summary: z.string().min(1),
  problem: z.string().min(1),
  forces: z.array(z.string()).default([]),
  use_when: z.array(z.string()).default([]),
  avoid_when: z.array(z.string()).default([]),
  tradeoffs: z.array(z.string()).default([]),
  code_signals: z.array(z.string()).default([]),
  contract_templates: z.array(z.string()).default([]),
  related: z.array(z.string()).default([]),
  sources: z.array(CardSourceSchema).min(1),
});

export const CardSchema = CardFrontMatterSchema.extend({
  body: z.string(),
  file: z.string(),
  pack: z.enum(["core", "cc-by"]),
});

// ---------------------------------------------------------------- findings and reports

export const FindingLevelSchema = z.enum(["error", "warn", "info"]);
/**
 * new: not in the baseline (and, in diff mode, not present at base).
 * existing: diff mode only; present at base and not baselined. Reported, never fails a run.
 * baselined: matched a baseline entry. waived: matched an unexpired waiver.
 */
export const FindingStatusSchema = z.enum(["new", "existing", "baselined", "waived"]);

export const LocationSchema = z.object({
  file: z.string(),
  line: z.number().int().positive().optional(),
});

export const FindingSchema = z.object({
  /** Rule id, or a built-in id such as unapproved-weakening, stale-decision, hub-component. */
  rule: z.string(),
  /** Rule kind or built-in category (weakening, metric, decision, api, history, config, drift). */
  kind: z.string(),
  level: FindingLevelSchema,
  message: z.string(),
  /** Source component id (or file when unmapped). */
  from: z.string().optional(),
  /** Target component id, package, or file. */
  to: z.string().optional(),
  location: LocationSchema.optional(),
  because: z.array(z.string()),
  fix_hint: z.string().optional(),
  fingerprint: z.string(),
  status: FindingStatusSchema,
  heuristic: z.boolean().optional(),
  /** Supporting locations, such as the edges that form a cycle. */
  related: z.array(LocationSchema).optional(),
});

export const WeakeningTypeSchema = z.enum([
  "rule-removed",
  "level-lowered",
  "selector-narrowed",
  "rule-changed",
  "type-imports-excluded",
  "waiver-added",
  "baseline-grown",
  "semantic",
]);

export const WeakeningSchema = z.object({
  /** Rule id, or "baseline" for baseline growth that no rule id covers. */
  rule: z.string(),
  type: WeakeningTypeSchema,
  message: z.string(),
  /** Accepted decision in head that lists the rule in weakens. */
  approved_by: z.string().optional(),
  /** Concrete consequences, such as edges the head contract newly allows. */
  details: z.array(z.string()).default([]),
});

export const ApiChangeSchema = z.object({
  component: z.string(),
  file: z.string(),
  symbol: z.string(),
  change: z.enum(["removed", "changed", "added"]),
  before: z.string().optional(),
  after: z.string().optional(),
});

export const ConfigIssueSchema = z.object({
  level: z.enum(["error", "warn"]),
  file: z.string(),
  path: z.string().optional(),
  message: z.string(),
});

export const CoverageSchema = z.object({
  files_analyzed: z.number().int(),
  languages: z.record(z.string(), z.number().int()),
  unmapped_files: z.array(z.string()),
  unresolved_imports: z.array(z.object({ file: z.string(), line: z.number().int(), specifier: z.string() })),
  dynamic_imports: z.array(z.object({ file: z.string(), line: z.number().int(), expression: z.string() })),
  parse_errors: z.array(z.object({ file: z.string(), message: z.string() })),
});

export const ReportSummarySchema = z.object({
  /** New error findings. Any value above zero fails the run. */
  errors: z.number().int(),
  warnings: z.number().int(),
  info: z.number().int(),
  baselined: z.number().int(),
  waived: z.number().int(),
  existing: z.number().int(),
  /** Baseline entries (counted by occurrence) that no longer occur. */
  fixed: z.number().int(),
  weakenings: z.number().int(),
  unapproved_weakenings: z.number().int(),
});

export const ReportSchema = z.object({
  schema_version: z.literal(1),
  tool: z.object({ name: z.literal("architect"), version: z.string() }),
  command: z.enum(["check", "diff", "ci", "hook"]),
  scope: z.enum(["all", "changed", "files"]),
  base: z.string().optional(),
  head: z.string().optional(),
  summary: ReportSummarySchema,
  findings: z.array(FindingSchema),
  fixed: z.array(BaselineEntrySchema),
  weakenings: z.array(WeakeningSchema),
  api_changes: z.array(ApiChangeSchema),
  config_issues: z.array(ConfigIssueSchema),
  coverage: CoverageSchema,
  exit_code: z.union([z.literal(0), z.literal(1), z.literal(2)]),
});

// ---------------------------------------------------------------- inferred types

export type Component = z.infer<typeof ComponentSchema>;
export type Deprecation = z.infer<typeof DeprecationSchema>;
export type WritePreset = z.infer<typeof WritePresetSchema>;
export type WriteMatcher = z.infer<typeof WriteMatcherSchema>;
export type Resource = z.infer<typeof ResourceSchema>;
export type HistorySettings = z.infer<typeof HistorySettingsSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type Architecture = z.infer<typeof ArchitectureSchema>;
export type RuleLevel = z.infer<typeof RuleLevelSchema>;
export type ForbidRule = z.infer<typeof ForbidRuleSchema>;
export type AllowOnlyRule = z.infer<typeof AllowOnlyRuleSchema>;
export type LayersRule = z.infer<typeof LayersRuleSchema>;
export type AcyclicRule = z.infer<typeof AcyclicRuleSchema>;
export type IndependentRule = z.infer<typeof IndependentRuleSchema>;
export type EntrypointsRule = z.infer<typeof EntrypointsRuleSchema>;
export type ExternalImportsRule = z.infer<typeof ExternalImportsRuleSchema>;
export type StateOwnerRule = z.infer<typeof StateOwnerRuleSchema>;
export type ApiStabilityRule = z.infer<typeof ApiStabilityRuleSchema>;
export type DeprecatedRule = z.infer<typeof DeprecatedRuleSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type RuleKind = Rule["kind"];
export type Waiver = z.infer<typeof WaiverSchema>;
export type RulesFile = z.infer<typeof RulesFileSchema>;
export type DecisionStatus = z.infer<typeof DecisionStatusSchema>;
export type Assumption = z.infer<typeof AssumptionSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type DecisionFrontMatter = z.infer<typeof DecisionFrontMatterSchema>;
export type Decision = z.infer<typeof DecisionSchema>;
export type BaselineEntry = z.infer<typeof BaselineEntrySchema>;
export type Baseline = z.infer<typeof BaselineSchema>;
export type CardKind = z.infer<typeof CardKindSchema>;
export type CardSource = z.infer<typeof CardSourceSchema>;
export type CardFrontMatter = z.infer<typeof CardFrontMatterSchema>;
export type Card = z.infer<typeof CardSchema>;
export type FindingLevel = z.infer<typeof FindingLevelSchema>;
export type FindingStatus = z.infer<typeof FindingStatusSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type WeakeningType = z.infer<typeof WeakeningTypeSchema>;
export type Weakening = z.infer<typeof WeakeningSchema>;
export type ApiChange = z.infer<typeof ApiChangeSchema>;
export type ConfigIssue = z.infer<typeof ConfigIssueSchema>;
export type Coverage = z.infer<typeof CoverageSchema>;
export type ReportSummary = z.infer<typeof ReportSummarySchema>;
export type Report = z.infer<typeof ReportSchema>;

export const RULE_KINDS = [
  "forbid",
  "allow-only",
  "layers",
  "acyclic",
  "independent",
  "entrypoints",
  "external-imports",
  "state-owner",
  "api-stability",
  "deprecated",
] as const satisfies readonly RuleKind[];

/** Rule kinds that compare base and head, and therefore run only in diff mode. */
export const DIFF_ONLY_RULE_KINDS: readonly RuleKind[] = ["api-stability", "deprecated"];
