---
id: cyclic-dependency
kind: smell
title: "Cyclic dependency between components"
summary: "Two or more components depend on each other, directly or through a chain, so none of them can be understood, tested, or released alone."
problem: "A cycle fuses its members into one unit without giving them the cohesion of one unit. A change anywhere in the loop can ripple to every member, and build and load order stop being predictable."
forces:
  - "Calling back into the component that called you is often the quickest way to finish a feature."
  - "Breaking a cycle needs a new interface, a moved type, or a split module."
  - "Type-only imports look harmless but still tie the design together."
use_when:
  - "The cycle crosses component boundaries declared in architecture.yaml."
  - "A test for one component has to load the other members of the loop."
  - "Python code already moves imports into functions to avoid circular import errors."
  - "A new cycle appears in a diff; it is cheapest to break before it grows."
avoid_when:
  - "The cycle is between a few files inside one small, cohesive component; a warn-level file cycle rule is enough there."
  - "The loop is the deliberate two-way link between a type and its tightly bound helper in the same module."
tradeoffs:
  - "Inverting a dependency adds an interface and some wiring at the composition root."
  - "Merging the members removes the cycle but produces a larger component."
code_signals:
  - "rule-kind:acyclic"
  - "finding:new-cycle"
  - "Component A imports B and B imports A, or the loop runs through a third component."
  - "Imports placed inside functions, or lazy require calls, to dodge load order errors."
  - "The Mermaid graph from architect graph shows arrows going both ways between two boxes."
contract_templates:
  - |
    id: no-component-cycles
    kind: acyclic
    level: warn
    description: The component graph has no cycles.
  - |
    id: no-file-cycles-in-domain
    kind: acyclic
    level: warn
    description: Files inside the domain do not import each other in a loop.
    scope: files
    within: [domain]
related: [directed-acyclic-dependencies, layer-violation, ports-and-adapters, hub-component]
sources:
  - title: "On the Criteria To Be Used in Decomposing Systems into Modules (Parnas, 1972)"
    url: "https://doi.org/10.1145/361598.361623"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
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

# Cyclic dependency between components

## Symptoms

The component graph has arrows in both directions between two boxes, or a loop through three or more. In code, `billing` imports a helper from `orders` while `orders` imports a price type from `billing`. Python files import inside functions to avoid "partially initialized module" errors. A test for one module starts the whole loop. In history, the members of the loop tend to change in the same commits.

## Why it hurts

Members of a cycle cannot be built, tested, or released on their own. A change in one can reach every other member, so reviewers must think about the whole loop. Refactoring gets harder because no member has a clear bottom to start from. Load order bugs show up at runtime: a value is `undefined` because its module has not finished loading.

## How to fix

Start with the edge that is easiest to cut.

1. If one side only needs a type or a constant, move it down into a component both sides may use.
2. If the lower component needs to call the higher one, invert the dependency. Let the lower side own an interface and let the higher side implement it:

~~~ts
// orders/ports.ts, owned by orders
export interface PriceLookup { priceOf(sku: string): number }

// billing/price-lookup.ts implements it and is passed in at startup
~~~

3. If both sides share a large piece of logic, split it into its own component.
4. If the two components are really one, merge them and say so in a decision.

Do not hide the loop with dynamic imports; the design coupling stays.

## Architect signals

An `acyclic` rule reports every cycle in the component graph, and `scope: files` with `within` checks file loops inside one component. `architect diff --base main` reports `new-cycle` for loops that the change introduced. Run `architect graph` to see the loop. Once the cycle is gone, keep the `acyclic` rule and let the baseline shrink so the loop cannot return unnoticed.
