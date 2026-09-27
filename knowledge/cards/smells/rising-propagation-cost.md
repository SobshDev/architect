---
id: rising-propagation-cost
kind: smell
title: "Rising propagation cost"
summary: "Each change adds dependencies that make more components reachable from each other, so a change anywhere can affect a growing share of the system."
problem: "Propagation cost measures how much of the system a change can reach through dependencies; when it climbs release after release, the system is losing its modularity even if no single edge looks wrong."
forces:
  - "Every new import is locally reasonable."
  - "A single edge into a well-connected component can connect whole regions of the graph."
  - "The metric describes the whole graph, so no one pull request feels responsible for it."
use_when:
  - "A diff reports a rise and the new edges point into or out of a hub."
  - "Build times, test suites, or review scope are growing faster than the code."
  - "The rise comes with a new cycle."
avoid_when:
  - "The rise is small and comes from a new component that joins the graph with expected edges."
  - "A planned merge of two components raises the number on purpose; record it in a decision."
tradeoffs:
  - "Cutting reachability often needs an interface or an event where a direct call was simpler."
  - "A lower number is not a goal by itself; a few well-placed hubs are fine."
code_signals:
  - "finding:propagation-cost-rise"
  - "A new import from a low-level component to a high-level one."
  - "A component that gains dependents and dependencies in the same change."
  - "Test runs for one module that load most of the codebase."
contract_templates:
  - |
    id: no-cycles
    kind: acyclic
    level: warn
    description: Cycles make every member reach every other member, which raises propagation cost.
  - |
    id: features-independent
    kind: independent
    level: warn
    description: Feature components do not import each other, so a change in one does not reach the others.
    members: [billing, catalog, search]
related: [directed-acyclic-dependencies, hub-component, cyclic-dependency, coupling-at-short-distance]
sources:
  - title: "Exploring the Structure of Complex Software Designs (MacCormack, Rusnak, Baldwin, 2006)"
    url: "https://doi.org/10.1287/mnsc.1060.0552"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Balancing Coupling in Software Design (Khononov)"
    url: "https://www.informit.com/store/balancing-coupling-in-software-design-universal-design-9780137353521"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Rising propagation cost

## Symptoms

Propagation cost is the share of component pairs where one can reach the other through a chain of dependencies. A value of 0.2 means a change in a typical component can reach a fifth of the system. The smell is the trend: the number climbs from 0.15 to 0.35 over a few months while no single pull request looks alarming. Often one change adds an edge from a shared low-level component back up to a feature, and suddenly every feature reaches every other.

## Why it hurts

Reachability is the upper bound on what a change can break. As it grows, more tests have to run, more code has to be read in review, and more teams need to hear about a change. Incremental builds rebuild more. Releases get bundled because nothing can ship alone. The cost arrives slowly, so teams notice it as general slowness rather than as a design problem.

## How to fix

1. Find the edges that caused the rise. Read the new component edges in the same diff, or compare `architect graph` at base and head.
2. If a new edge closes a cycle, break it first. Move the shared piece down, or invert the call with an interface the lower component owns.
3. If a feature started importing another feature, route the shared need through a lower component or an event.
4. If the edge runs into a hub, check whether the caller needs the whole hub or one small part that could move.
5. Add a rule so the edge cannot return: `acyclic`, `independent` for peer features, or `layers`.

## Architect signals

`architect diff --base <main>` computes propagation cost on the component graph at both refs and reports `propagation-cost-rise` when it grows by more than 0.02. The finding is informational and never fails a build. Read it together with the `new-component-edge` and `new-cycle` findings from the same diff, which name the edges to look at. Structural rules keep the fix in place.
