import { describe, expect, test } from "bun:test";
import { ArchitectureSchema, DecisionSchema, RulesFileSchema, type Decision } from "../model/index.ts";
import type { EvidenceCheck } from "./evidence.ts";
import { lintDecisions } from "./lint.ts";

const BODY = "# T\n\n## Context and Problem Statement\n\nWhy.\n\n## Considered Options\n\n* A\n\n## Decision Outcome\n\nChosen option: \"A\", because it works.\n";

function decision(fields: Partial<Decision> & { id: string }): Decision {
  return DecisionSchema.parse({
    file: `.architect/decisions/${fields.id}-t.md`,
    title: "T",
    status: "accepted",
    decision_makers: [],
    governs: [],
    supersedes: [],
    weakens: [],
    assumptions: [],
    evidence: [],
    body: BODY,
    imported: false,
    ...fields,
  });
}

const architecture = ArchitectureSchema.parse({ version: 1, components: [{ id: "domain", paths: ["src/domain"] }] });
const rules = RulesFileSchema.parse({
  version: 1,
  rules: [
    { id: "no-cycles", kind: "acyclic", because: ["0001"] },
    { id: "quiet", kind: "acyclic", level: "off" },
  ],
});

function lint(decisions: Decision[], evidence: Map<string, EvidenceCheck[]> = new Map()) {
  return lintDecisions({ decisions, architecture, rules, files: ["src/domain/order.ts"], today: "2026-09-26", evidence }).map(
    (issue) => `${issue.decision} ${issue.level}: ${issue.message}`,
  );
}

describe("lintDecisions", () => {
  test("a complete decision with valid references has no issues", () => {
    const ok = decision({ id: "0001", governs: ["domain", "src/domain/**", "*"], weakens: ["no-cycles", "baseline"], assumptions: [{ text: "No cycles", check: "no-cycles" }] });
    expect(lint([ok])).toEqual([]);
  });

  test("broken references are errors; doubtful ones are warnings", () => {
    const issues = lint([
      decision({ id: "0001", status: "accepted" }),
      decision({
        id: "0002",
        governs: ["billing", "src/billing/**"],
        supersedes: ["0001", "0009"],
        weakens: ["gone-rule"],
        assumptions: [
          { text: "Checked by nothing", check: "missing-rule" },
          { text: "Checked by an off rule", check: "quiet" },
          { text: "Old", review_by: "2026-01-01" },
        ],
      }),
    ]);
    expect(issues.filter((issue) => issue.includes(" error: "))).toEqual([
      '0002 error: Assumption "Checked by nothing" names unknown rule "missing-rule" as its check.',
      '0002 error: governs names unknown component "billing".',
      "0002 error: supersedes unknown decision 0009.",
    ]);
    expect(issues.filter((issue) => issue.includes(" warn: "))).toHaveLength(4);
  });

  test("a proposal that weakens a rule missing from rules.yaml gets a reminder; an accepted decision that removed it does not", () => {
    expect(lint([decision({ id: "0001", status: "proposed", weakens: ["gone-rule"] })])).toEqual([
      '0001 warn: weakens names rule "gone-rule", which is not in rules.yaml (expected only if this decision removes it).',
    ]);
    expect(lint([decision({ id: "0001", weakens: ["gone-rule"] })])).toEqual([]);
  });

  test("unverified quotes are errors and web sources need a reviewer", () => {
    const checks: EvidenceCheck[] = [
      { source: "src/a.ts", status: "not-found", message: "The quote does not appear verbatim in the source." },
      { source: "https://example.com", status: "unverified-url", message: "Architect does not fetch URLs; a reviewer must confirm the quote." },
      { source: "src/b.ts", status: "verified", message: "Quote found." },
    ];
    const issues = lint([decision({ id: "0001" })], new Map([["0001", checks]]));
    expect(issues).toEqual([
      "0001 error: Evidence src/a.ts: The quote does not appear verbatim in the source.",
      "0001 warn: Evidence https://example.com: Architect does not fetch URLs; a reviewer must confirm the quote.",
    ]);
  });

  test("native decisions need the MADR sections and no template placeholders; imported ones are exempt", () => {
    const bare = "# T\n\nTODO: write this.\n";
    expect(lint([decision({ id: "0001", body: bare })])).toHaveLength(4);
    expect(lint([decision({ id: "0001", body: bare, imported: true })])).toEqual([]);
  });
});
