---
id: hub-component
kind: smell
title: "Hub component"
summary: "One component has many dependents and many dependencies at once, so changes flow into it from everywhere and out of it to everywhere."
problem: "A hub sits on most paths through the dependency graph. Any change to one of its many dependencies can pass through it to its many dependents, which makes the whole system behave like one tightly coupled unit."
forces:
  - "A central place for shared logic is convenient, and each new edge seems small."
  - "Splitting a hub touches many callers at once."
  - "Some central components are meant to be widely used."
use_when:
  - "The hub also shows up as a hotspot or in hidden change coupling."
  - "Its outgoing edges keep growing, especially toward feature components."
  - "Tests for unrelated features fail together when the hub changes."
avoid_when:
  - "It is a deliberately stable shared kernel with few outgoing edges that rarely changes; that has high fan-in but is not a hub."
  - "The system is small enough that a handful of edges crosses the threshold."
tradeoffs:
  - "Splitting a hub adds components and entry points to maintain."
  - "Pushing dependencies out through interfaces adds indirection."
code_signals:
  - "finding:hub-component"
  - "A module named core, common, or app that both imports and is imported by most others."
  - "One file imports from five components and is imported by five more."
  - "The hub appears in most commits that touch more than one component."
contract_templates:
  - |
    id: kernel-depends-on-little
    kind: allow-only
    level: warn
    description: The shared kernel may depend only on the model, so it cannot turn into a hub.
    from: [kernel]
    to: [model]
  - |
    id: features-independent
    kind: independent
    level: warn
    description: The pieces split out of the old hub do not import each other.
    members: [pricing, accounts, notifications]
related: [god-component, unstable-dependency, rising-propagation-cost, coupling-at-short-distance, hotspot]
sources:
  - title: "Arcan: A Tool for Architectural Smells Detection (Fontana et al., 2017)"
    url: "https://doi.org/10.1109/ICSAW.2017.16"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Exploring the Structure of Complex Software Designs (MacCormack, Rusnak, Baldwin, 2006)"
    url: "https://doi.org/10.1287/mnsc.1060.0552"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Hub component

## Symptoms

In the component graph, one box has many arrows coming in and many going out. It often has a generic name such as `core`, `common`, or `services`. It imports feature code to reach data it needs, and the same features import it for helpers. In history it appears in a large share of commits that span several components, and its tests break when unrelated features change.

## Why it hurts

Dependencies are transitive. A change in anything the hub imports can reach everything that imports the hub. That raises the cost of each change: more code to rebuild, more tests to run, more people to ask for review. The hub also attracts more code, because it can already see everything. Over time most edits pass through it, and it becomes a bottleneck for both builds and people.

## How to fix

Reduce the outgoing edges first; they are what make a widely used component dangerous.

1. List the hub's outgoing edges. For each one that points at a feature component, ask why the hub needs it. Often it is one function or type.
2. Move that code into the feature, or invert the dependency with an interface the hub owns and the feature implements.
3. Split what remains by reason for change. Pure types and helpers form a small kernel that depends on nothing. Workflow code that combines features moves up into its own component near the entry points.
4. Move callers one at a time, through entry points.

~~~ts
// before: core imports billing, catalog, users, and everyone imports core
// after: kernel imports nothing; checkout imports billing and catalog
~~~

## Architect signals

Architect reports `hub-component` when a component's fan-in and fan-out both reach about 30 percent of the other components, with a minimum of three. It is informational; see it with `architect check --verbose`. Check `architect graph` for the edges and look for the same component in hotspot and change coupling findings. After a split, an `allow-only` rule on the kernel and an `independent` rule on the new pieces keep the hub from forming again.
