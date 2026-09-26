---
status: accepted
date: 2026-09-26
decision-makers: [Gabriel Brument]
governs: ["*"]
assumptions:
  - text: Host agents (Codex, Claude Code, Cursor) can do the reasoning Architect needs through its CLI, MCP tools, hooks, and skill.
    review_by: 2027-03-01
evidence:
  - source: docs/plan/v0.1.md
    quote: "Architect itself makes no model API calls."
---

# Deterministic core without model calls

## Context and Problem Statement

Architect decides whether a change passes CI. If that decision depended on a model call, the same commit could pass on one run and fail on the next, and every check would cost money and need credentials.

## Considered Options

* Deterministic checks; the host agent reasons with Architect's outputs
* Call a model inside Architect to extract decisions and judge changes
* Offer optional model calls behind a flag

## Decision Outcome

Chosen option: "Deterministic checks", because pass or fail must be reproducible, offline, and free to run in CI and in hooks.

### Consequences

* Good, because every finding can be reproduced from the repository alone.
* Good, because repository text never reaches a model through Architect, so it cannot inject instructions into a judgment.
* Bad, because recovering decisions from an existing repo relies on the host agent following the skill, and those decisions stay proposed until a person accepts them.

### Confirmation

The rule no-model-calls forbids model SDK imports everywhere.
