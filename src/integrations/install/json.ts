import { InstallError } from "./errors.ts";

export type JsonObject = Record<string, unknown>;

export const SERVER_NAME = "architect";

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses an existing JSON object file. Missing or blank files are empty objects. */
export function readJsonObject(path: string, text: string | null): JsonObject {
  if (text === null || text.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new InstallError(path, `${path} is not valid JSON (${(error as Error).message}). Fix it, then run install again.`);
  }
  if (!isObject(value)) throw new InstallError(path, `${path} must hold a JSON object. Fix it, then run install again.`);
  return value;
}

export function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Generated hook commands have the shape "<command> hook <Event> --agent <agent>". Ownership goes by that shape,
 * so a custom --command without "architect" in it is still recognized and replaced instead of duplicated.
 */
const HOOK_COMMAND = /^(.*\S)\s+hook\s+[A-Za-z]+\s+--agent\s+[a-z]+\s*$/;

/** True for hook commands Architect generated. */
export function isArchitectHookCommand(command: unknown): command is string {
  return typeof command === "string" && HOOK_COMMAND.test(command);
}

/** The command prefix of a generated hook command, such as "bunx architect". */
export function hookCommandPrefix(command: string): string | null {
  return HOOK_COMMAND.exec(command)?.[1] ?? null;
}

export interface HookSpec {
  event: string;
  matcher?: string;
  command: string;
}

function ownsHook(hook: unknown): boolean {
  return isObject(hook) && isArchitectHookCommand(hook.command);
}

/**
 * Replaces Architect's hooks in a settings object ({"hooks": {Event: [{matcher?, hooks: [...]}]}}) with specs.
 * Other hooks, matchers, and keys stay. Each Architect group takes the place of the first group that held an Architect hook,
 * so a second run changes nothing.
 */
export function mergeHooks(path: string, settings: JsonObject, specs: readonly HookSpec[]): JsonObject {
  const current = settings.hooks === undefined ? {} : settings.hooks;
  if (!isObject(current)) throw new InstallError(path, `"hooks" in ${path} must be an object. Fix it, then run install again.`);
  const hooks: JsonObject = {};
  const insertAt = new Map<string, number>();
  for (const [event, groups] of Object.entries(current)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept: unknown[] = [];
    for (const group of groups) {
      const inner = isObject(group) && Array.isArray(group.hooks) ? group.hooks : null;
      if (inner === null || !inner.some(ownsHook)) {
        kept.push(group);
        continue;
      }
      if (!insertAt.has(event)) insertAt.set(event, kept.length);
      const others = inner.filter((hook) => !ownsHook(hook));
      if (others.length > 0) kept.push({ ...group, hooks: others });
    }
    hooks[event] = kept;
  }
  for (const spec of specs) {
    const list = Array.isArray(hooks[spec.event]) ? (hooks[spec.event] as unknown[]) : [];
    const group: JsonObject = spec.matcher === undefined ? {} : { matcher: spec.matcher };
    group.hooks = [{ type: "command", command: spec.command }];
    const at = Math.min(insertAt.get(spec.event) ?? list.length, list.length);
    hooks[spec.event] = [...list.slice(0, at), group, ...list.slice(at)];
  }
  for (const [event, groups] of Object.entries(hooks)) if (Array.isArray(groups) && groups.length === 0) delete hooks[event];
  return { ...settings, hooks };
}

/** The Architect hook commands in a settings object. */
export function architectHookCommands(settings: JsonObject): string[] {
  if (!isObject(settings.hooks)) return [];
  const out: string[] = [];
  for (const groups of Object.values(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      for (const hook of group.hooks) if (isObject(hook) && isArchitectHookCommand(hook.command)) out.push(hook.command);
    }
  }
  return out;
}

/** Sets mcpServers.architect, keeping the other servers and the entry's position. */
export function mergeMcpServer(path: string, config: JsonObject, server: { command: string; args: string[] }): JsonObject {
  const current = config.mcpServers === undefined ? {} : config.mcpServers;
  if (!isObject(current)) throw new InstallError(path, `"mcpServers" in ${path} must be an object. Fix it, then run install again.`);
  const previous = current[SERVER_NAME];
  // Keeps keys the user added to the entry, such as env.
  const entry = isObject(previous) ? { ...previous, command: server.command, args: server.args } : { command: server.command, args: server.args };
  return { ...config, mcpServers: { ...current, [SERVER_NAME]: entry } };
}

/** The architect MCP server entry, when present. */
export function architectServer(config: JsonObject): { command: string; args: string[] } | null {
  const servers = config.mcpServers;
  if (!isObject(servers)) return null;
  const entry = servers[SERVER_NAME];
  if (!isObject(entry) || typeof entry.command !== "string") return null;
  const args = Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [];
  return { command: entry.command, args };
}
