---
id: modular-monolith
kind: pattern
title: Modular monolith
summary: Build one deployable application out of modules with explicit boundaries, public entrypoints, and owned data.
problem: >-
  A monolith without internal boundaries turns into a tangle where every change touches
  everything. Splitting into microservices to fix this adds network, deployment, and data costs
  that many teams do not need.
forces:
  - A single deployment is simpler to build, test, and operate.
  - Teams need to change one area without learning all the others.
  - Boundaries inside one process are easy to cross by accident.
  - Good module boundaries are hard to find up front and need to move.
use_when:
  - One team or a few teams share a product and do not need independent deployment.
  - Domain boundaries are still being discovered.
  - The team wants the option to extract services later.
avoid_when:
  - Parts of the system need very different scaling, runtimes, or release cycles.
  - The organization already runs independent teams with separate deployments.
tradeoffs:
  - Keeps in-process calls and one deployment while gaining clear ownership.
  - Boundaries hold only if they are checked; the compiler does not enforce them.
  - Shared database access makes data ownership easy to violate.
code_signals:
  - rule-kind:entrypoints
  - rule-kind:independent
  - rule-kind:acyclic
  - rule-kind:state-owner
  - finding:new-cycle
  - finding:new-component-edge
  - finding:hidden-change-coupling
  - Modules importing each other's internal files instead of their index.
  - Tables written by more than one module.
contract_templates:
  - |
    id: modules-through-entrypoints
    kind: entrypoints
    level: warn
    description: Modules use each other only through their index files.
    targets: [billing, catalog, orders]
  - |
    id: modules-acyclic
    kind: acyclic
    level: warn
    description: Module dependencies form a directed acyclic graph.
    within: [billing, catalog, orders]
  - |
    id: module-owns-its-tables
    kind: state-owner
    level: warn
    description: Each table is written by the module that owns it.
related:
  - deep-modules
  - directed-acyclic-dependencies
  - single-state-owner
  - boundary-bypass
  - strangler-fig
sources:
  - title: "MonolithFirst (Martin Fowler)"
    url: https://martinfowler.com/bliki/MonolithFirst.html
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Deconstructing the Monolith: Designing Software that Maximizes Developer Productivity (Shopify Engineering)"
    url: https://shopify.engineering/deconstructing-monolith-designing-software-maximizes-developer-productivity
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

## Context

A product runs as one application. It is easy to deploy, but it has grown without internal structure. Any file can import any other, and any code can write any table. Changes ripple in ways nobody predicts.

## Solution

Divide the application into modules along business lines. Each module has a public entrypoint, keeps the rest of its files private, and owns its data. Modules depend on each other in one direction, so the graph has no cycles. When two modules need to react to each other, use an event or a port instead of a back edge.

~~~
src/
  billing/index.ts   public API
  billing/internal/  private
  catalog/index.ts
  orders/index.ts    imports billing and catalog through index.ts only
~~~

Keep the boundaries checked in continuous integration. In one process, nothing else stops a shortcut.

## Consequences

Teams can work on one module with little knowledge of the others. The system keeps the simple operations of a single deployment. If a module later needs its own scaling or release cycle, a clean boundary makes extraction a smaller job. The discipline has a cost: some calls that would be one line become a trip through an entrypoint, and moving a boundary means a deliberate change.

## In Architect

Declare each module as a component with entrypoints. An entrypoints rule stops imports of another module's internal files. An acyclic rule keeps the module graph directed. Declare tables as resources and use a state-owner rule so each is written by one module. Watch for hidden change coupling between modules: files that always change together across a boundary suggest the boundary is in the wrong place. Record each boundary in a decision.
