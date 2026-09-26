import { describe, expect, test } from "bun:test";
import type { ComponentGraph, Coverage, Finding, Report, Rule, Weakening } from "../model/index.ts";
import { createReport, emptyCoverage, formatGraph, formatJson, formatMarkdown, formatReport, formatSarif, formatText } from "./index.ts";

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    rule: "no-ui-to-db",
    kind: "forbid",
    level: "error",
    message: "ui imports db",
    from: "ui",
    to: "db",
    location: { file: "src/ui/page.ts", line: 3 },
    because: ["0002"],
    fingerprint: "aaaa000000000001",
    status: "new",
    ...overrides,
  };
}

const unapproved: Weakening = { rule: "layers", type: "level-lowered", message: "layers lowered from error to warn", details: ["ui -> db is now allowed"] };
const approved: Weakening = { rule: "no-cycles", type: "rule-removed", message: "no-cycles was removed", approved_by: "0007", details: [] };

const coverage: Coverage = {
  files_analyzed: 312,
  languages: { typescript: 300, python: 12 },
  unmapped_files: ["scripts/b.ts", "scripts/a.ts"],
  unresolved_imports: [{ file: "src/x.ts", line: 4, specifier: "./missing" }],
  dynamic_imports: [{ file: "src/y.ts", line: 9, expression: "import(name)" }],
  parse_errors: [],
};

/** One report exercising every section; the tool version is pinned so goldens survive releases. */
function representative(): Report {
  const report = createReport({
    command: "ci",
    scope: "changed",
    base: "origin/main",
    head: "HEAD",
    findings: [
      finding({ level: "warn", rule: "state-owner", kind: "state-owner", message: "billing writes users", location: { file: "src/billing/pay.ts", line: 12 }, because: [], fingerprint: "bbbb", fix_hint: "Call the users module instead." }),
      finding({ fix_hint: "Go through the service layer.", because: ["0002", "0004"] }),
      finding({ rule: "acyclic", kind: "acyclic", message: "cycle: a -> b -> a", location: undefined, from: "a", to: "b", fingerprint: "cccc", related: [{ file: "src/a/x.ts", line: 1 }, { file: "src/b/y.ts", line: 2 }], because: ["0001"] }),
      finding({ status: "baselined", fingerprint: "dddd", location: { file: "src/ui/old.ts", line: 7 } }),
      finding({ status: "existing", fingerprint: "eeee", location: { file: "src/ui/legacy.ts" } }),
      finding({ status: "waived", fingerprint: "ffff", location: { file: "src/ui/waived.ts", line: 1 } }),
      finding({ level: "info", rule: "hub-component", kind: "metric", message: "core has 14 dependents", location: undefined, because: [], fingerprint: "gggg", heuristic: true }),
    ],
    fixed: [{ fingerprint: "zz", rule: "no-ui-to-db", count: 3, file: "src/ui/gone.ts", from: "ui", to: "db" }],
    weakenings: [approved, unapproved],
    apiChanges: [
      { component: "core", file: "src/core/index.ts", symbol: "run", change: "changed", before: "function run(): void", after: "function run(x: number): void" },
      { component: "core", file: "src/core/index.ts", symbol: "old", change: "removed", before: "const old: 1" },
    ],
    configIssues: [{ level: "warn", file: ".architect/rules.yaml", path: "rules[2].level", message: "rule is off" }],
    coverage,
  });
  report.tool.version = "0.0.0-test";
  return report;
}

