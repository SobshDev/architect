import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBaselineUpdate, runCheck, runStatus } from "../src/engine/index.ts";
import { formatJson } from "../src/report/index.ts";

const FIXTURE = join(import.meta.dir, "fixtures/repos/shop");
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const TODAY = "2026-09-26";
const made: string[] = [];

function copyFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "architect-shop-"));
  cpSync(FIXTURE, dir, { recursive: true });
  made.push(dir);
  return dir;
}

function cli(dir: string, args: string[]) {
  return Bun.spawnSync(["bun", CLI, ...args, "--cwd", dir], { env: { ...process.env, ARCHITECT_TODAY: TODAY } });
}

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

const PURE_ORDER = [
  'import type { Money } from "./money.ts";',
  "",
  "export interface Order {",
  "  id: string;",
  "  total: Money;",
  "}",
  "",
  "export function placeOrder(order: Order): Order {",
  "  return order;",
  "}",
  "",
].join("\n");

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("check on the shop fixture", () => {
  test("reports new errors, keeps the baselined cycle, and matches the golden report", async () => {
    const { report } = await runCheck(copyFixture(), { today: TODAY });
    expect(report.exit_code).toBe(1);
    const newErrors = report.findings.filter((f) => f.status === "new" && f.level === "error").map((f) => f.rule);
    expect(newErrors.sort()).toEqual(["domain-is-pure", "layering"]);
    expect(report.findings.find((f) => f.rule === "no-cycles")?.status).toBe("baselined");
    expect(report.findings.find((f) => f.rule === "domain-entrypoint")).toMatchObject({ level: "warn", status: "new" });
    const golden = JSON.parse(formatJson(report));
    golden.tool.version = "test";
    expect(golden).toMatchSnapshot();
  });

  test("fixing the forbidden import passes the check and shows baseline progress until the baseline is updated", async () => {
    const dir = copyFixture();
    expect(cli(dir, ["check"]).exitCode).toBe(1);
    writeFileSync(join(dir, "src/domain/order.ts"), PURE_ORDER);
    const fixed = cli(dir, ["check", "--format", "json"]);
    expect(fixed.exitCode).toBe(0);
    expect(JSON.parse(fixed.stdout.toString()).summary.fixed).toBe(1);
    expect((await runStatus(dir, { today: TODAY })).baseline).toMatchObject({ occurrences: 1, fixed: 1, remaining: 0 });
    const update = await runBaselineUpdate(dir, { allowGrow: false, today: TODAY });
    expect(update.entries).toBe(0);
    expect((await runStatus(dir, { today: TODAY })).baseline.occurrences).toBe(0);
  });

  test("check --changed reports edge findings only for changed files", async () => {
    const dir = copyFixture();
    writeFileSync(join(dir, "src/domain/order.ts"), PURE_ORDER);
    git(dir, "init", "-q");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");
    writeFileSync(join(dir, "src/domain/money.ts"), 'import "../infra/db.ts";\n\nexport interface Money {\n  cents: number;\n  currency: string;\n}\n');
    const { report } = await runCheck(dir, { scope: "changed", today: TODAY });
    const edgeFiles = new Set(report.findings.filter((f) => f.kind !== "acyclic").map((f) => f.location?.file));
    expect([...edgeFiles]).toEqual(["src/domain/money.ts"]);
    expect(report.exit_code).toBe(1);
  });

  test("an unknown component in the rules is a configuration error with exit code 2", () => {
    const dir = copyFixture();
    writeFileSync(join(dir, ".architect/rules.yaml"), 'version: 1\nrules:\n  - id: bad\n    kind: forbid\n    from: [nowhere]\n    to: [infra]\n    level: warn\n');
    const result = cli(dir, ["check"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toContain("nowhere");
  });

  test("file arguments are resolved against the working directory", async () => {
    const dir = copyFixture();
    const fromRoot = (await runCheck(dir, { files: ["src/domain/order.ts"], today: TODAY })).report;
    const fromFolder = (await runCheck(join(dir, "src/domain"), { files: ["./order.ts"], today: TODAY })).report;
    expect(fromRoot.summary.errors).toBeGreaterThan(0);
    expect(fromFolder.findings).toEqual(fromRoot.findings);
  });
});
