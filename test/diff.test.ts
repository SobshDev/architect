import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDiff } from "../src/engine/index.ts";
import { formatJson } from "../src/report/index.ts";

const FIXTURE = join(import.meta.dir, "fixtures/repos/shop");
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const TODAY = "2026-09-26";
const made: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** The shop fixture committed on main in a throwaway repository. */
function baseRepo(): string {
  const dir = tempDir("architect-diff-");
  cpSync(FIXTURE, dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

function cli(dir: string, args: string[]) {
  const env = { ...process.env, ARCHITECT_TODAY: TODAY, GITHUB_ACTIONS: "", GITHUB_STEP_SUMMARY: "", GITHUB_BASE_REF: "" };
  return Bun.spawnSync(["bun", CLI, ...args, "--cwd", dir], { env });
}

function withoutRule(rules: string, id: string): string {
  const start = rules.indexOf("  - id: " + id + "\n");
  const next = rules.indexOf("  - id: ", start + 1);
  return rules.slice(0, start) + (next === -1 ? "" : rules.slice(next));
}

const APPROVAL = [
  "---",
  "status: accepted",
  "date: 2026-09-26",
  "weakens: [domain-is-pure]",
  "---",
  "",
  "# Let orders save themselves",
  "",
  "## Context and Problem Statement",
  "",
  "The storage port added a layer that no second adapter ever used.",
  "",
  "## Decision Outcome",
  "",
  'Chosen option: "Call the database from the domain", because only one store exists.',
  "",
].join("\n");

const TAX = [
  'import chunk from "lodash/chunk";',
  'import { saveOrder } from "../infra/db.ts";',
  "",
  "export function taxBatches(amounts: number[]): number[][] {",
  "  void saveOrder;",
  "  return chunk(amounts, 2);",
  "}",
  "",
].join("\n");

/** Head change: a new domain file that breaks three rules, exported from the domain entrypoint. */
function addTaxModule(dir: string): void {
  writeFileSync(join(dir, "src/domain/tax.ts"), TAX);
  const index = join(dir, "src/domain/index.ts");
  writeFileSync(index, readFileSync(index, "utf8") + 'export { taxBatches } from "./tax.ts";\n');
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("diff and ci on the shop fixture", () => {
  test("deleting a rule without a decision fails ci; an accepted decision that weakens it passes and is shown", () => {
    const dir = baseRepo();
    const rulesPath = join(dir, ".architect/rules.yaml");
    writeFileSync(rulesPath, withoutRule(readFileSync(rulesPath, "utf8"), "domain-is-pure"));
    const out = tempDir("architect-ci-");

    const failed = cli(dir, ["ci", "--base", "main", "--summary", join(out, "failed.md"), "--sarif", join(out, "failed.sarif")]);
    expect(failed.exitCode).toBe(1);
    const failedSummary = readFileSync(join(out, "failed.md"), "utf8");
    expect(failedSummary).toContain("domain-is-pure");
    const sarif = JSON.parse(readFileSync(join(out, "failed.sarif"), "utf8"));
    expect(sarif.runs[0].results.map((r: { ruleId: string }) => r.ruleId)).toContain("unapproved-weakening");

    writeFileSync(join(dir, ".architect/decisions/0003-let-orders-save-themselves.md"), APPROVAL);
    const passed = cli(dir, ["ci", "--base", "main", "--summary", join(out, "passed.md")]);
    expect(passed.exitCode).toBe(0);
    const passedSummary = readFileSync(join(out, "passed.md"), "utf8");
    expect(passedSummary).toContain("0003");
    expect(passedSummary).toContain("domain-is-pure");
  });

  test("an unchanged tree has no new findings even though the fixture has open violations", async () => {
    const { report } = await runDiff(baseRepo(), { base: "main", today: TODAY });
    expect(report.exit_code).toBe(0);
    expect(report.findings.filter((f) => f.status === "new")).toEqual([]);
    expect(report.weakenings).toEqual([]);
  });

  test("new violations in head are new errors, and the report matches the golden output", async () => {
    const dir = baseRepo();
    addTaxModule(dir);
    const { report } = await runDiff(dir, { base: "main", today: TODAY });
    expect(report.exit_code).toBe(1);
    const newErrors = report.findings.filter((f) => f.status === "new" && f.level === "error").map((f) => f.rule + " " + f.location?.file);
    expect(newErrors.sort()).toEqual(["domain-is-pure src/domain/tax.ts", "domain-no-packages src/domain/tax.ts", "layering src/domain/tax.ts"]);
    expect(report.api_changes).toContainEqual(expect.objectContaining({ component: "domain", symbol: "taxBatches", change: "added" }));
    const golden = JSON.parse(formatJson(report));
    golden.tool.version = "test";
    expect(golden).toMatchSnapshot();
  });

  test("a committed head read from git objects gives the same diff as the same tree checked out", async () => {
    const dir = baseRepo();
    addTaxModule(dir);
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "tax");
    const fromGit = (await runDiff(dir, { base: "HEAD~1", head: "HEAD", today: TODAY })).report;
    const fromTree = (await runDiff(dir, { base: "HEAD~1", today: TODAY })).report;
    const comparable = (r: typeof fromGit) => ({ summary: r.summary, findings: r.findings, weakenings: r.weakenings, api_changes: r.api_changes, fixed: r.fixed });
    expect(comparable(fromGit)).toEqual(comparable(fromTree));
  });
});
