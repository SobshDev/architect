import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openWorkspace } from "../src/engine/index.ts";
import { driftFindings, runInstall, runSync } from "../src/engine/install.ts";
import { INSTALL_AGENTS, type InstallAgent } from "../src/integrations/index.ts";

const FIXTURE = join(import.meta.dir, "fixtures/repos/shop");
const TODAY = "2026-09-26";
const COMMAND = "bunx architect";
const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function shop(): string {
  const dir = mkdtempSync(join(tmpdir(), "architect-install-"));
  made.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const read = (dir: string, path: string) => readFileSync(join(dir, path), "utf8");
const json = (dir: string, path: string) => JSON.parse(read(dir, path)) as Record<string, any>;
function write(dir: string, path: string, text: string): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

async function drift(dir: string): Promise<string[]> {
  const findings = await driftFindings(await openWorkspace(dir, { today: TODAY }));
  return findings.map((f) => f.location?.file ?? "");
}

const EXPECTED: Record<InstallAgent, string[]> = {
  codex: [".codex/hooks.json", ".codex/config.toml", ".agents/skills/architect/SKILL.md", ".agents/skills/architect/references/rules.md"],
  claude: [".claude/settings.json", ".mcp.json", ".claude/rules/architect.md", ".claude/rules/architect-domain.md", ".claude/skills/architect/SKILL.md"],
  cursor: [".cursor/rules/architect.mdc", ".cursor/mcp.json"],
};

describe("install", () => {
  for (const agent of INSTALL_AGENTS) {
    test(`${agent}: writes its files, and a second run changes nothing`, async () => {
      const dir = shop();
      const first = await runInstall(dir, { agent, command: COMMAND, today: TODAY });
      for (const path of [...EXPECTED[agent], "AGENTS.md"]) expect(first.written).toContain(path);
      expect(first.notes.some((note) => note.includes("/.architect/ @your-team"))).toBe(true);
      expect(existsSync(join(dir, "CODEOWNERS"))).toBe(false);

      const second = await runInstall(dir, { agent, command: COMMAND, today: TODAY });
      expect(second.written).toEqual([]);
      expect(second.unchanged).toEqual(first.written);
      expect(await drift(dir)).toEqual([]);
    });
  }

  test("codex hooks run the command for each event, with apply_patch as the edit matcher", async () => {
    const dir = shop();
    await runInstall(dir, { agent: "codex", command: COMMAND, today: TODAY });
    const hooks = json(dir, ".codex/hooks.json").hooks;
    expect(Object.keys(hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]);
    expect(hooks.PostToolUse).toEqual([{ matcher: "apply_patch", hooks: [{ type: "command", command: "bunx architect hook PostToolUse --agent codex" }] }]);
    expect(read(dir, ".codex/config.toml")).toContain('args = ["architect", "mcp"]');
  });

  test("claude component rules load on the component's files and state its contract", async () => {
    const dir = shop();
    await runInstall(dir, { agent: "claude", command: COMMAND, today: TODAY });
    const domain = read(dir, ".claude/rules/architect-domain.md");
    expect(domain.startsWith('---\npaths:\n  - "src/domain/**"\n---\n')).toBe(true);
    expect(domain).toContain("domain-is-pure");
    expect(domain).toContain("0002: Keep the domain pure");
    const infra = read(dir, ".claude/rules/architect-infra.md");
    // Rules that name only the domain stay out of infra's file; rules naming infra on either side, or every component, go in.
    expect(infra).not.toContain("domain-no-packages");
    expect(infra).not.toContain("domain-entrypoint");
    for (const rule of ["domain-is-pure", "layering", "no-cycles"]) expect(infra).toContain(rule);
    expect(read(dir, ".claude/rules/architect.md").startsWith("---")).toBe(false);
    expect(json(dir, ".claude/settings.json").hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
  });

  test("keeps user content in every merged file", async () => {
    const dir = shop();
    const agentsText = "# Shop\n\nOur own instructions.\n";
    const toml = '# personal comment\nmodel = "gpt"  # inline\n\n[mcp_servers.docs]\nurl = "https://example.com/mcp"\n';
    write(dir, "AGENTS.md", agentsText);
    write(dir, ".codex/config.toml", toml);
    write(dir, ".codex/hooks.json", JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-me" }] }] } }));
    write(dir, ".claude/settings.json", JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, hooks: { PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "audit" }] }] } }));
    write(dir, ".mcp.json", JSON.stringify({ mcpServers: { db: { command: "db-mcp", args: [] } } }));
    write(dir, ".cursor/mcp.json", JSON.stringify({ mcpServers: { db: { command: "db-mcp" } } }));
    for (const agent of INSTALL_AGENTS) await runInstall(dir, { agent, command: COMMAND, today: TODAY });

    expect(read(dir, "AGENTS.md").startsWith(agentsText)).toBe(true);
    expect(read(dir, ".codex/config.toml").startsWith(toml)).toBe(true);
    expect(json(dir, ".codex/hooks.json").hooks.Stop[0].hooks[0].command).toBe("notify-me");
    const settings = json(dir, ".claude/settings.json");
    expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(settings.hooks.PostToolUse.map((g: any) => g.hooks[0].command)).toEqual(["audit", "bunx architect hook PostToolUse --agent claude"]);
    expect(Object.keys(json(dir, ".mcp.json").mcpServers)).toEqual(["db", "architect"]);
    expect(Object.keys(json(dir, ".cursor/mcp.json").mcpServers)).toEqual(["db", "architect"]);

    const agentsMd = read(dir, "AGENTS.md");
    const block = agentsMd.slice(agentsMd.indexOf("<!-- architect:begin -->"), agentsMd.indexOf("<!-- architect:end -->") + 1);
    expect(block.split("\n").length).toBeLessThanOrEqual(30);
    expect(agentsMd.split("<!-- architect:begin -->").length).toBe(2);
  });

  test("refuses to overwrite a settings file it cannot parse", async () => {
    const dir = shop();
    write(dir, ".claude/settings.json", "{ not json");
    await expect(runInstall(dir, { agent: "claude", command: COMMAND, today: TODAY })).rejects.toThrow(".claude/settings.json");
    expect(read(dir, ".claude/settings.json")).toBe("{ not json");
  });

  test("refuses to add a second architect server to a Codex config that defines it with dotted keys or an inline table", async () => {
    for (const config of [
      'mcp_servers.architect.command = "architect"\n',
      'mcp_servers = { architect = { command = "architect" } }\n',
      '[mcp_servers]\narchitect = { command = "architect" }\n',
      '[mcp_servers]\narchitect.command = "architect"\n',
    ]) {
      const dir = shop();
      write(dir, ".codex/config.toml", config);
      await expect(runInstall(dir, { agent: "codex", command: COMMAND, today: TODAY })).rejects.toThrow("dotted keys or an inline table");
      expect(read(dir, ".codex/config.toml")).toBe(config);
    }
    const dir = shop();
    const ok = '[mcp_servers.other]\ncommand = "o"\n\n[mcp_servers.architect.env]\nA = "1"\n';
    write(dir, ".codex/config.toml", ok);
    await runInstall(dir, { agent: "codex", command: COMMAND, today: TODAY });
    expect(read(dir, ".codex/config.toml")).toContain('[mcp_servers.architect.env]\nA = "1"');
  });

  test("a custom command without 'architect' in it is still recognized, so reinstalling and syncing never duplicate hooks", async () => {
    const dir = shop();
    await runInstall(dir, { agent: "codex", command: "bun /opt/tools/arch.ts", today: TODAY });
    await runInstall(dir, { agent: "codex", today: TODAY });
    await runSync(dir, { today: TODAY });
    const hooks = json(dir, ".codex/hooks.json").hooks;
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"]) {
      expect(hooks[event].flatMap((group: any) => group.hooks.map((hook: any) => hook.command))).toEqual([`bun /opt/tools/arch.ts hook ${event} --agent codex`]);
    }
  });

  test("a quoted command path with spaces stays one word in MCP entries and survives sync", async () => {
    const dir = shop();
    const command = "'/opt/My Tools/architect'";
    await runInstall(dir, { agent: "claude", command, today: TODAY });
    expect(json(dir, ".mcp.json").mcpServers.architect).toEqual({ command: "/opt/My Tools/architect", args: ["mcp"] });
    await runInstall(dir, { agent: "cursor", today: TODAY });
    expect(json(dir, ".cursor/mcp.json").mcpServers.architect).toEqual({ command: "/opt/My Tools/architect", args: ["mcp"] });
    expect(json(dir, ".claude/settings.json").hooks.Stop[0].hooks[0].command).toBe(`${command} hook Stop --agent claude`);
    expect(await drift(dir)).toEqual([]);
  });
});

