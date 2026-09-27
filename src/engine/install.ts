import { readdirSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  INSTALL_AGENTS,
  type InstallAgent,
  InstallError,
  installedAgents,
  installedCommand,
  type ListDir,
  planInstall,
  type ReadFile,
} from "../integrations/index.ts";
import { compareText, type Finding, keyFingerprint } from "../model/index.ts";
import { writeRepoFile } from "../store/index.ts";
import { UsageError } from "./errors.ts";
import { openWorkspace, requireValidContract, type Workspace } from "./workspace.ts";

export interface InstallResult {
  agents: InstallAgent[];
  /** Repo paths written, sorted. */
  written: string[];
  /** Repo paths already up to date, sorted. */
  unchanged: string[];
  /** Generated repo paths deleted because they no longer belong, sorted. */
  removed: string[];
  notes: string[];
}

const PACKAGE_NAME = "@sobshdev/architect";
const DRIFT_RULE = "generated-drift";

function diskReader(root: string): ReadFile {
  return (path) => {
    try {
      return readFileSync(join(root, path), "utf8");
    } catch {
      return null;
    }
  };
}

function diskLister(root: string): ListDir {
  return (dir) => {
    try {
      return readdirSync(join(root, dir)).sort(compareText);
    } catch {
      return [];
    }
  };
}

/** "architect" when on PATH, else the repo's dependency through bunx, else the published package through bunx. */
function defaultCommand(read: ReadFile): string {
  if (Bun.which("architect") !== null) return "architect";
  try {
    const pkg = JSON.parse(read("package.json") ?? "{}") as { dependencies?: object; devDependencies?: object };
    if (PACKAGE_NAME in (pkg.dependencies ?? {}) || PACKAGE_NAME in (pkg.devDependencies ?? {})) return "bunx architect";
  } catch {
    // An unreadable package.json means no local dependency.
  }
  return `bunx ${PACKAGE_NAME}`;
}

interface Generated {
  /** Final content per path after every agent's plan, in path order. */
  files: Map<string, string>;
  /** Stale generated paths to delete, sorted. */
  remove: string[];
  notes: string[];
}

/** Plans each agent in turn; later plans see earlier plans' output, so shared files such as AGENTS.md merge once. */
function generate(ws: Workspace, agents: readonly InstallAgent[], command: string, disk: ReadFile, list: ListDir): Generated {
  const overlay = new Map<string, string>();
  const read: ReadFile = (path) => overlay.get(path) ?? disk(path);
  const notes: string[] = [];
  const remove = new Set<string>();
  const { architecture, rules, decisions } = ws.contract;
  for (const agent of agents) {
    const plan = planInstall(agent, { architecture, rules, decisions, command }, read, list);
    for (const file of plan.files) overlay.set(file.path, file.content);
    for (const path of plan.remove) remove.add(path);
    for (const note of plan.notes) if (!notes.includes(note)) notes.push(note);
  }
  const files = new Map([...overlay].sort(([a], [b]) => compareText(a, b)));
  return { files, remove: [...remove].filter((path) => !overlay.has(path)).sort(compareText), notes };
}

async function writeGenerated(ws: Workspace, agents: InstallAgent[], command: string): Promise<InstallResult> {
  const disk = diskReader(ws.root);
  let generated: Generated;
  try {
    generated = generate(ws, agents, command, disk, diskLister(ws.root));
  } catch (error) {
    if (error instanceof InstallError) throw new UsageError(error.message);
    throw error;
  }
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const [path, content] of generated.files) {
    if (disk(path) === content) {
      unchanged.push(path);
      continue;
    }
    await writeRepoFile(ws.root, path, content);
    written.push(path);
  }
  const removed: string[] = [];
  for (const path of generated.remove) {
    await unlink(join(ws.root, path));
    removed.push(path);
  }
  return { agents, written, unchanged, removed, notes: generated.notes };
}

/** Writes or updates one agent's integration files. The command is the explicit one, else the one already installed, else the default. */
export async function runInstall(cwd: string, options: { agent: InstallAgent; command?: string; today?: string }): Promise<InstallResult> {
  if (!INSTALL_AGENTS.includes(options.agent)) throw new UsageError(`Unknown agent "${options.agent}". Use ${INSTALL_AGENTS.join(", ")}.`);
  if (options.command !== undefined && options.command.trim() === "") throw new UsageError("--command must not be empty.");
  const ws = await openWorkspace(cwd, { today: options.today });
  requireValidContract(ws);
  const disk = diskReader(ws.root);
  const command = options.command?.trim() ?? installedCommand(disk) ?? defaultCommand(disk);
  return writeGenerated(ws, [options.agent], command);
}

/** Regenerates the files of every installed agent, keeping the command they already use. */
export async function runSync(cwd: string, options: { today?: string } = {}): Promise<InstallResult> {
  const ws = await openWorkspace(cwd, { today: options.today });
  requireValidContract(ws);
  const disk = diskReader(ws.root);
  const agents = installedAgents(disk);
  if (agents.length === 0) {
    return { agents, written: [], unchanged: [], removed: [], notes: [`No agent integration is installed. Run architect install --agent ${INSTALL_AGENTS.join("|")}.`] };
  }
  return writeGenerated(ws, agents, installedCommand(disk) ?? defaultCommand(disk));
}

function driftFinding(path: string, message: string): Finding {
  return {
    rule: DRIFT_RULE,
    kind: "drift",
    level: "warn",
    message,
    location: { file: path },
    because: [],
    fingerprint: keyFingerprint(DRIFT_RULE, path),
    status: "new",
  };
}

/** One warning per generated file whose content differs from what sync would write, sorted by path. */
export async function driftFindings(ws: Workspace): Promise<Finding[]> {
  const disk = diskReader(ws.root);
  const agents = installedAgents(disk);
  if (agents.length === 0) return [];
  let generated: Generated;
  try {
    generated = generate(ws, agents, installedCommand(disk) ?? defaultCommand(disk), disk, diskLister(ws.root));
  } catch (error) {
    if (error instanceof InstallError) return [driftFinding(error.path, error.message)];
    throw error;
  }
  const findings: Finding[] = [];
  for (const [path, content] of generated.files) {
    if (disk(path) !== content) findings.push(driftFinding(path, `${path} is out of date. Run architect sync.`));
  }
  for (const path of generated.remove) findings.push(driftFinding(path, `${path} was generated for something the contract no longer has. Run architect sync to delete it.`));
  return findings.sort((a, b) => compareText(a.location?.file ?? "", b.location?.file ?? ""));
}

export function formatInstall(result: InstallResult): string {
  const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;
  const lines: string[] = [];
  if (result.agents.length > 0) lines.push(`Architect integration for ${result.agents.join(", ")}.`);
  if (result.written.length > 0) lines.push(`Wrote ${files(result.written.length)}:`, ...result.written.map((path) => `  ${path}`));
  if (result.removed.length > 0) lines.push(`Removed ${files(result.removed.length)}:`, ...result.removed.map((path) => `  ${path}`));
  if (result.unchanged.length > 0) lines.push(`${files(result.unchanged.length)} already up to date.`);
  if (result.notes.length > 0) lines.push("", ...result.notes);
  return lines.join("\n");
}
