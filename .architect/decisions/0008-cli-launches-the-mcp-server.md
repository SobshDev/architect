---
status: accepted
date: 2026-09-26
decision-makers: [Gabriel Brument]
governs: [cli, mcp]
weakens: [entry-points-independent]
evidence:
  - source: docs/plan/v0.1.md
    quote: "`status`, `install --agent codex|claude|cursor`, `sync`, `schema`, `mcp`, `hook <event> --agent <name>`, `ci`"
  - source: docs/plan/v0.1.md
    quote: "served with `serveStdio`. It keeps no state between calls and logs to stderr."
---

# The CLI launches the MCP server

## Context and Problem Statement

Decision 0002 made the CLI and the MCP server two independent composition roots, and rule entry-points-independent forbids any import between them. The plan also gives the CLI an `architect mcp` command, which hosts such as Codex and Claude Code run to start the server over stdio. That command has to reach the server's code, so the two roots cannot stay fully independent.

## Considered Options

* Let the CLI import the MCP server's entry point, and forbid the reverse direction
* Ship a second executable for the MCP server
* Move the server into the engine

## Decision Outcome

Chosen option: "Let the CLI import the MCP server's entry point, and forbid the reverse direction", because hosts need one installed command, a second executable doubles packaging for the npm package and the compiled binaries, and the engine must stay free of the MCP SDK (decision 0004).

### Consequences

* Good, because `architect mcp` works from the same binary and the same npm bin entry.
* Good, because rule mcp-never-imports-cli keeps the server from depending on command-line parsing or output.
* Bad, because the CLI now depends on the MCP SDK; the `mcp` command imports it lazily so other commands do not pay its startup cost.
