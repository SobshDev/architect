import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  formatHookOutput,
  HOOK_EVENTS,
  hookMatchers,
  HookInputError,
  isEditTool,
  parseHookInput,
  type HookAgent,
  type HookEvent,
  type HookResult,
} from "./index.ts";

const FIXTURES = join(import.meta.dir, "../../../test/fixtures/hooks");
const AGENTS: HookAgent[] = ["codex", "claude"];
const SCHEMA_NAMES: Record<HookEvent, string> = {
  SessionStart: "session-start",
  UserPromptSubmit: "user-prompt-submit",
  PostToolUse: "post-tool-use",
  Stop: "stop",
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

async function readJson(path: string): Promise<Json> {
  return (await Bun.file(path).json()) as Json;
}

function codexSchema(event: HookEvent, kind: "input" | "output"): Promise<Json> {
  return readJson(join(FIXTURES, "codex/schemas", `${SCHEMA_NAMES[event]}.command.${kind}.schema.json`));
}

async function payloads(agent: HookAgent): Promise<{ file: string; payload: Record<string, Json> }[]> {
  const dir = join(FIXTURES, agent, "payloads");
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  return Promise.all(files.map(async (file) => ({ file, payload: (await readJson(join(dir, file))) as Record<string, Json> })));
}

async function payload(agent: HookAgent, file: string): Promise<Record<string, Json>> {
  return (await readJson(join(FIXTURES, agent, "payloads", file))) as Record<string, Json>;
}

/** A minimal draft-07 checker covering what Codex's generated hook schemas use. */
function schemaErrors(schema: Json, value: Json, root: Json = schema, at = "$"): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${at}: not allowed`];
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) throw new Error(`bad schema at ${at}`);
  if (typeof schema.$ref === "string") {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce<Json>((node, key) => (node as Record<string, Json>)[key]!, root);
    return schemaErrors(target, value, root, at);
  }
  const errors: string[] = [];
  for (const part of (schema.allOf as Json[] | undefined) ?? []) errors.push(...schemaErrors(part, value, root, at));
  if ("const" in schema && value !== schema.const) errors.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${at}: not in enum`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (!types.includes(actual)) errors.push(`${at}: expected ${types.join("|")}, got ${actual}`);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in value)) errors.push(`${at}.${key}: required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) errors.push(...schemaErrors(properties[key]!, child, root, `${at}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${at}.${key}: additional property`);
    }
  }
  return errors;
}

function withEvent(agent: HookAgent, event: HookEvent, fields: Record<string, Json>): Record<string, Json> {
  const common = { session_id: "session-0001", cwd: "/home/user/project", hook_event_name: event };
  if (agent === "claude") return { ...common, ...fields };
  return { ...common, model: "example-model", permission_mode: "default", transcript_path: null, turn_id: "turn-0001", ...fields };
}

describe("recorded payloads", () => {
  for (const agent of AGENTS) {
    test(`${agent}: every fixture parses as its own event`, async () => {
      const all = await payloads(agent);
      expect(new Set(all.map((p) => p.payload.hook_event_name))).toEqual(new Set(HOOK_EVENTS));
      for (const { payload } of all) {
        const event = payload.hook_event_name as HookEvent;
        const input = parseHookInput(agent, event, payload);
        expect(input).toMatchObject({ agent, event, sessionId: "session-0001", cwd: "/home/user/project" });
      }
    });
  }

  test("codex fixtures validate against the stored input schemas", async () => {
    for (const { file, payload } of await payloads("codex")) {
      const schema = await codexSchema(payload.hook_event_name as HookEvent, "input");
      expect({ file, errors: schemaErrors(schema, payload) }).toEqual({ file, errors: [] });
    }
  });

  test("edit payloads yield absolute changed paths", async () => {
    const expected = { changed: ["/home/user/project/hello.txt"], deleted: [] };
    expect(parseHookInput("codex", "PostToolUse", await payload("codex", "PostToolUse.json"))).toMatchObject(expected);
    expect(parseHookInput("claude", "PostToolUse", await payload("claude", "PostToolUse.json"))).toMatchObject(expected);
    expect(parseHookInput("claude", "PostToolUse", await payload("claude", "PostToolUse.edit.json"))).toMatchObject(expected);
  });

  test("event-specific fields are carried over", async () => {
    expect(parseHookInput("codex", "SessionStart", await payload("codex", "SessionStart.json")).source).toBe("startup");
    expect(parseHookInput("claude", "UserPromptSubmit", await payload("claude", "UserPromptSubmit.json")).prompt).toStartWith("Create hello.txt");
    const stop = await payload("claude", "Stop.json");
    expect(parseHookInput("claude", "Stop", stop).stopHookActive).toBe(false);
    expect(parseHookInput("claude", "Stop", { ...stop, stop_hook_active: true }).stopHookActive).toBe(true);
  });
});

describe("parseHookInput validation", () => {
  test("codex: every field the stored schema requires is required", async () => {
    for (const { payload } of await payloads("codex")) {
      const event = payload.hook_event_name as HookEvent;
      const schema = (await codexSchema(event, "input")) as { required: string[] };
      for (const field of schema.required) {
        const { [field]: _removed, ...rest } = payload;
        expect(() => parseHookInput("codex", event, rest)).toThrow(HookInputError);
      }
    }
  });

  test("codex: unknown fields from a newer Codex are accepted", async () => {
    const stop = await payload("codex", "Stop.json");
    expect(parseHookInput("codex", "Stop", { ...stop, future_field: { x: 1 } }).event).toBe("Stop");
  });

  test("codex: a known field with the wrong type is rejected", async () => {
    const stop = await payload("codex", "Stop.json");
    expect(() => parseHookInput("codex", "Stop", { ...stop, stop_hook_active: "yes" })).toThrow(HookInputError);
    expect(() => parseHookInput("codex", "Stop", { ...stop, transcript_path: 3 })).toThrow(HookInputError);
  });

  test("claude: missing stop_hook_active means not active", () => {
    expect(parseHookInput("claude", "Stop", withEvent("claude", "Stop", {})).stopHookActive).toBe(false);
  });

  for (const agent of AGENTS) {
    test(`${agent}: rejects non-objects, the wrong event, relative cwd, and empty session ids`, () => {
      const ok = withEvent(agent, "SessionStart", { source: "startup" });
      expect(parseHookInput(agent, "SessionStart", ok).event).toBe("SessionStart");
      for (const bad of [null, "text", [ok]]) expect(() => parseHookInput(agent, "SessionStart", bad)).toThrow(HookInputError);
      expect(() => parseHookInput(agent, "Stop", { ...ok, stop_hook_active: false, last_assistant_message: null })).toThrow(HookInputError);
      expect(() => parseHookInput(agent, "SessionStart", { ...ok, cwd: "project" })).toThrow(HookInputError);
      expect(() => parseHookInput(agent, "SessionStart", { ...ok, session_id: "" })).toThrow(HookInputError);
    });
  }
});

describe("PostToolUse paths", () => {
  const tool = (agent: HookAgent, tool_name: string, tool_input: Json) =>
    parseHookInput(agent, "PostToolUse", withEvent(agent, "PostToolUse", { tool_name, tool_input, tool_response: "", tool_use_id: "tool-use-0001" }));

  test("non-edit tools yield no paths, even when their input looks like an edit", () => {
    const patch = "*** Begin Patch\n*** Add File: x.ts\n+x\n*** End Patch";
    expect(tool("codex", "Bash", { command: patch })).toMatchObject({ toolName: "Bash", changed: [], deleted: [] });
    expect(tool("claude", "Read", { file_path: "/home/user/project/x.ts" })).toMatchObject({ changed: [], deleted: [] });
    expect(tool("claude", "Bash", { command: "rm x.ts" })).toMatchObject({ changed: [], deleted: [] });
  });

  test("codex: reads patch text given as an argv array", () => {
    const patch = "*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch";
    expect(tool("codex", "apply_patch", { command: ["apply_patch", patch] })).toMatchObject({
      changed: [],
      deleted: ["/home/user/project/gone.ts"],
    });
  });

  test("edit tools without a path are rejected", () => {
    expect(() => tool("codex", "apply_patch", {})).toThrow(HookInputError);
    expect(() => tool("claude", "Write", { content: "x" })).toThrow(HookInputError);
  });

  test("claude: relative file paths resolve against cwd and NotebookEdit uses notebook_path", () => {
    expect(tool("claude", "Write", { file_path: "src/a.ts", content: "" }).changed).toEqual(["/home/user/project/src/a.ts"]);
    expect(tool("claude", "NotebookEdit", { notebook_path: "/home/user/project/n.ipynb", new_source: "" }).changed).toEqual([
      "/home/user/project/n.ipynb",
    ]);
  });

  test("installed matchers only select tools the adapter treats as edits", () => {
    expect(isEditTool("codex", "apply_patch")).toBe(true);
    expect(new RegExp(hookMatchers("codex").PostToolUse!).test("apply_patch")).toBe(true);
    for (const name of hookMatchers("claude").PostToolUse!.split("|")) expect(isEditTool("claude", name)).toBe(true);
  });
});

describe("formatHookOutput", () => {
  const results: HookResult[] = [
    { block: "rule layering violated" },
    { context: "warning: import crosses a boundary" },
    { systemMessage: "architect checked 2 files" },
    { block: "b", context: "c", systemMessage: "s" },
  ];
  const parsed = (agent: HookAgent, event: HookEvent, result: HookResult, stopHookActive = false) =>
    JSON.parse(formatHookOutput(agent, event, result, { stopHookActive })) as Record<string, Json>;

  test("an empty result prints nothing", () => {
    for (const agent of AGENTS) {
      for (const event of HOOK_EVENTS) {
        expect(formatHookOutput(agent, event, {})).toBe("");
        expect(formatHookOutput(agent, event, { block: "", context: "  ", systemMessage: "\n" })).toBe("");
      }
    }
  });

  test("every codex output validates against the stored output schema", async () => {
    const sessionStart = await codexSchema("SessionStart", "output");
    expect(schemaErrors(sessionStart, { decision: "block", reason: "r" })).not.toEqual([]);
    for (const event of HOOK_EVENTS) {
      const schema = await codexSchema(event, "output");
      for (const result of results) {
        for (const active of [false, true]) {
          expect(schemaErrors(schema, parsed("codex", event, result, active))).toEqual([]);
        }
      }
    }
  });

  test("PostToolUse carries block, context, and message in the shared shape", () => {
    for (const agent of AGENTS) {
      expect(parsed(agent, "PostToolUse", { block: "b", context: "c", systemMessage: "s" })).toEqual({
        decision: "block",
        reason: "b",
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: "c" },
        systemMessage: "s",
      });
    }
  });

  test("SessionStart never blocks; the reason reaches the user instead", () => {
    for (const agent of AGENTS) {
      const out = parsed(agent, "SessionStart", { block: "b", context: "c" });
      expect(out).toEqual({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "c" }, systemMessage: "b" });
    }
  });

  test("Stop blocks once, then never blocks or continues while stop_hook_active", () => {
    for (const agent of AGENTS) {
      expect(parsed(agent, "Stop", { block: "fix the layering error" })).toEqual({ decision: "block", reason: "fix the layering error" });
      for (const result of results) {
        const out = parsed(agent, "Stop", result, true);
        expect(out.decision).toBeUndefined();
        expect(out.hookSpecificOutput).toBeUndefined();
      }
      expect(parsed(agent, "Stop", { block: "b", systemMessage: "s" }, true)).toEqual({ systemMessage: "s\n\nb" });
    }
  });

  test("Stop context goes to the user, because Stop additionalContext would keep the agent working", () => {
    for (const agent of AGENTS) {
      expect(parsed(agent, "Stop", { context: "c" })).toEqual({ systemMessage: "c" });
    }
  });
});
