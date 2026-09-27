---
id: strangler-fig
kind: pattern
title: Strangler fig migration
summary: Replace a legacy system gradually by routing one slice of behavior at a time to new code until the old system can be removed.
problem: >-
  Rewriting a large system in one release is risky and delivers nothing until the end. Yet
  leaving the legacy system in place blocks change.
forces:
  - The business needs the system to keep working during the migration.
  - Each migrated slice should ship and prove itself on its own.
  - Old and new code will coexist for months or years.
  - New code is tempted to call back into the legacy code it is replacing.
use_when:
  - A legacy system is too large or too risky to replace at once.
  - Requests or calls can be intercepted and routed per feature or per route.
  - The team can keep both systems running during the transition.
avoid_when:
  - The system is small enough to replace in one short step.
  - Requests cannot be split, so there is no seam to route through.
tradeoffs:
  - Delivers value early and lowers the risk of each step.
  - Running two systems costs effort, and the routing layer adds a moving part.
  - Migrations that stall leave both systems in place indefinitely.
code_signals:
  - rule-kind:deprecated
  - finding:deprecated-dependency
  - rule-kind:forbid
  - A routing layer or facade that sends some requests to new code and some to old code.
  - Components or directories named legacy, v1, or old that receive fewer changes over time.
  - Feature flags that select between old and new implementations.
contract_templates:
  - |
    id: legacy-gains-no-dependents
    kind: deprecated
    level: warn
    description: No new code may start depending on the legacy component.
    components: [legacy]
  - |
    id: new-code-not-to-legacy
    kind: forbid
    level: warn
    description: Replacement code reaches legacy behavior only through the facade.
    from: [app]
    to: [legacy]
related:
  - anti-corruption-layer
  - history-before-restructuring
  - superseded-dependency
  - modular-monolith
sources:
  - title: "StranglerFigApplication (Martin Fowler)"
    url: https://martinfowler.com/bliki/StranglerFigApplication.html
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Azure Architecture Center: Strangler Fig pattern"
    url: https://learn.microsoft.com/en-us/azure/architecture/patterns/strangler-fig
    retrieved: "2026-09-26"
    license: CC-BY-4.0
    relation: see-also
---

## Context

A legacy system runs the business. It is hard to change and hard to understand. A full rewrite would take a long time, freeze features, and fail in ways nobody can predict until launch.

## Solution

Put a facade in front of the legacy system that decides, per request or per feature, where to send the work. Move one slice at a time: build it in new code, route its traffic there, watch it, then remove the old path. Repeat until nothing routes to the legacy system, then delete it.

~~~ts
export function handle(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path.startsWith("/invoices")) return invoices.handle(req); // migrated
  return legacy.handle(req); // everything else, for now
}
~~~

Choose slices by value and by risk. History helps: files that change often and hurt the most are good early candidates.

## Consequences

Each step is small and reversible. The business keeps a working system throughout. The cost is running two systems and a router, and keeping data consistent between them. The main danger is a migration that stops halfway and never finishes.

## In Architect

Mark the legacy component as deprecated in architecture.yaml, with a reason and a replacement. A deprecated rule then reports any new dependent, so the old system can only shrink. A forbid rule keeps new components from calling legacy code directly. Record the migration plan and the order of slices in a decision, and supersede it when the plan changes.
