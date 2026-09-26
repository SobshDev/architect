import {
  type Architecture,
  type Decision,
  type Finding,
  globMatcher,
  type Graph,
  keyFingerprint,
  normalizeDecisionId,
  type RulesFile,
  sortFindings,
} from "../model/index.ts";

const RULES_FILE = ".architect/rules.yaml";

function info(rule: string, message: string, fingerprint: string, file: string, from?: string): Finding {
  const finding: Finding = { rule, kind: "decision", level: "info", message, location: { file }, because: [], fingerprint, status: "new" };
  if (from !== undefined) finding.from = from;
  return finding;
}

/** Informational findings about decisions: stale ones, citations of retired ones, and assumption checks that name missing rules. */
export function decisionFindings(input: {
  graph: Graph;
  architecture: Architecture;
  rules: RulesFile;
  decisions: readonly Decision[];
  today: string;
}): Finding[] {
  const { graph, architecture, rules, decisions, today } = input;
  const componentIds = new Set(architecture.components.map((c) => c.id));
  const ruleIds = new Set(rules.rules.map((r) => r.id));
  const findings: Finding[] = [];

  for (const d of decisions) {
    if (d.status === "accepted") {
      for (const a of d.assumptions) {
        if (a.review_by === undefined || a.review_by >= today) continue;
        findings.push(
          info(
            "stale-decision",
            `Decision ${d.id} (${d.title}) has an assumption due for review on ${a.review_by}: "${a.text}".`,
            keyFingerprint("stale-decision", d.id, "assumption", a.text),
            d.file,
          ),
        );
      }
      for (const entry of d.governs) {
        // "*" is the selector for every internal file, so it never goes stale.
        if (entry === "*" || componentIds.has(entry)) continue;
        const match = globMatcher([entry]);
        if (graph.files.some((f) => match(f.path))) continue;
        findings.push(
          info(
            "stale-decision",
            `Decision ${d.id} (${d.title}) governs ${entry}, which is neither a component nor a path that matches any analyzed file.`,
            keyFingerprint("stale-decision", d.id, "governs", entry),
            d.file,
          ),
        );
      }
    }
    if (d.status === "accepted" || d.status === "proposed") {
      for (const a of d.assumptions) {
        if (a.check === undefined || ruleIds.has(a.check)) continue;
        findings.push(
          info(
            "unchecked-assumption",
            `Decision ${d.id} (${d.title}) says rule ${a.check} checks the assumption "${a.text}", but no rule has that id.`,
            keyFingerprint("unchecked-assumption", d.id, a.check, a.text),
            d.file,
          ),
        );
      }
    }
  }

  const byId = new Map(decisions.map((d) => [normalizeDecisionId(d.id) ?? d.id, d]));
  for (const rule of rules.rules) {
    for (const ref of rule.because) {
      const d = byId.get(normalizeDecisionId(ref) ?? ref);
      if (!d || (d.status !== "superseded" && d.status !== "deprecated" && d.status !== "rejected")) continue;
      const replacement = d.superseded_by !== undefined ? `; cite ${d.superseded_by} instead` : "";
      findings.push(
        info(
          "superseded-citation",
          `Rule ${rule.id} cites decision ${d.id} (${d.title}), which is ${d.status}${replacement}.`,
          keyFingerprint("superseded-citation", rule.id, d.id),
          RULES_FILE,
          rule.id,
        ),
      );
    }
  }
  return sortFindings(findings);
}
