# Architect

Architect gives coding agents a codebase's design intent before they edit, and checks every edit and pull request against it.

It stores components, decisions with their reasons, and checkable rules in `.architect/`. Agents read the relevant slice through the CLI, an MCP server, hooks, and a skill. CI fails when a change breaks a rule or loosens one without an accepted decision. Architect is deterministic: the host agent (Codex, Claude Code, Cursor) does the reasoning, and Architect never calls a model API.

Status: under construction (v0.1). See docs/plan/v0.1.md.
