# M3 spike: install, sync, and drift

Verified on 2026-09-26 against Codex CLI 0.154.0 and Claude Code 2.1.261. The code lives in `src/integrations/install/` (pure planning; readers passed in) and `src/engine/install.ts` (disk reads and writes).

## Sources

- Codex hooks: https://developers.openai.com/docs/hooks (read 2026-09-26). `hooks.json` holds `{"hooks": {Event: [{"matcher"?, "hooks": [{"type": "command", "command", "statusMessage"?}]}]}}`; matchers apply to the tool name for PostToolUse and to `source` for SessionStart; unmanaged hooks must be reviewed and trusted.
- Codex project config and MCP: https://developers.openai.com/docs/config-file/config-basic and https://developers.openai.com/learn/docs-mcp (read 2026-09-26). `[mcp_servers.<name>]` in a project's `.codex/config.toml` loads only when the project is trusted (`trust_level = "trusted"` under `[projects."<abs path>"]` in `~/.codex/config.toml`).
- Codex skills: https://developers.openai.com/plugins/build/skills and https://github.com/openai/codex/blob/main/docs/skills.md (read 2026-09-26). Repository skills live in `.agents/skills/<name>/SKILL.md` with an optional `references/` folder.
- Claude Code: lane H1's live recording (docs/spikes/m3-hooks.md, test/fixtures/hooks/claude/payloads/) and the Claude Code hooks and tools references it cites (code.claude.com/docs, fetched 2026-09-26).

## Checked with the installed CLIs

- Codex loads a project's `.codex/hooks.json` when the project is trusted: lane H1 recorded live payloads from exactly that file with Codex 0.154.0.
- `codex mcp list` (and `--json`), run in a scratch project under `/private/tmp/m3install` with a `[mcp_servers.architect]` table in `.codex/config.toml`, did not list the project server, neither untrusted nor with `-c 'projects."<dir>".trust_level="trusted"'`. The subcommand may read only the user layer, so this neither confirms nor refutes the documented behavior. Project MCP loading stays **unconfirmed on the CLI**; install writes the project table (as documented) and prints the trust snippet plus a user-config fallback.

## What install writes

| Agent | Files | Merge |
|---|---|---|
| all | `AGENTS.md` block between `<!-- architect:begin -->` and `<!-- architect:end -->` (26 lines) | block replaced in place or appended after a blank line |
| codex | `.codex/hooks.json` | Architect hooks replaced, everything else kept |
| codex | `.codex/config.toml` `[mcp_servers.architect]` | table text replaced or appended; rest byte for byte |
| codex | `.agents/skills/architect/{SKILL.md,references/*.md}` | owned, overwritten |
| claude | `.claude/settings.json` hooks | as Codex |
| claude | `.mcp.json` `mcpServers.architect` | entry replaced in place (extra keys such as `env` kept) |
| claude | `.claude/rules/architect.md` (no front matter, always loaded) and `.claude/rules/architect-<component>.md` (`paths:` front matter) | owned |
| claude | `.claude/skills/architect/...` | owned |
| cursor | `.cursor/rules/architect.mdc` (`description`, empty `globs`, `alwaysApply: true`), `.cursor/mcp.json` | rule owned; MCP merged |

Printed, never written: the CODEOWNERS suggestion `/.architect/ @your-team`, the Codex trust note with the user-config snippet, a Codex hook-trust reminder, and a Claude note that project MCP servers need approval.

## Format decisions

- Hooks: SessionStart, UserPromptSubmit, PostToolUse, Stop, each `<command> hook <Event> --agent <agent>`. Only PostToolUse has a matcher: `apply_patch` for Codex, `Edit|Write|MultiEdit|NotebookEdit` for Claude (an exact name list; MultiEdit kept for older versions). SessionStart has no matcher so every source (startup, resume, clear, compact) gets the brief. No `statusMessage`.
- Ownership: a hook is Architect's when its command contains `architect`, ` hook `, and `--agent`; a server is Architect's when named `architect`. Each regenerated hook group takes the position of the first group that held an Architect hook, so reruns are byte-stable and user groups keep their order. A user hook sharing a group with Architect's is split into its own group with the same matcher.
- JSON is rewritten with 2-space indentation and a trailing newline. A file that is not a JSON object is left untouched and install fails with a usage error naming it; `check` reports it as drift.
- TOML is edited without a library: the table runs from its header to the next header (`[x]` or `[[x]]`), minus trailing blank and comment lines, which belong to the next table. Quoted and spaced headers match; subtables such as `[mcp_servers.architect.env]` are separate tables and are kept. A managed comment sits inside the table.
- MCP command: the resolved command is split on whitespace; the first word is `command`, the rest plus `mcp` are `args`.
- AGENTS.md: a begin marker without an end marker is an error (replacing to the end of the file could delete user text).
- Component rules: a glob-free path `src/domain` becomes `src/domain/**`; a path whose last segment has a dot also keeps itself (it may be a file). A rule is listed for a component when its selectors name the component or cover all components (`acyclic` without `within`). Rules at level `off` are left out. Decisions listed are accepted ones whose `governs` names the component id or one of its paths.
- Skill files are embedded with Bun text imports (`with { type: "text" }`), checked with `bun build`; `text.d.ts` declares `*.md` modules.
- Command resolution: explicit `--command`, else the command already in generated files (so a second agent and `sync` keep it), else `architect` when on PATH, else `bunx architect` when package.json depends on `@sobshdev/architect`, else `bunx @sobshdev/architect`. Recovery reads hooks first, then MCP entries, then the TOML table.
- Sync plans installed agents in order, each seeing earlier output, so shared files merge once. Drift compares those final contents with disk: one warn finding per differing path, fingerprint `keyFingerprint("generated-drift", path)`.

## Limitations

- Files for a removed component (`.claude/rules/architect-<id>.md`) are not deleted by sync, and drift does not report them.
- A custom `--command` without the word `architect` makes hooks unrecognizable, so later runs add duplicates.
- Codex MCP entries written as dotted keys or inline tables (`mcp_servers.architect.command = ...` at the root) are not detected.
- Paths with spaces in `--command` break the MCP split.
