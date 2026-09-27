import { type Architecture, compareText, type Decision, type RulesFile } from "../../model/index.ts";
import { HOOK_EVENTS, hookMatchers } from "../hooks/index.ts";
import { upsertManagedBlock } from "./block.ts";
import { agentsBlock, claudeComponentRules, claudeMainRules, cursorRule, type ContractView } from "./content.ts";
import { InstallError } from "./errors.ts";
import {
  architectHookCommands,
  architectServer,
  hookCommandPrefix,
  type HookSpec,
  jsonText,
  mergeHooks,
  mergeMcpServer,
  readJsonObject,
  SERVER_NAME,
} from "./json.ts";
import { SKILL_FILES } from "./skill.ts";
import { readTomlTable, tomlString, upsertTomlTable } from "./toml.ts";

export type InstallAgent = "codex" | "claude" | "cursor";
export const INSTALL_AGENTS: readonly InstallAgent[] = ["codex", "claude", "cursor"];

export interface GeneratedFile {
  path: string;
  /** Full content after merging with what exists. */
  content: string;
}

export interface InstallPlan {
  agent: InstallAgent;
  /** Sorted by path. */
  files: GeneratedFile[];
  notes: string[];
}

export interface InstallInput {
  architecture: Architecture;
  rules: RulesFile;
  decisions: readonly Decision[];
  /** How generated files call Architect, such as "architect" or "bunx architect". */
  command: string;
}

export type ReadFile = (path: string) => string | null;

export const PATHS = {
  agents: "AGENTS.md",
  codexHooks: ".codex/hooks.json",
  codexConfig: ".codex/config.toml",
  codexSkill: ".agents/skills/architect",
  claudeSettings: ".claude/settings.json",
  claudeMcp: ".mcp.json",
  claudeRules: ".claude/rules/architect.md",
  claudeSkill: ".claude/skills/architect",
  cursorRule: ".cursor/rules/architect.mdc",
  cursorMcp: ".cursor/mcp.json",
} as const;

const TOML_TABLE = `mcp_servers.${SERVER_NAME}`;
const CODEOWNERS_NOTE = "Suggested CODEOWNERS entry (not written): /.architect/ @your-team";

function hookSpecs(agent: "codex" | "claude", command: string): HookSpec[] {
  const matchers = hookMatchers(agent);
  return HOOK_EVENTS.map((event) => {
    const matcher = matchers[event];
    return { event, ...(matcher === undefined ? {} : { matcher }), command: `${command} hook ${event} --agent ${agent}` };
  });
}

function serverSpec(command: string): { command: string; args: string[] } {
  const [program = "architect", ...args] = command.trim().split(/\s+/);
  return { command: program, args: [...args, "mcp"] };
}

function codexTable(command: string): string {
  const server = serverSpec(command);
  return [`[${TOML_TABLE}]`, "# Managed by Architect: architect sync rewrites this table.", `command = ${tomlString(server.command)}`, `args = [${server.args.map(tomlString).join(", ")}]`].join("\n");
}

function withPath(path: string, run: () => string): string {
  try {
    return run();
  } catch (error) {
    if (error instanceof InstallError) throw error;
    throw new InstallError(path, `${path}: ${(error as Error).message}`);
  }
}

function hooksFile(path: string, agent: "codex" | "claude", command: string, read: ReadFile): GeneratedFile {
  return { path, content: jsonText(mergeHooks(path, readJsonObject(path, read(path)), hookSpecs(agent, command))) };
}

function mcpFile(path: string, command: string, read: ReadFile): GeneratedFile {
  return { path, content: jsonText(mergeMcpServer(path, readJsonObject(path, read(path)), serverSpec(command))) };
}

function skillFiles(dir: string): GeneratedFile[] {
  return SKILL_FILES.map((file) => ({ path: `${dir}/${file.path}`, content: file.content }));
}

