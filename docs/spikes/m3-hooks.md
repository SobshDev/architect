# M3 spike: hook payloads and outputs

Verified on 2026-09-26 against Codex CLI 0.154.0 and Claude Code 2.1.261. The adapter lives in `src/integrations/hooks/`.

## Sources

- Codex hooks documentation: https://developers.openai.com/codex/hooks (fetched 2026-09-26).
- Codex generated schemas from `openai/codex` (`codex-rs/hooks/schema/generated/`), stored in `test/fixtures/hooks/codex/schemas/` during M0.
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks.md (fetched 2026-09-26).
- Claude Code tools reference: https://code.claude.com/docs/en/tools-reference.md (fetched 2026-09-26).
- Live payloads recorded from one headless session per host (below).

## Live recording

Both hosts ran a recorder hook (a Bun script that saves stdin) on SessionStart, UserPromptSubmit, PostToolUse, and Stop in scratch git repositories under `/private/tmp/m3hooks`. The recorder printed nothing, so these runs also confirm that empty stdout is accepted for every event, including Codex Stop.

- Codex: project `.codex/hooks.json`, run with `codex exec --dangerously-bypass-hook-trust -s workspace-write -c 'projects."<dir>".trust_level="trusted"' "<prompt>"`. Project hooks load only when the project layer is trusted, and each hook needs trust by hash unless the bypass flag is passed. The prompt asked for `hello.txt` through apply_patch.
- Claude Code: project `.claude/settings.json`, run with `claude -p "<prompt>" --permission-mode acceptEdits`. No trust step was needed in `-p` mode. The prompt created `hello.txt` (Write) and then edited it (Edit).

Every fixture in `test/fixtures/hooks/{codex,claude}/payloads/` is a recorded payload; none are synthetic. Machine values were replaced: the project path became `/home/user/project`, ids became `session-0001`, `turn-0001`, `prompt-0001`, `tool-use-000N`, transcript paths became fixed placeholders, and the Codex `model` became `example-model`. The Codex fixtures validate against the stored input schemas.

## Codex

- Input matches the generated schemas. Common fields: `session_id`, `transcript_path` (string or null), `cwd`, `hook_event_name`, `model`, `permission_mode`; turn-scoped events add `turn_id`.
- apply_patch: `tool_name` is always `"apply_patch"`. The patch is a **string** in `tool_input.command` (recorded: `{"command": "*** Begin Patch\n*** Add File: hello.txt\n+hi\n*** End Patch\n"}`). Paths in patch headers are relative to `cwd`. `tool_response` was a string. Matchers may also use `Edit` or `Write` as aliases for apply_patch, but the input still reports `apply_patch`.
- Matchers are regular expressions. They apply to `source` for SessionStart and to the tool name for PostToolUse; UserPromptSubmit and Stop ignore them.
- PostToolUse `decision: "block"` cannot undo the edit: Codex replaces the tool result with `reason` and continues the model from it. `hookSpecificOutput.additionalContext` is added as developer context. `systemMessage` is shown as a warning.
- Stop `decision: "block"` makes Codex continue with `reason` as a new user prompt. Stop's output schema has no `hookSpecificOutput`. `stop_hook_active` is true when the turn was already continued by Stop.
- SessionStart output has no `decision` field; UserPromptSubmit `block` rejects the prompt.
- Model-visible hook text over about 2,500 tokens is spilled to a temp file unless the handler sets `additionalContextLimit`.

## Claude Code

- Input fields confirmed live: `session_id`, `transcript_path`, `cwd`, `hook_event_name` on every event; `source` on SessionStart; `prompt` on UserPromptSubmit; `tool_name`, `tool_input`, `tool_response`, `tool_use_id` on PostToolUse; `stop_hook_active` and `last_assistant_message` on Stop. Extra fields appear and vary by version (`prompt_id`, `permission_mode`, `effort`, `duration_ms`, `background_tasks`, `session_crons`), so the adapter ignores unknown fields.
- Write and Edit send an absolute `tool_input.file_path`. NotebookEdit uses `notebook_path`. MultiEdit is no longer in the tools reference; the adapter still accepts it for older versions.
- A matcher made only of letters, digits, `_`, `-`, spaces, `,`, and `|` is an exact list of names, so `Edit|Write|MultiEdit` does not match NotebookEdit.
- Outputs: top-level `decision: "block"` with `reason` for UserPromptSubmit, PostToolUse, and Stop; `hookSpecificOutput` with `hookEventName` and `additionalContext` for SessionStart, UserPromptSubmit, and PostToolUse; `systemMessage` is shown to the user. SessionStart cannot block. PostToolUse block adds `reason` next to the tool result.
- Stop: `decision: "block"` requires `reason` and keeps Claude working. `hookSpecificOutput.additionalContext` on Stop **also** keeps the conversation going. Claude caps consecutive Stop continuations at 8.
- `additionalContext` and `systemMessage` are capped at 10,000 characters.

## Decisions for the adapter

- Both hosts accept the same JSON for the four events, so `formatHookOutput` emits one shape: `decision`/`reason`, `hookSpecificOutput`, `systemMessage`, and prints `""` for an empty result.
- A block on SessionStart, or on Stop while `stop_hook_active` is set, is moved into `systemMessage`. Stop context is always moved into `systemMessage`, because Codex's Stop schema has no `additionalContext` and Claude treats it as a request to continue.
- Codex payloads are checked for the schema's required fields and field types; enum values and unknown fields are accepted so a newer Codex keeps working.
