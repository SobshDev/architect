---
id: coupling-at-short-distance
kind: principle
title: "Keep strong coupling at short distance"
summary: "Code that must change together lives in one component; components meet through narrow, stable interfaces."
problem: "When tightly coupled code sits in different components, teams, or deploy units, every change has to be coordinated across that distance and breaks easily."
forces:
  - "Sharing internal types across components is quick today."
  - "Putting everything in one component removes distance but loses structure."
  - "Distance comes from teams and deploy units as well as folders."
use_when:
  - "Deciding where new code goes."
  - "Two components keep changing in the same commits."
  - "A component reaches into another's internals for types or helpers."
avoid_when:
  - "The coupled code is volatile on both sides but owned by different teams for a recorded reason; then shrink and stabilize the interface instead of moving code."
tradeoffs:
  - "Moving code together may make one component larger."
  - "Narrow interfaces need data copied into plain values, which costs some duplication."
code_signals:
  - "finding:hidden-change-coupling"
  - "finding:new-component-edge"
  - "finding:propagation-cost-rise"
  - "rule-kind:entrypoints"
  - "rule-kind:independent"
  - "Imports of another component's internal files or types."
  - "Pull requests that routinely touch the same pair of components."
contract_templates:
  - |
    id: features-independent
    kind: independent
    members: [billing, catalog, shipping]
    because: ["0004"]
  - |
    id: feature-surfaces
    kind: entrypoints
    targets: [billing, catalog, shipping]
    because: ["0004"]
related: [history-before-restructuring, hide-volatile-decisions, unbalanced-coupling, hidden-change-coupling, scattered-functionality, modular-monolith]
sources:
  - title: "Balancing Coupling in Software Design (Khononov)"
    url: "https://www.informit.com/store/balancing-coupling-in-software-design-universal-design-9780137353521"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Your Code as a Crime Scene, Second Edition (Tornhill)"
    url: "https://pragprog.com/titles/atcrime2/your-code-as-a-crime-scene-second-edition/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Keep strong coupling at short distance

## Why

Khononov frames coupling by three things: how much knowledge is shared, how far apart the coupled parts are, and how often they change. Strong coupling is harmless inside one module, where one person changes both sides in one commit. It hurts across a long distance, where each change needs coordination between folders, teams, or releases. The aim is balance: strong coupling close together, weak and stable coupling far apart.

## In practice

1. Measure distance by component boundaries first, then teams (`owner` in `architecture.yaml`), then deploy units.
2. Look at what changes together. `architect context` lists change partners for the paths you touch; hidden change coupling findings show pairs that change together with no import between them.
3. When two components always change together, move the shared logic into one of them, or merge them.
4. When they must stay apart, put a narrow interface between them: plain data passed by value, a small function set at the entrypoint, or events. In Python, return dataclasses rather than ORM models; in TypeScript, export types from `index.ts`, not from internal files.
5. Encode the result. `entrypoints` keeps callers off internals. `independent` keeps sibling features from reaching into each other.
6. Watch `architect diff` for new component edges and rising propagation cost; each is a question for review.

## Checks

- Hidden change coupling between components is low, or each remaining pair is explained.
- Cross-component imports go through entrypoints.
- New component edges in a diff are deliberate and mentioned in the change.
- Propagation cost does not rise without a reason.
