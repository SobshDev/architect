import { isAbsolute, resolve } from "node:path";
import { patchPaths } from "./patch.ts";

export type HookAgent = "codex" | "claude";
export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PostToolUse" | "Stop";
export const HOOK_EVENTS: readonly HookEvent[] = ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop"];

export interface HookInput {
  agent: HookAgent;
  event: HookEvent;
  sessionId: string;
  /** Absolute, from the payload. */
  cwd: string;
  /** UserPromptSubmit. */
  prompt?: string;
  /** SessionStart: startup, resume, clear, compact, fork. */
  source?: string;
  /** PostToolUse. */
  toolName?: string;
  /** PostToolUse: absolute paths written or created, sorted, unique. */
  changed: string[];
  /** PostToolUse: absolute paths deleted or moved away, sorted, unique. */
  deleted: string[];
  /** Stop: the host is already continuing because of a Stop hook. */
  stopHookActive: boolean;
}

export class HookInputError extends Error {
  override name = "HookInputError";
}

type FieldType = "string" | "nullable-string" | "boolean" | "any";

// Fields and required sets from Codex's generated input schemas
// (codex-rs/hooks/schema/generated/*.command.input.schema.json). Enum values
// (permission_mode, source) are checked as strings so a newer Codex value
// does not break the hook; unknown fields are ignored for the same reason.
const CODEX_FIELDS: Record<string, FieldType> = {
  agent_id: "string",
  agent_type: "string",
  cwd: "string",
  hook_event_name: "string",
  last_assistant_message: "nullable-string",
  model: "string",
  permission_mode: "string",
  prompt: "string",
  session_id: "string",
  source: "string",
  stop_hook_active: "boolean",
  tool_input: "any",
  tool_name: "string",
  tool_response: "any",
  tool_use_id: "string",
  transcript_path: "nullable-string",
  turn_id: "string",
};

const CODEX_COMMON = ["cwd", "hook_event_name", "model", "permission_mode", "session_id", "transcript_path"];
const CODEX_REQUIRED: Record<HookEvent, readonly string[]> = {
  SessionStart: [...CODEX_COMMON, "source"],
  UserPromptSubmit: [...CODEX_COMMON, "turn_id", "prompt"],
  PostToolUse: [...CODEX_COMMON, "turn_id", "tool_name", "tool_input", "tool_response", "tool_use_id"],
  Stop: [...CODEX_COMMON, "turn_id", "stop_hook_active", "last_assistant_message"],
};

// Claude Code payloads carry many optional and version-dependent fields;
// only the ones Architect reads are required.
const CLAUDE_FIELDS: Record<string, FieldType> = {
  cwd: "string",
  hook_event_name: "string",
  prompt: "string",
  session_id: "string",
  source: "string",
  stop_hook_active: "boolean",
  tool_input: "any",
  tool_name: "string",
};

const CLAUDE_COMMON = ["cwd", "hook_event_name", "session_id"];
const CLAUDE_REQUIRED: Record<HookEvent, readonly string[]> = {
  SessionStart: CLAUDE_COMMON,
  UserPromptSubmit: [...CLAUDE_COMMON, "prompt"],
  PostToolUse: [...CLAUDE_COMMON, "tool_name", "tool_input"],
  Stop: CLAUDE_COMMON,
};

const CLAUDE_EDIT_TOOLS: Record<string, string> = {
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  Write: "file_path",
};

/**
 * Whether a PostToolUse tool name writes files. Codex reports every patch as
 * apply_patch (the Edit and Write aliases exist only in matchers). MultiEdit
 * is gone from current Claude Code but still accepted for older versions.
 */
export function isEditTool(agent: HookAgent, toolName: string): boolean {
  return agent === "codex" ? toolName === "apply_patch" : Object.hasOwn(CLAUDE_EDIT_TOOLS, toolName);
}

export function parseHookInput(agent: HookAgent, event: HookEvent, raw: unknown): HookInput {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HookInputError(`${event} payload must be a JSON object`);
  }
  const payload = raw as Record<string, unknown>;
  const fields = agent === "codex" ? CODEX_FIELDS : CLAUDE_FIELDS;
  const required = agent === "codex" ? CODEX_REQUIRED[event] : CLAUDE_REQUIRED[event];
  for (const name of required) {
    if (!Object.hasOwn(payload, name)) throw new HookInputError(`${event} payload is missing "${name}"`);
  }
  for (const [name, type] of Object.entries(fields)) {
    if (Object.hasOwn(payload, name) && !hasType(payload[name], type)) {
      throw new HookInputError(`${event} payload field "${name}" must be ${type.replace("-", " ")}`);
    }
  }
  if (payload.hook_event_name !== event) {
    throw new HookInputError(`payload is for ${String(payload.hook_event_name)}, expected ${event}`);
  }
  const cwd = payload.cwd as string;
  if (!isAbsolute(cwd)) throw new HookInputError(`${event} payload cwd must be absolute`);
  const sessionId = payload.session_id as string;
  if (sessionId === "") throw new HookInputError(`${event} payload session_id is empty`);

  const input: HookInput = { agent, event, sessionId, cwd, changed: [], deleted: [], stopHookActive: false };
  if (event === "SessionStart" && typeof payload.source === "string") input.source = payload.source;
  if (event === "UserPromptSubmit") input.prompt = payload.prompt as string;
  if (event === "Stop") input.stopHookActive = payload.stop_hook_active === true;
  if (event === "PostToolUse") {
    const toolName = payload.tool_name as string;
    input.toolName = toolName;
    if (isEditTool(agent, toolName)) {
      const paths = agent === "codex" ? codexPaths(payload.tool_input, cwd) : claudePaths(toolName, payload.tool_input, cwd);
      input.changed = paths.changed;
      input.deleted = paths.deleted;
    }
  }
  return input;
}

function hasType(value: unknown, type: FieldType): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "nullable-string":
      return value === null || typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "any":
      return true;
  }
}

/** The patch is tool_input.command: a string today; an argv array such as ["apply_patch", patch] is also read. */
function codexPaths(toolInput: unknown, cwd: string): { changed: string[]; deleted: string[] } {
  const command = isRecord(toolInput) ? toolInput.command : undefined;
  const patch = typeof command === "string"
    ? command
    : Array.isArray(command)
      ? command.find((part): part is string => typeof part === "string" && part.includes("*** Begin Patch"))
      : undefined;
  if (patch === undefined) throw new HookInputError("apply_patch payload has no patch text in tool_input.command");
  return patchPaths(patch, cwd);
}

function claudePaths(toolName: string, toolInput: unknown, cwd: string): { changed: string[]; deleted: string[] } {
  const key = CLAUDE_EDIT_TOOLS[toolName]!;
  const path = isRecord(toolInput) ? toolInput[key] : undefined;
  if (typeof path !== "string" || path === "") {
    throw new HookInputError(`${toolName} payload has no tool_input.${key}`);
  }
  return { changed: [resolve(cwd, path)], deleted: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
