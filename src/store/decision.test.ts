import { describe, expect, test } from "bun:test";
import { nextDecisionId, parseDecision, renderDecision } from "./index.ts";

const F = ".architect/decisions/0004-use-postgres.md";
const withFront = (front: string, body = "# Use Postgres\n") => `---\n${front}\n---\n${body}`;

describe("status normalization", () => {
  test.each([
    ["Accepted ", "accepted", undefined],
    ["draft", "proposed", undefined],
    ["superseded by ADR-0123", "superseded", "0123"],
    ["Superseded by [ADR-0005](0005-x.md)", "superseded", "0005"],
    ["superseded", "superseded", undefined],
  ])("%p", (raw, status, by) => {
    const { decision, issues } = parseDecision(F, withFront(`status: "${raw}"`));
    expect(decision.status).toBe(status as never);
    expect(decision.superseded_by).toBe(by as never);
    expect(issues).toEqual([]);
  });

  test("the superseded-by field sets the successor", () => {
    const { decision } = parseDecision(F, withFront("status: superseded\nsuperseded-by: ADR-9"));
    expect(decision.superseded_by).toBe("0009");
  });

  test("an unknown status becomes proposed with a warning", () => {
    const { decision, issues } = parseDecision(F, withFront("status: pondering"));
    expect(decision.status).toBe("proposed");
    expect(issues.map((i) => [i.level, i.path])).toEqual([["warn", "status"]]);
  });

  test("status from a body section", () => {
    const { decision } = parseDecision(F, "# Use Postgres\n\n## Status\n\nRejected\n\n## Context\n\nText\n");
    expect(decision.status).toBe("rejected");
  });

  test("status and date from MADR 2 bullets", () => {
    const { decision } = parseDecision(F, "# Use Postgres\n\n* Status: superseded by ADR-0010\n* Date: 2020-01-01\n");
    expect(decision.status).toBe("superseded");
    expect(decision.superseded_by).toBe("0010");
    expect(decision.date).toBe("2020-01-01");
  });

  test("a missing status warns for native decisions only", () => {
    const native = parseDecision(F, "# Use Postgres\n");
    expect(native.decision.status).toBe("proposed");
    expect(native.issues.map((i) => i.level)).toEqual(["warn"]);
    expect(parseDecision("docs/adr/0004-x.md", "# Use Postgres\n", { imported: true }).issues).toEqual([]);
  });
});

describe("titles", () => {
  test.each([
    ["# ADR-0003: Use Postgres", "Use Postgres"],
    ["# 3. Use Postgres", "Use Postgres"],
    ["# 0003 - Use Postgres", "Use Postgres"],
    ["# Use Postgres", "Use Postgres"],
  ])("%p", (heading, title) => {
    expect(parseDecision(F, `${heading}\n\ntext\n`).decision.title).toBe(title);
  });

  test("front matter title wins, then the file name slug", () => {
    expect(parseDecision(F, withFront("title: Chosen DB")).decision.title).toBe("Chosen DB");
    expect(parseDecision(F, "no heading here\n").decision.title).toBe("use-postgres");
  });
});

describe("front matter", () => {
  test("MADR 3 deciders count as decision makers", () => {
    expect(parseDecision(F, withFront("status: accepted\ndeciders: Ann, Bob")).decision.decision_makers).toEqual(["Ann", "Bob"]);
  });

  test("invalid fields are reported and dropped, valid ones kept", () => {
    const front = "status: accepted\ngoverns: [store]\nassumptions:\n  - text: no check or review date";
    const native = parseDecision(F, withFront(front));
    expect(native.decision.governs).toEqual(["store"]);
    expect(native.decision.assumptions).toEqual([]);
    expect(native.issues.map((i) => [i.level, i.path])).toEqual([["error", "assumptions[0]"]]);
    expect(parseDecision(F, withFront(front), { imported: true }).issues.map((i) => i.level)).toEqual(["warn"]);
  });

  test("YAML syntax errors report the line", () => {
    const { issues } = parseDecision(F, withFront("status: accepted\ngoverns: [a, b"));
    expect(issues[0]?.level).toBe("error");
    expect(issues[0]?.message).toMatch(/line \d+/);
  });
});

test("renderDecision round-trips through parseDecision, including tricky quotes", () => {
  const quote = 'He said: "don\'t" #1\nsecond line: \'x\'';
  const text = renderDecision({
    id: "0007",
    title: "Split: the store",
    status: "accepted",
    date: "2026-09-26",
    decisionMakers: ["Ann: lead"],
    governs: ["store", "src/store/**"],
    weakens: ["no-cycles"],
    assumptions: [{ text: "Loads are cheap: yes", check: "no-cycles" }],
    evidence: [{ source: "docs/plan.md", quote, note: "- a note" }],
    context: "Why.",
    options: ["Keep", "Split"],
    chosen: "Split",
    outcome: "it is simpler.",
    consequences: ["Good, because tests."],
  });
  const { decision, issues } = parseDecision(".architect/decisions/0007-split-the-store.md", text);
  expect(issues).toEqual([]);
  expect(decision).toMatchObject({
    id: "0007",
    title: "Split: the store",
    status: "accepted",
    date: "2026-09-26",
    decision_makers: ["Ann: lead"],
    governs: ["store", "src/store/**"],
    weakens: ["no-cycles"],
    assumptions: [{ text: "Loads are cheap: yes", check: "no-cycles" }],
    evidence: [{ source: "docs/plan.md", quote, note: "- a note" }],
  });
  expect(decision.body).toContain('Chosen option: "Split", because it is simpler.');
});

test("nextDecisionId ignores imported decisions", () => {
  const d = (id: string, imported: boolean) => parseDecision(`x/${id}-a.md`, "# A\n", { imported }).decision;
  expect(nextDecisionId([])).toBe("0001");
  expect(nextDecisionId([d("0002", false), d("0009", false), d("0040", true)])).toBe("0010");
});