describe("sync and drift", () => {
  test("a contract change is reported as drift and cleared by sync", async () => {
    const dir = shop();
    for (const agent of INSTALL_AGENTS) await runInstall(dir, { agent, command: COMMAND, today: TODAY });
    const architecture = read(dir, ".architect/architecture.yaml");
    write(dir, ".architect/architecture.yaml", `${architecture.trimEnd()}\n  - id: api\n    paths: [src/api]\n`);
    write(dir, ".architect/rules.yaml", read(dir, ".architect/rules.yaml").replace("level: warn", "level: off"));

    const drifted = await drift(dir);
    expect(drifted).toContain(".claude/rules/architect-api.md");
    expect(drifted).toContain(".claude/rules/architect-domain.md");
    expect(drifted).toContain(".cursor/rules/architect.mdc");
    expect(drifted).not.toContain("AGENTS.md");

    const synced = await runSync(dir, { today: TODAY });
    expect(synced.agents).toEqual([...INSTALL_AGENTS]);
    expect(synced.written).toEqual(drifted);
    expect(await drift(dir)).toEqual([]);
  });

  test("editing a generated file is drift", async () => {
    const dir = shop();
    await runInstall(dir, { agent: "cursor", command: COMMAND, today: TODAY });
    write(dir, ".cursor/rules/architect.mdc", "edited by hand\n");
    const findings = await driftFindings(await openWorkspace(dir, { today: TODAY }));
    expect(findings.map((f) => [f.rule, f.level, f.message])).toEqual([
      ["generated-drift", "warn", ".cursor/rules/architect.mdc is out of date. Run architect sync."],
    ]);
  });

  test("the rules file of a removed component is drift, and sync deletes it but keeps hand-written ones", async () => {
    const dir = shop();
    const architecture = read(dir, ".architect/architecture.yaml");
    write(dir, ".architect/architecture.yaml", `${architecture.trimEnd()}\n  - id: api\n    paths: [src/api]\n`);
    await runInstall(dir, { agent: "claude", command: COMMAND, today: TODAY });
    write(dir, ".claude/rules/architect-notes.md", "# My own notes\n");
    write(dir, ".architect/architecture.yaml", architecture);

    expect(await drift(dir)).toEqual([".claude/rules/architect-api.md"]);
    const synced = await runSync(dir, { today: TODAY });
    expect(synced.removed).toEqual([".claude/rules/architect-api.md"]);
    expect(existsSync(join(dir, ".claude/rules/architect-api.md"))).toBe(false);
    expect(read(dir, ".claude/rules/architect-notes.md")).toBe("# My own notes\n");
    expect(await drift(dir)).toEqual([]);
  });

  test("sync keeps the command recorded at install time", async () => {
    const dir = shop();
    await runInstall(dir, { agent: "claude", command: "/opt/tools/architect", today: TODAY });
    write(dir, ".architect/rules.yaml", read(dir, ".architect/rules.yaml").replace("level: warn", "level: off"));
    await runSync(dir, { today: TODAY });
    expect(json(dir, ".mcp.json").mcpServers.architect).toEqual({ command: "/opt/tools/architect", args: ["mcp"] });
    expect(read(dir, "AGENTS.md")).toContain("/opt/tools/architect check --changed");
    // A later install for another agent reuses it too.
    await runInstall(dir, { agent: "codex", today: TODAY });
    expect(json(dir, ".codex/hooks.json").hooks.Stop[0].hooks[0].command).toBe("/opt/tools/architect hook Stop --agent codex");
  });

  test("sync with nothing installed writes nothing", async () => {
    const dir = shop();
    const result = await runSync(dir, { today: TODAY });
    expect(result.written).toEqual([]);
    expect(result.notes).toHaveLength(1);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(await drift(dir)).toEqual([]);
  });
});
