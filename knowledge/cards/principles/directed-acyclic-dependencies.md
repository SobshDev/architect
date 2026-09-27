---
id: directed-acyclic-dependencies
kind: principle
title: "Allow no cycles and no edges against the declared direction"
summary: "Dependencies form a directed acyclic graph that follows the declared layers; when a lower layer needs a higher one, invert the dependency with an interface the lower layer owns."
problem: "Cycles and upward edges tie components together so that none can be changed, tested, built, or released alone, and change order stops being predictable."
forces:
  - "An upward import is often the shortest path to a working feature."
  - "Inverting a dependency adds an interface and some wiring."
  - "Type-only imports can hide real design coupling."
use_when:
  - "Adding an import between components."
  - "Setting up the main layering of a system."
  - "A test needs to load half the system to exercise one module."
avoid_when:
  - "The files are inside one small component where file-level cycles carry no design cost; even then prefer a warn rule over none."
tradeoffs:
  - "Interfaces owned by lower layers add indirection."
  - "Strict layering (no skipping) is clearer but produces pass-through code."
code_signals:
  - "rule-kind:acyclic"
  - "rule-kind:layers"
  - "rule-kind:forbid"
  - "rule-kind:allow-only"
  - "finding:new-cycle"
  - "finding:unstable-dependency"
  - "finding:new-component-edge"
  - "Domain code importing HTTP, database, or UI modules."
  - "Import statements placed inside functions to dodge circular import errors in Python."
contract_templates:
  - |
    id: layering
    kind: layers
    layers:
      - api
      - [billing, catalog]
      - domain
    because: ["0002"]
  - |
    id: no-cycles
    kind: acyclic
    because: ["0002"]
  - |
    id: domain-not-infra
    kind: forbid
    from: [domain]
    to: [infra, "pkg:pg"]
    because: ["0003"]
related: [hide-volatile-decisions, cyclic-dependency, layer-violation, unstable-dependency, zone-of-pain, ports-and-adapters]
sources:
  - title: "On the Criteria To Be Used in Decomposing Systems into Modules (Parnas, 1972)"
    url: "https://doi.org/10.1145/361598.361623"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Building Evolutionary Architectures, 2nd Edition (Ford, Parsons, Kua, Sadalage)"
    url: "https://www.oreilly.com/library/view/building-evolutionary-architectures/9781492097532/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Allow no cycles and no edges against the declared direction

## Why

Parnas described a "uses" hierarchy: if modules use each other only downward, you can build, test, and ship useful subsets of the system. A cycle removes that. Two components in a cycle act as one, but without the cohesion of one. An edge against the declared direction does the same more slowly: stable, general code starts to depend on volatile, specific code, and every change at the top shakes the bottom.

## In practice

1. Declare the direction once as a `layers` rule, highest layer first, and add `acyclic` for the whole graph.
2. Add `forbid` for specific bans, such as domain importing infrastructure or a database driver, and `allow-only` for a core that must stay small.
3. When a lower layer needs something from a higher one, invert it. Define the interface in the lower layer, such as a `PaymentGateway` type in `src/domain/` or a `typing.Protocol` in `domain/ports.py`, and implement it in the higher layer. Wire them together at the composition root.
4. Break an existing cycle by moving the shared piece down, or by splitting out the part both sides need.
5. Do not hide cycles with dynamic or function-local imports. Architect's rules include type-only imports by default because they carry design coupling too.
6. Run `architect check --changed` during work and `architect diff --base <main>` before finishing; new cycles and new edges show there.

## Checks

- `architect check --all` reports no cycles or layer violations outside the baseline.
- The baseline for these rules only shrinks.
- Unstable dependency findings point at edges you can explain.
