---
status: accepted
date: 2026-09-26
decision-makers: [Gabriel Brument]
governs: [analysis, mcp]
assumptions:
  - text: TypeScript 6.0 keeps resolving modern tsconfig and package exports setups well enough for analysis.
    review_by: 2027-03-01
evidence:
  - source: docs/plan/v0.1.md
    quote: "Only `src/analysis/typescript` may import `typescript`; only `src/mcp` may import MCP packages."
  - source: docs/plan/v0.1.md
    quote: "TypeScript 7 has no stable JavaScript API, so the analyzer pins the newest release below 7.0 behind an interface."
---

# Isolate parsers and protocol SDKs behind adapters

## Context and Problem Statement

Three dependencies are likely to change under us: the TypeScript compiler (7.0 is a native rewrite without a stable JavaScript API), tree-sitter, and the MCP SDK (v2 changed its package layout and protocol era). How do we keep a change in one of them from spreading through the code?

## Considered Options

* Confine each library to one folder behind Architect's own interfaces
* Use the libraries wherever convenient

## Decision Outcome

Chosen option: "Confine each library to one folder", because a future swap (TypeScript 7's API, a different Python parser, an MCP SDK upgrade) then touches one folder.

TypeScript is pinned to 6.0.3, the newest release below 7.0, and used only as a parser and module resolver.

### Consequences

* Good, because the analyzers expose plain FileFacts and edges, so rules never see compiler types.
* Bad, because some compiler features (type information) stay out of reach without building a Program.

### Confirmation

The rules typescript-only-in-analysis, tree-sitter-only-in-analysis, and mcp-sdk-only-in-mcp enforce this decision.
