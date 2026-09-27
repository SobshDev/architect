import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck, runDecisionList, runInit } from "../src/engine/index.ts";

const FIXTURE = join(import.meta.dir, "fixtures/repos/shop");
const TODAY = "2026-09-26";
const made: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "architect-init-"));
  made.push(dir);
  return dir;
}

/** The shop fixture's code without its .architect/ folder. */
function unmappedShop(): string {
  const dir = tempDir();
  cpSync(join(FIXTURE, "src"), join(dir, "src"), { recursive: true });
  for (const file of ["package.json", "tsconfig.json"]) cpSync(join(FIXTURE, file), join(dir, file));
  return dir;
}

const decisionFiles = (dir: string) => readdirSync(join(dir, ".architect/decisions")).sort();

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("init", () => {
  test("maps existing code so the next check passes, with current violations frozen in the baseline", async () => {
    const dir = unmappedShop();
    const result = await runInit(dir, { today: TODAY });
    expect(result.components.map((c) => c.id).sort()).toEqual(["app", "domain", "infra"]);
    expect(result.baselined).toBeGreaterThan(0);
    const { report } = await runCheck(dir, { today: TODAY });
    expect(report.config_issues).toEqual([]);
    expect(report.exit_code).toBe(0);
  });

  test("a repository without source files still gets a valid contract", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "README.md"), "# Empty\n");
    await runInit(dir, { today: TODAY });
    const { report } = await runCheck(dir, { today: TODAY });
    expect(report.config_issues.filter((issue) => issue.level === "error")).toEqual([]);
    expect(report.exit_code).toBe(0);
  });

  test("init --force reuses the starter decisions instead of adding duplicates", async () => {
    const dir = unmappedShop();
    await runInit(dir, { today: TODAY });
    const first = decisionFiles(dir);
    await runInit(dir, { today: TODAY, force: true });
    expect(decisionFiles(dir)).toEqual(first);
    const { report } = await runCheck(dir, { today: TODAY });
    expect(report.config_issues).toEqual([]);
  });

  test("starter decisions take ids after existing ADRs, so every ADR stays loaded", async () => {
    const dir = unmappedShop();
    mkdirSync(join(dir, "docs/adr"), { recursive: true });
    writeFileSync(join(dir, "docs/adr/0001-use-postgres.md"), "# 1. Use Postgres\n\n## Status\n\nAccepted\n");
    writeFileSync(join(dir, "docs/adr/0002-use-bun.md"), "# 2. Use Bun\n\n## Status\n\nAccepted\n");
    await runInit(dir, { today: TODAY });
    const decisions = await runDecisionList(dir, { today: TODAY });
    expect(decisions.map((d) => [d.id, d.imported])).toEqual([
      ["0001", true],
      ["0002", true],
      ["0003", false],
      ["0004", false],
    ]);
  });
});
