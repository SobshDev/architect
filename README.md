# Architect

Architect gives coding agents a codebase's design intent before they edit, and checks every edit and pull request against it.

It stores components, decisions with their reasons, and checkable rules in `.architect/`. Agents read the relevant slice through the CLI, an MCP server, hooks, and a skill. CI fails when a change breaks a rule, or loosens one without an accepted decision. Architect is deterministic: the host agent (Codex, Claude Code, Cursor) does the reasoning, and Architect never calls a model API.

v0.1 analyzes TypeScript/JavaScript and Python. It runs on [Bun](https://bun.sh) 1.3.14 or newer.

## Install

Add it to the repository you want to check:

```bash
bun add -d @sobshdev/architect
```

Or install the `architect` command globally with `bun add -g @sobshdev/architect`. The examples below use `bunx architect`, which works either way.

## Quick start

```bash
bunx architect init                    # map the code into .architect/
bunx architect install --agent codex   # or claude, or cursor
bunx architect check --changed         # check your current edits
```

`init` infers components from workspaces and top source folders, writes warn-level rules (no cycles, plus the layers it can infer), and freezes current violations into a baseline. From then on only new violations fail, and the baseline can only shrink. Review `.architect/architecture.yaml` and `.architect/rules.yaml`, raise the rules you trust to `error`, and commit the folder. `init --new` writes empty files instead, for designing a new system with your agent.

## What lives in `.architect/`

- `architecture.yaml`: components (ordered path globs, kind, owner, entrypoints), resources such as tables with their owning component, and settings.
- `rules.yaml`: checkable rules. Kinds are `forbid`, `allow-only`, `layers`, `acyclic`, `independent`, `entrypoints`, `external-imports`, `state-owner`, `api-stability`, and `deprecated`. Each error rule cites the decisions it comes from in `because`. Waivers need a reason and expire within 180 days.
- `decisions/NNNN-slug.md`: decisions in MADR 4.0 format, with front matter for status, what they govern, supersede, or weaken, assumptions with checks, and evidence quoted verbatim from the repo. Existing ADRs in `docs/adr` can be imported.
- `baseline.json`: fingerprints of accepted existing violations. Fingerprints ignore line numbers, so moving code doesn't churn them.

A rule looks like this:

```yaml
rules:
  - id: layering
    kind: layers
    layers:
      - [cli, mcp]
      - engine
      - [store, analysis, rules]
      - model
    because: ["0002"]
```

## How agents use it

`architect install --agent <name>` wires Architect into the agent:

- **Codex**: hooks in `.codex/hooks.json` and the MCP server in `.codex/config.toml`. If your Codex build ignores MCP servers in project config, the installer prints a snippet for your user config.
- **Claude Code**: hooks in `.claude/settings.json`, the MCP server in `.mcp.json`, and path-scoped rules in `.claude/rules/`.
- **Cursor**: `.cursor/rules/architect.mdc` and `.cursor/mcp.json` (no hooks).
- **All agents**: a short managed block in `AGENTS.md` and the Architect skill.

The hooks do the following:

- **Session start and prompt submit**: give the agent a short brief of the decisions and rules that govern the code it's about to touch.
- **After each edit**: check the changed files. A new error blocks with the rule, the reason, the decision behind it, and a fix hint. Warnings are added as context.
- **Stop**: check everything changed during the session once more before the agent finishes.

The MCP server offers `architect_context`, `architect_check`, `architect_diff`, and `architect_explain`, all read-only, and `architect_propose_decision`, which only writes decisions with status `proposed` and rejects evidence it can't find verbatim. Run `architect sync` after changing the contract to regenerate the agent files; `check` warns when they drift.

Hooks are guardrails. CI is the gate.

## CI

`architect ci --base <ref>` compares the pull request with its base. It reports new errors, rule weakenings that need human approval, fixed baseline entries, and coverage, and writes a SARIF report. Weakening a rule (removing it, lowering its level, narrowing a selector, adding a waiver, growing the baseline) fails unless an accepted decision lists the rule in `weakens`.

With GitHub Actions:

```yaml
name: architecture
on: pull_request
permissions:
  contents: read
  security-events: write   # SARIF upload
  actions: read            # needed on private repositories
jobs:
  architect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: SobshDev/architect@main
```

The action writes a Markdown summary to the job page and uploads SARIF to code scanning. Pull requests from forks get a read-only token, so they skip the upload.

## Commands

| Command | What it does |
|---|---|
| `init [--new]` | Map the current code into `.architect/` |
| `check [--all\|--changed] [--base <ref>]` | Check the code against the rules |
| `diff --base <ref>` | New findings, weakened rules, API changes, and fixed baseline entries since `<ref>` |
| `ci [--base <ref>]` | The diff as a CI gate, with a Markdown summary and SARIF |
| `graph [--format mermaid\|dot\|json]` | Print the component graph |
| `explain <rule:\|decision:\|component:><id>` | Explain a rule, decision, or component |
| `context [paths] [--task "..."]` | A brief for a task |
| `decision new\|lint\|list\|show` | Write and check decisions |
| `baseline update [--allow-grow]` | Rewrite the baseline (shrinks only by default) |
| `status` | Contract summary, baseline progress, and coverage |
| `install --agent codex\|claude\|cursor`, `sync` | Set up and refresh agent integrations |
| `schema` | JSON Schemas for the `.architect/` files |

`check` and `diff` accept `--format text|json|markdown|sarif`. Exit codes: 0 clean, 1 new errors or an unapproved weakening, 2 configuration or usage error.

## Limits in v0.1

- A post-edit block can't undo the edit; it tells the agent what to fix.
- Renaming a rule turns its baselined violations into new errors. Update the baseline in the same change.
- State-ownership checks (ORM and SQL writes) are heuristic and default to warn.
- Cursor gets rules and MCP only.

## License

MIT. Knowledge cards adapted from CC BY 4.0 sources live in `packs/cc-by/` under their own license; see `NOTICE`.
