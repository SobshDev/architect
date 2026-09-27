import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHook } from "../src/engine/index.ts";

const FIXTURE = join(import.meta.dir, "fixtures/repos/shop");
const PAYLOADS = join(import.meta.dir, "fixtures/hooks");
const CLI = join(import.meta.dir, "../src/cli/main.ts");
const TODAY = "2026-09-26";
const made: string[] = [];

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** The shop fixture as a committed repository. Its existing violations were there before the session. */
function repo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "architect-hooks-")));
  made.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return dir;
}

/** A recorded payload with the project directory and session swapped in. */
function payload(agent: "codex" | "claude", file: string, dir: string, changes: Record<string, unknown> = {}): Record<string, unknown> {
  const text = readFileSync(join(PAYLOADS, agent, "payloads", file), "utf8").replaceAll("/home/user/project", dir);
  return { ...JSON.parse(text), session_id: "session-accept", ...changes };
}

function cliHook(event: string, body: Record<string, unknown>) {
  const result = Bun.spawnSync(["bun", CLI, "hook", event, "--agent", "codex"], {
    stdin: new TextEncoder().encode(JSON.stringify(body)),
    env: { ...process.env, ARCHITECT_TODAY: TODAY },
  });
  const stdout = result.stdout.toString();
  return { exitCode: result.exitCode, output: stdout === "" ? null : JSON.parse(stdout) };
}

const MONEY = "export interface Money {\n  cents: number;\n  currency: string;\n}\n\nexport function money(cents: number, currency = \"EUR\"): Money {\n  return { cents, currency };\n}\n";
const LEAKY_MONEY = 'import { saveOrder } from "../infra/db.ts";\n\n' + MONEY.replace("return {", "void saveOrder;\n  return {");

function patchFor(path: string): string {
  return "*** Begin Patch\n*** Update File: " + path + "\n@@\n-x\n+y\n*** End Patch\n";
}

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

describe("acceptance 1: hooks block a forbidden import and pass once it is fixed", () => {
  test("Codex: PostToolUse blocks with the rule, reason, and fix; Stop blocks once; fixing the file clears both", () => {
    const dir = repo();
    const start = cliHook("SessionStart", payload("codex", "SessionStart.json", dir));
    expect(start.exitCode).toBe(0);
    expect(start.output.hookSpecificOutput.additionalContext).toContain("domain");
    expect(existsSync(join(dir, ".architect/cache/sessions/session-accept.json"))).toBe(true);

    writeFileSync(join(dir, "src/domain/money.ts"), LEAKY_MONEY);
    const edit = payload("codex", "PostToolUse.json", dir, { tool_input: { command: patchFor("src/domain/money.ts") } });
    const blocked = cliHook("PostToolUse", edit);
    expect(blocked.exitCode).toBe(0);
    expect(blocked.output.decision).toBe("block");
    expect(blocked.output.reason).toContain("domain-is-pure");
    expect(blocked.output.reason).toContain("src/domain/money.ts:1");
    expect(blocked.output.reason).toContain('"Keep the domain pure"');
    expect(blocked.output.reason).toContain("Fix:");
    expect(blocked.output.reason).not.toContain("src/domain/order.ts");

    const stop = cliHook("Stop", payload("codex", "Stop.json", dir));
    expect(stop.output.decision).toBe("block");
    const again = cliHook("Stop", payload("codex", "Stop.json", dir, { stop_hook_active: true }));
    expect(again.output?.decision).toBeUndefined();

    writeFileSync(join(dir, "src/domain/money.ts"), MONEY);
    const fixed = cliHook("PostToolUse", edit);
    expect(fixed.output?.decision).toBeUndefined();
    expect(cliHook("Stop", payload("codex", "Stop.json", dir)).output).toBeNull();
  });

  test("Claude: an Edit that adds the import is blocked; edits to .architect/ get a reminder about decisions", async () => {
    const dir = repo();
    const run = (event: "SessionStart" | "PostToolUse", body: Record<string, unknown>) => runHook(event, "claude", JSON.stringify(body), { today: TODAY });
    await run("SessionStart", payload("claude", "SessionStart.json", dir));

    writeFileSync(join(dir, "src/domain/money.ts"), LEAKY_MONEY);
    const edited = payload("claude", "PostToolUse.edit.json", dir, { tool_input: { file_path: join(dir, "src/domain/money.ts"), old_string: "a", new_string: "b" } });
    const blocked = JSON.parse((await run("PostToolUse", edited)).stdout);
    expect(blocked.decision).toBe("block");
    expect(blocked.reason).toContain("domain-is-pure");

    const rulesEdit = payload("claude", "PostToolUse.edit.json", dir, { tool_input: { file_path: join(dir, ".architect/rules.yaml"), old_string: "a", new_string: "b" } });
    const reminder = JSON.parse((await run("PostToolUse", rulesEdit)).stdout);
    expect(reminder.decision).toBeUndefined();
    expect(reminder.hookSpecificOutput.additionalContext).toContain("weakens");
  });

  test("a malformed payload or a repository without Architect never breaks the host", async () => {
    expect(await runHook("PostToolUse", "codex", "{not json")).toMatchObject({ stdout: "", exitCode: 0 });
    const bare = realpathSync(mkdtempSync(join(tmpdir(), "architect-bare-")));
    made.push(bare);
    const body = payload("codex", "PostToolUse.json", bare);
    expect(await runHook("PostToolUse", "codex", JSON.stringify(body))).toMatchObject({ stdout: "", exitCode: 0 });
  });
});