describe("createReport", () => {
  const base = { command: "check", scope: "all" } as const;

  test("exit codes follow the plan", () => {
    expect(createReport({ ...base, findings: [finding()], configIssues: [{ level: "error", file: ".architect/rules.yaml", message: "bad" }] }).exit_code).toBe(2);
    expect(createReport({ ...base, findings: [finding()] }).exit_code).toBe(1);
    expect(createReport({ ...base, findings: [finding({ level: "warn" }), finding({ status: "baselined" }), finding({ status: "existing" }), finding({ status: "waived" })] }).exit_code).toBe(0);
    expect(createReport({ ...base, findings: [], weakenings: [unapproved] }).exit_code).toBe(1);
    expect(createReport({ ...base, findings: [], weakenings: [approved] }).exit_code).toBe(0);
    expect(createReport({ ...base, findings: [], configIssues: [{ level: "warn", file: ".architect/rules.yaml", message: "meh" }] }).exit_code).toBe(0);
  });

  test("output does not depend on input order", () => {
    const input = representative();
    const shuffled = createReport({
      command: "ci",
      scope: "changed",
      base: "origin/main",
      head: "HEAD",
      findings: [...input.findings].reverse(),
      fixed: [...input.fixed].reverse(),
      weakenings: [...input.weakenings].reverse(),
      apiChanges: [...input.api_changes].reverse(),
      configIssues: [...input.config_issues].reverse(),
      coverage: { ...coverage, unmapped_files: [...coverage.unmapped_files].reverse() },
    });
    shuffled.tool.version = "0.0.0-test";
    expect(formatJson(shuffled)).toBe(formatJson(input));
    expect(input.weakenings[0]?.approved_by).toBeUndefined();
    expect(input.coverage.unmapped_files).toEqual(["scripts/a.ts", "scripts/b.ts"]);
  });

  test("fixed counts occurrences and coverage defaults to empty", () => {
    const report = createReport({ ...base, findings: [], fixed: [{ fingerprint: "a", rule: "r", count: 2 }, { fingerprint: "b", rule: "r", count: 3 }] });
    expect(report.summary.fixed).toBe(5);
    expect(report.coverage).toEqual(emptyCoverage());
    expect(report.schema_version).toBe(1);
  });
});

describe("golden outputs", () => {
  test("text", () => expect(formatText(representative())).toMatchSnapshot());
  test("text verbose", () => expect(formatText(representative(), { verbose: true })).toMatchSnapshot());
  test("markdown", () => expect(formatMarkdown(representative())).toMatchSnapshot());
  test("sarif", () => {
    const rules = [{ id: "no-ui-to-db", kind: "forbid", level: "error", description: "UI never touches the database", because: ["0002"], include_type_imports: true, from: ["ui"], to: ["db"] }] as Rule[];
    expect(formatSarif(representative(), { rules })).toMatchSnapshot();
  });
});

describe("text", () => {
  test("a clean report says so", () => {
    expect(formatText(createReport({ command: "hook", scope: "files", findings: [] }))).toBe("No new errors.\n");
  });

  test("an approved finding shows its decision without verbose, and does not fail the run", () => {
    const report = createReport({ command: "ci", scope: "all", findings: [finding({ rule: "stable", kind: "api-stability", status: "waived", approved_by: "0009" })] });
    expect(report.exit_code).toBe(0);
    expect(formatText(report)).toContain("error  stable  ui imports db  [approved by decision 0009]");
    expect(formatText(report, { verbose: true }).match(/approved by decision 0009/g)).toHaveLength(1);
  });
});

describe("sarif", () => {
  test("only new findings become results, each with a fingerprint", () => {
    const sarif = JSON.parse(formatSarif(representative()));
    const results: { ruleId: string; baselineState: string; partialFingerprints: Record<string, string> }[] = sarif.runs[0].results;
    const fingerprints = results.map((r) => r.partialFingerprints["architect/v1"]);
    expect(fingerprints.every((f) => typeof f === "string" && f.length > 0)).toBe(true);
    for (const old of ["dddd", "eeee", "ffff"]) expect(fingerprints).not.toContain(old);
    expect(results.every((r) => r.baselineState === "new")).toBe(true);
    expect(results.filter((r) => r.ruleId === "unapproved-weakening")).toHaveLength(1);
    const ruleIds = sarif.runs[0].tool.driver.rules.map((r: { id: string }) => r.id);
    expect(ruleIds).toEqual([...new Set(results.map((r) => r.ruleId))].sort());
  });

  test("weakening fingerprints survive message changes and stay distinct per rule and type", () => {
    const fingerprints = (messages: string[]) => {
      const weakenings: Weakening[] = messages.map((message) => ({ rule: "x", type: "waiver-added", message, details: [] }));
      const report = createReport({ command: "ci", scope: "all", findings: [], weakenings });
      return JSON.parse(formatSarif(report)).runs[0].results.map((r: { partialFingerprints: Record<string, string> }) => r.partialFingerprints["architect/v1"]);
    };
    expect(fingerprints(["Baseline grew: 2 entries."])).toEqual(fingerprints(["Baseline grew: 3 entries."]));
    expect(new Set(fingerprints(["a", "b"])).size).toBe(2);
  });

  test("an approved finding is a suppressed note that names the decision", () => {
    const report = createReport({ command: "ci", scope: "all", findings: [finding({ status: "waived", approved_by: "0009" })] });
    const [result] = JSON.parse(formatSarif(report)).runs[0].results;
    expect(result.level).toBe("note");
    expect(result.message.text).toContain("Approved by decision 0009");
    expect(result.suppressions[0].justification).toBe("Approved by decision 0009.");
  });

  test("baseline growth points at the baseline file", () => {
    const report = createReport({ command: "diff", scope: "all", findings: [], weakenings: [{ rule: "baseline", type: "baseline-grown", message: "grew", details: [] }] });
    const result = JSON.parse(formatSarif(report)).runs[0].results[0];
    expect(result.locations[0].physicalLocation.artifactLocation.uri).toBe(".architect/baseline.json");
  });
});

