import { globMatcher, type Architecture, type Decision, type RulesFile } from "../model/index.ts";
import type { EvidenceCheck } from "./evidence.ts";

export interface DecisionLintIssue {
  decision: string;
  file: string;
  level: "error" | "warn";
  message: string;
}

export interface DecisionLintInput {
  decisions: readonly Decision[];
  architecture: Architecture;
  rules: RulesFile;
  /** Repository files, for governs globs. */
  files: readonly string[];
  today: string;
  /** Evidence checks by decision id, in the order of each decision's evidence list. */
  evidence: ReadonlyMap<string, readonly EvidenceCheck[]>;
}

const REQUIRED_SECTIONS = [/context/i, /considered options/i, /decision outcome/i];
const SECTION_NAMES = ["Context and Problem Statement", "Considered Options", "Decision Outcome"];

function looksLikeGlob(entry: string): boolean {
  return /[/*?.{[]/.test(entry);
}

/** Problems a reviewer should see before accepting decisions: broken references, unchecked assumptions, unverified quotes. */
export function lintDecisions(input: DecisionLintInput): DecisionLintIssue[] {
  const componentIds = new Set(input.architecture.components.map((component) => component.id));
  const rules = new Map(input.rules.rules.map((rule) => [rule.id, rule]));
  const byId = new Map(input.decisions.map((decision) => [decision.id, decision]));
  const issues: DecisionLintIssue[] = [];

  for (const decision of input.decisions) {
    const add = (level: DecisionLintIssue["level"], message: string) => issues.push({ decision: decision.id, file: decision.file, level, message });

    if (!decision.imported) {
      const headings = [...decision.body.matchAll(/^#{2,3}\s+(.+)$/gm)].map((match) => match[1] ?? "");
      REQUIRED_SECTIONS.forEach((pattern, i) => {
        if (!headings.some((heading) => pattern.test(heading))) add("warn", `Missing the "${SECTION_NAMES[i]}" section.`);
      });
      if (decision.body.includes("TODO:")) add("warn", "Still contains TODO: placeholders from the template.");
    }

    for (const entry of decision.governs) {
      if (entry === "*" || componentIds.has(entry)) continue;
      if (!looksLikeGlob(entry)) add("error", `governs names unknown component "${entry}".`);
      else if (!input.files.some(globMatcher([entry]))) add("warn", `governs pattern "${entry}" matches no file.`);
    }

    for (const ref of decision.supersedes) {
      const old = byId.get(ref);
      if (old === undefined) add("error", `supersedes unknown decision ${ref}.`);
      else if (decision.status === "accepted" && old.status !== "superseded") add("warn", `Decision ${ref} should have status superseded now that ${decision.id} is accepted.`);
    }

    // An accepted decision that removed a rule keeps naming it; only proposals get the reminder.
    for (const id of decision.weakens) {
      if (id !== "baseline" && !rules.has(id) && decision.status !== "accepted") {
        add("warn", `weakens names rule "${id}", which is not in rules.yaml (expected only if this decision removes it).`);
      }
    }

    for (const assumption of decision.assumptions) {
      if (assumption.check !== undefined) {
        const rule = rules.get(assumption.check);
        if (rule === undefined) add("error", `Assumption "${assumption.text}" names unknown rule "${assumption.check}" as its check.`);
        else if (rule.level === "off") add("warn", `Assumption "${assumption.text}" is checked by rule ${rule.id}, which is off.`);
      }
      if (assumption.review_by !== undefined && assumption.review_by < input.today) {
        add("warn", `Assumption "${assumption.text}" was due for review on ${assumption.review_by}.`);
      }
    }

    for (const check of input.evidence.get(decision.id) ?? []) {
      if (check.status === "verified") continue;
      add(check.status === "unverified-url" ? "warn" : "error", `Evidence ${check.source}: ${check.message}`);
    }
  }

  const order = { error: 0, warn: 1 };
  return issues.sort((a, b) => (a.decision < b.decision ? -1 : a.decision > b.decision ? 1 : order[a.level] - order[b.level] || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0)));
}
