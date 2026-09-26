import type { HookAgent, HookEvent, HookInput } from "./input.ts";

export interface HookResult {
  /** Reason; the host tells the agent and, for Stop, keeps it working. */
  block?: string;
  /** additionalContext for the model. */
  context?: string;
  /** Shown to the user. */
  systemMessage?: string;
}

/**
 * Formats a hook result as the JSON the host reads from stdout, or "" when
 * there is nothing to say. Both hosts share one shape for these four events:
 * top-level decision/reason, hookSpecificOutput.additionalContext, and
 * systemMessage. A block that the event cannot honor becomes part of the
 * systemMessage: SessionStart never blocks, and Stop never blocks once the
 * host is already continuing because of a Stop hook. Stop context also goes
 * to systemMessage, because Codex's Stop output has no additionalContext and
 * Claude Code treats Stop additionalContext as a request to keep working.
 */
export function formatHookOutput(
  agent: HookAgent,
  event: HookEvent,
  result: HookResult,
  input?: Pick<HookInput, "stopHookActive">,
): string {
  let block = present(result.block);
  let context = present(result.context);
  const messages = [present(result.systemMessage)];
  const canBlock = event !== "SessionStart" && !(event === "Stop" && input?.stopHookActive === true);
  if (block !== undefined && !canBlock) {
    messages.push(block);
    block = undefined;
  }
  if (context !== undefined && event === "Stop") {
    messages.push(context);
    context = undefined;
  }
  const systemMessage = messages.filter((m) => m !== undefined).join("\n\n");

  const output: Record<string, unknown> = {};
  if (block !== undefined) {
    output.decision = "block";
    output.reason = block;
  }
  if (context !== undefined) output.hookSpecificOutput = { hookEventName: event, additionalContext: context };
  if (systemMessage !== "") output.systemMessage = systemMessage;
  return Object.keys(output).length === 0 ? "" : `${JSON.stringify(output)}\n`;
}

/**
 * Matcher strings for the installer. Undefined means the entry has no matcher
 * and fires on every occurrence (Codex ignores matchers for UserPromptSubmit
 * and Stop; SessionStart should run for every source). Claude Code treats
 * "Edit|Write|MultiEdit" as an exact-name list, so it does not match NotebookEdit.
 */
export function hookMatchers(agent: HookAgent): Record<HookEvent, string | undefined> {
  return {
    SessionStart: undefined,
    UserPromptSubmit: undefined,
    PostToolUse: agent === "codex" ? "apply_patch" : "Edit|Write|MultiEdit",
    Stop: undefined,
  };
}

function present(text: string | undefined): string | undefined {
  return text === undefined || text.trim() === "" ? undefined : text;
}
