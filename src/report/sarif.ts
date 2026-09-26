import { ARCHITECT_DIR, keyFingerprint, sortFindings } from "../model/index.ts";
import type { Finding, FindingLevel, Location, Report, Rule, Weakening } from "../model/index.ts";
import { compareText, sortWeakenings } from "./report.ts";

// SARIF 2.1.0 for code scanning. Only what this change introduces becomes a result: new findings, unapproved
// weakenings, and findings a decision approved (as suppressed results). Existing, baselined, and waived findings
// stay out, so code scanning does not flag old violations on every pull request.

type SarifLevel = "error" | "warning" | "note" | "none";

interface SarifLocation {
  id?: number;
  physicalLocation: { artifactLocation: { uri: string; uriBaseId: "%SRCROOT%" }; region?: { startLine: number } };
}

interface SarifResult {
  ruleId: string;
  level: SarifLevel;
  message: { text: string };
  locations: SarifLocation[];
  relatedLocations?: SarifLocation[];
  partialFingerprints: { "architect/v1": string };
  baselineState: "new" | "unchanged";
  suppressions?: { kind: "external"; status: "accepted"; justification: string }[];
  properties?: Record<string, unknown>;
}

const LEVELS: Record<FindingLevel, SarifLevel> = { error: "error", warn: "warning", info: "note" };
const RULE_LEVELS: Record<Rule["level"], SarifLevel> = { error: "error", warn: "warning", off: "none" };
const WEAKENING_RULE = "unapproved-weakening";

function sarifLocation(location: Location, id?: number): SarifLocation {
  const physicalLocation: SarifLocation["physicalLocation"] = { artifactLocation: { uri: location.file, uriBaseId: "%SRCROOT%" } };
  if (location.line !== undefined) physicalLocation.region = { startLine: location.line };
  return id === undefined ? { physicalLocation } : { id, physicalLocation };
}

function findingResult(f: Finding): SarifResult {
  // Code scanning rejects results without a location: cycles fall back to their first edge, metrics to the architecture file.
  const location = f.location ?? f.related?.[0] ?? { file: `${ARCHITECT_DIR}/architecture.yaml` };
  const result: SarifResult = {
    ruleId: f.rule,
    level: LEVELS[f.level],
    message: { text: f.fix_hint ? `${f.message} Fix: ${f.fix_hint}` : f.message },
    locations: [sarifLocation(location)],
    partialFingerprints: { "architect/v1": f.fingerprint },
    baselineState: "new",
    properties: { because: f.because, from: f.from, to: f.to, kind: f.kind, heuristic: f.heuristic },
  };
  if (f.related && f.related.length > 0) result.relatedLocations = f.related.map((loc, i) => sarifLocation(loc, i + 1));
  if (f.approved_by !== undefined) {
    // Not every SARIF consumer honors suppressions, so the level also drops to note.
    const justification = `Approved by decision ${f.approved_by}.`;
    result.level = "note";
    result.message.text = `${f.message} ${justification}`;
    result.suppressions = [{ kind: "external", status: "accepted", justification }];
  }
  return result;
}

/** The fingerprint uses the rule and type only, since messages carry counts; repeats of a pair get an ordinal. */
function weakeningResult(w: Weakening, ordinal: number): SarifResult {
  const file = `${ARCHITECT_DIR}/${w.type === "baseline-grown" ? "baseline.json" : "rules.yaml"}`;
  const fingerprint = ordinal === 0 ? keyFingerprint(WEAKENING_RULE, w.rule, w.type) : keyFingerprint(WEAKENING_RULE, w.rule, w.type, String(ordinal));
  const details = w.details.length > 0 ? ` Details: ${w.details.join("; ")}.` : "";
  return {
    ruleId: WEAKENING_RULE,
    level: "error",
    message: {
      text: `${w.message}${details} Record an accepted decision that lists ${w.rule} in weakens.`,
    },
    locations: [sarifLocation({ file })],
    partialFingerprints: { "architect/v1": fingerprint },
    baselineState: "new",
    properties: { rule: w.rule, type: w.type, details: w.details },
  };
}

export function formatSarif(report: Report, options: { rules?: readonly Rule[] } = {}): string {
  const findings = sortFindings(report.findings).filter((f) => f.status === "new" || f.approved_by !== undefined);
  const weakenings = sortWeakenings(report.weakenings).filter((w) => w.approved_by === undefined);
  const seen = new Map<string, number>();
  const weakeningResults = weakenings.map((w) => {
    const key = `${w.rule}\u0000${w.type}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return weakeningResult(w, ordinal);
  });
  const results = [...findings.map(findingResult), ...weakeningResults];

  const configured = new Map((options.rules ?? []).map((r) => [r.id, r]));
  const levels = new Map<string, SarifLevel>();
  for (const r of results) if (!levels.has(r.ruleId)) levels.set(r.ruleId, r.level);
  const rules = [...levels.keys()].sort(compareText).map((id) => {
    const rule = configured.get(id);
    return {
      id,
      shortDescription: { text: rule?.description ?? id },
      defaultConfiguration: { level: rule ? RULE_LEVELS[rule.level] : (levels.get(id) ?? "warning") },
    };
  });

  const sarif = {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: { name: "architect", version: report.tool.version, informationUri: "https://github.com/SobshDev/architect", rules },
        },
        results,
      },
    ],
  };
  return JSON.stringify(sarif, null, 2) + "\n";
}