/** The files install writes for one agent, merged with the current content that read returns. */
export function planInstall(agent: InstallAgent, input: InstallInput, read: ReadFile): InstallPlan {
  const { command } = input;
  const view: ContractView = input;
  const files: GeneratedFile[] = [{ path: PATHS.agents, content: withPath(PATHS.agents, () => upsertManagedBlock(read(PATHS.agents), agentsBlock(command))) }];
  const notes: string[] = [];
  switch (agent) {
    case "codex":
      files.push(hooksFile(PATHS.codexHooks, "codex", command, read));
      files.push({ path: PATHS.codexConfig, content: upsertTomlTable(read(PATHS.codexConfig), TOML_TABLE, codexTable(command)) });
      files.push(...skillFiles(PATHS.codexSkill));
      notes.push(
        [
          `Codex loads ${PATHS.codexConfig} and ${PATHS.codexHooks} only in trusted projects. Trust this project in ~/.codex/config.toml:`,
          `  [projects."<absolute path of this repository>"]`,
          `  trust_level = "trusted"`,
          "Or add the server to ~/.codex/config.toml yourself:",
          ...codexTable(command).split("\n").filter((line) => !line.startsWith("#")).map((line) => `  ${line}`),
        ].join("\n"),
        "Codex asks you to review and trust the new hooks the next time it starts in this project.",
      );
      break;
    case "claude":
      files.push(hooksFile(PATHS.claudeSettings, "claude", command, read));
      files.push(mcpFile(PATHS.claudeMcp, command, read));
      files.push({ path: PATHS.claudeRules, content: claudeMainRules(command) });
      for (const component of input.architecture.components) {
        files.push({ path: `.claude/rules/architect-${component.id}.md`, content: claudeComponentRules(component, view, command) });
      }
      files.push(...skillFiles(PATHS.claudeSkill));
      notes.push(`Claude Code asks you to approve the project MCP server in ${PATHS.claudeMcp} the first time it starts in this project.`);
      break;
    case "cursor":
      files.push({ path: PATHS.cursorRule, content: cursorRule(view, command) });
      files.push(mcpFile(PATHS.cursorMcp, command, read));
      notes.push("Cursor gets a project rule and the MCP server; Architect installs no Cursor hooks in v0.1.");
      break;
  }
  notes.push(CODEOWNERS_NOTE);
  files.sort((a, b) => compareText(a.path, b.path));
  return { agent, files, notes };
}

/** Parses JSON for detection; unreadable files count as absent. */
function quietJson(path: string, read: ReadFile): Record<string, unknown> {
  try {
    return readJsonObject(path, read(path));
  } catch {
    return {};
  }
}

/** Agents whose Architect-owned entries exist, in INSTALL_AGENTS order. */
export function installedAgents(read: ReadFile): InstallAgent[] {
  const found: Record<InstallAgent, boolean> = {
    codex: architectHookCommands(quietJson(PATHS.codexHooks, read)).length > 0 || readTomlTable(read(PATHS.codexConfig), TOML_TABLE) !== null,
    claude:
      architectHookCommands(quietJson(PATHS.claudeSettings, read)).length > 0 ||
      read(PATHS.claudeRules) !== null ||
      architectServer(quietJson(PATHS.claudeMcp, read)) !== null,
    cursor: read(PATHS.cursorRule) !== null || architectServer(quietJson(PATHS.cursorMcp, read)) !== null,
  };
  return INSTALL_AGENTS.filter((agent) => found[agent]);
}

function fromServer(server: { command: string; args: string[] } | null): string | null {
  if (server === null) return null;
  const args = server.args.at(-1) === "mcp" ? server.args.slice(0, -1) : server.args;
  return [server.command, ...args].join(" ");
}

function fromToml(text: string | null): string | null {
  const table = readTomlTable(text, TOML_TABLE);
  if (table === null) return null;
  const value = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, "m").exec(table)?.[1];
  try {
    const command = JSON.parse(value("command") ?? "null") as unknown;
    const args = JSON.parse(value("args") ?? "[]") as unknown;
    if (typeof command !== "string" || !Array.isArray(args)) return null;
    return fromServer({ command, args: args.filter((a): a is string => typeof a === "string") });
  } catch {
    return null;
  }
}

/** The command recorded in existing generated files: hooks first, then MCP entries. */
export function installedCommand(read: ReadFile): string | null {
  for (const path of [PATHS.codexHooks, PATHS.claudeSettings]) {
    for (const hook of architectHookCommands(quietJson(path, read))) {
      const prefix = hookCommandPrefix(hook);
      if (prefix !== null) return prefix;
    }
  }
  return fromServer(architectServer(quietJson(PATHS.claudeMcp, read))) ?? fromServer(architectServer(quietJson(PATHS.cursorMcp, read))) ?? fromToml(read(PATHS.codexConfig));
}
