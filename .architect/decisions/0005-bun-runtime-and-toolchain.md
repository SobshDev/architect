---
status: accepted
date: 2026-09-26
decision-makers: [Gabriel Brument]
governs: ["*"]
evidence:
  - source: docs/plan/v0.1.md
    quote: "One Bun package, MIT license, `packageManager: bun@1.3.14`, strict TypeScript."
---

# Bun as runtime and toolchain

## Context and Problem Statement

Architect runs inside agent hooks, where startup time matters, and ships as both an npm package and standalone binaries.

## Considered Options

* Bun for runtime, tests, and compiled binaries
* Node.js with a separate bundler and test runner

## Decision Outcome

Chosen option: "Bun", because it runs TypeScript directly, starts fast enough for hooks (a compiled binary runs a full parse in about 80 ms), compiles single-file binaries with embedded wasm, and matches the maintainer's other projects.

### Consequences

* Good, because one tool covers install, test, run, and build.
* Bad, because the npm package needs Bun on the user's machine; the compiled binaries cover everyone else.