describe("markdown", () => {
  test("escapes pipes and newlines in table cells", () => {
    const md = formatMarkdown(createReport({ command: "ci", scope: "all", findings: [finding({ message: "a | b\nc" })] }));
    expect(md).toContain("| a \\| b c |");
  });

  test("repository text cannot become HTML, and code spans survive backticks", () => {
    const message = "Before: tool<Args extends X>(a: A & B)";
    const md = formatMarkdown(
      createReport({
        command: "ci",
        scope: "all",
        findings: [finding({ message }), finding({ rule: "stable", fingerprint: "b", status: "waived", approved_by: "0009", message })],
        weakenings: [{ rule: "r", type: "semantic", message: "<script>", details: ["<b>x</b>"] }],
        apiChanges: [{ component: "c", file: "f.ts", symbol: "a\u0060b", change: "added" }],
      }),
    );
    expect(md).toContain("tool&lt;Args extends X&gt;(a: A &amp; B)");
    expect(md).not.toContain("<Args");
    expect(md).toContain("&lt;script&gt;");
    expect(md).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(md).toContain("(Approved by decision 0009)");
    expect(md).toContain("\u0060\u0060a\u0060b\u0060\u0060");
  });

  test("caps the error table and says how many more", () => {
    const findings = Array.from({ length: 53 }, (_, i) => finding({ fingerprint: String(i).padStart(3, "0"), location: { file: `src/ui/f${String(i).padStart(2, "0")}.ts`, line: 1 } }));
    const md = formatMarkdown(createReport({ command: "ci", scope: "all", findings }));
    expect(md.split("\n").filter((l) => l.startsWith("| no-ui-to-db"))).toHaveLength(50);
    expect(md).toContain("and 3 more");
  });

  test("an empty report has four sections marked none", () => {
    const md = formatMarkdown(createReport({ command: "ci", scope: "all", findings: [] }));
    expect(md.startsWith("### Architect: no new errors")).toBe(true);
    expect(md.match(/^#### /gm)).toHaveLength(4);
    expect(md.match(/_None_/g)).toHaveLength(3);
  });
});

describe("graph", () => {
  const graph: ComponentGraph = {
    components: ["ui", "core", "end"],
    edges: [
      { from: "ui", to: "core", count: 3, kinds: ["static", "type"], samples: [] },
      { from: "core", to: "end", count: 1, kinds: ["type"], samples: [] },
    ],
  };

  test("mermaid draws type-only edges dotted and marks cycle members", () => {
    const out = formatGraph(graph, "mermaid", { cycles: [["ui", "core"]] });
    expect(out).toContain("c_core -.->|1| c_end");
    expect(out).toContain("c_ui -->|3| c_core");
    expect(out).toContain("class c_core,c_ui cycle");
  });

  test("mermaid keeps ids distinct after sanitizing", () => {
    const out = formatGraph({ components: ["a-b", "a_b"], edges: [] }, "mermaid");
    expect(out).toContain('c_a_b["a-b"]');
    expect(out).toContain('c_a_b_2["a_b"]');
  });

  test("dot dashes type-only edges", () => {
    const out = formatGraph(graph, "dot");
    expect(out).toContain('"core" -> "end" [label="1", style=dashed];');
    expect(out).toContain('"ui" -> "core" [label="3"];');
  });
});

test("formatReport dispatches json", () => {
  const report = representative();
  expect(JSON.parse(formatReport(report, "json"))).toEqual(report);
});
