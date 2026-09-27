---
status: accepted
date: 2026-09-26
decision-makers: [Gabriel Brument]
governs: [model, store, analysis, rules, knowledge, report, diff, context, integrations, engine, cli, mcp]
assumptions:
  - text: Modules in the same layer never need each other's internals.
    check: base-modules-independent
  - text: The MCP server runs the same engine flows as the CLI, so it never needs the CLI (decision 0008 lets the CLI start the server).
    check: mcp-never-imports-cli
evidence:
  - source: docs/plan/v0.1.md
    quote: "`src/cli` and `src/mcp`, which wire everything together."
  - source: AGENTS.md
    quote: "Modules in the same layer do not import each other."
---

# Layered modules with composition roots in cli and mcp

## Context and Problem Statement

Architect has two front doors, the CLI and the MCP server, and both need the same flows: load a workspace, build the graph, evaluate rules, compare with the baseline, format results. Where do those flows live so that neither front door depends on the other, and so that each module stays replaceable?

## Considered Options

* Five layers: entry points (cli, mcp) → engine → feature modules (diff, context, integrations) → base modules (store, analysis, rules, knowledge, report) → model
* Put the flows in the CLI and have the MCP server call CLI functions
* One flat module per command

## Decision Outcome

Chosen option: "Five layers", because the engine gives both entry points one implementation of every flow, and the base modules stay independent of each other and of I/O they do not own.

The approved plan listed cli and mcp directly above the modules. The engine layer is a refinement made during implementation: without it the MCP server would have to import the CLI.

### Consequences

* Good, because each module exposes one index.ts, so internals can change freely.
* Good, because base modules depend only on the model, which keeps them testable on plain data.
* Bad, because a flow that needs two base modules must live in the engine or a feature module, even when it is small.

### Confirmation

The rules layering, base-modules-independent, feature-modules-independent, entry-points-independent, no-cycles, public-surfaces, and model-is-pure enforce this decision.
