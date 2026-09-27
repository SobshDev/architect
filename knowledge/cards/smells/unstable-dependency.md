---
id: unstable-dependency
kind: smell
title: "Unstable dependency"
summary: "A stable component, one that many others rely on, depends on a component that is less stable than itself."
problem: "Stable code is hard to change because many callers depend on it. When it depends on code that changes easily and often, the volatile part drags the stable part along, and the change reaches every caller of the stable part."
forces:
  - "The volatile component already has the function the stable one needs."
  - "Martin's instability metric, fan-out divided by fan-in plus fan-out, is a rough proxy for how often code actually changes."
  - "Adding an abstraction in the stable component costs some indirection."
use_when:
  - "The depended-on component also shows up as a hotspot."
  - "The edge is new in the current change."
  - "The stable side is a domain or library component used across the system."
avoid_when:
  - "The less stable side rarely changes in practice, such as a thin wrapper over a standard library."
  - "The instability gap is small and both components are owned and released together."
tradeoffs:
  - "Inverting the edge adds an interface in the stable component."
  - "The metric counts edges, not change frequency; history may tell a different story."
code_signals:
  - "finding:unstable-dependency"
  - "A widely imported component imports a feature or adapter component."
  - "The depended-on component has many outgoing imports and few incoming ones."
  - "Changes in a small feature regularly force edits in a shared component."
contract_templates:
  - |
    id: stable-at-the-bottom
    kind: layers
    level: warn
    description: Volatile components sit above stable ones, so dependencies point toward stability.
    layers:
      - [web, api]
      - [checkout, search]
      - domain
  - |
    id: domain-not-features
    kind: forbid
    level: warn
    description: The stable domain never imports a volatile feature.
    from: [domain]
    to: [checkout, search, web]
related: [directed-acyclic-dependencies, zone-of-pain, layer-violation, hide-volatile-decisions, hotspot]
sources:
  - title: "Clean Architecture (Robert C. Martin)"
    url: "https://www.oreilly.com/library/view/clean-architecture-a/9780134494272/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Arcan: A Tool for Architectural Smells Detection (Fontana et al., 2017)"
    url: "https://doi.org/10.1109/ICSAW.2017.16"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Unstable dependency

## Symptoms

A component that many others import, such as `domain` or a shared library, imports something with few dependents and many dependencies of its own, such as a feature, a UI module, or an adapter. In the graph, the arrow runs from a box with many incoming edges to a box with many outgoing edges. In history, edits in the volatile component are followed by edits in the stable one.

## Why it hurts

Stability here means "hard to change without breaking others". A stable component should depend only on things at least as stable, or its callers inherit volatility they never asked for. Each release of the volatile component risks breaking the stable one, and through it every caller. Teams then freeze the volatile code to protect the stable code, and it stops being able to change at the pace its own purpose needs.

## How to fix

1. Look at what the stable component uses from the volatile one. Often it is a single type, constant, or function.
2. Move data types and pure helpers down into the stable component or into the model.
3. For behavior, invert the dependency: the stable side declares an interface and the volatile side implements it.

~~~ts
// domain/index.ts
export interface SearchIndex { reindex(productId: string): Promise<void> }
// search/ implements SearchIndex; domain no longer imports search
~~~

4. If the edge is correct and the "volatile" component never changes, leave it and record why in a decision.

## Architect signals

Architect computes instability for each component and reports `unstable-dependency` when an edge points at a component whose instability is more than 0.25 higher. It is informational; see it with `architect check --verbose`, and compare it with `hotspot` findings to confirm the target changes often. A `layers` rule that puts volatile components above stable ones, plus a `forbid` rule for the worst edges, keeps the direction from slipping back.
