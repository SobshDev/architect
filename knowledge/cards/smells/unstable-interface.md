---
id: unstable-interface
kind: smell
title: "Unstable interface"
summary: "A widely used interface changes often, so each change drags edits into every component that depends on it."
problem: "When the exports many components rely on keep changing, the cost of each change is multiplied by the number of dependents."
forces:
  - "An interface designed early rarely fits the needs that appear later."
  - "Changing the interface is often simpler than adapting behind it."
  - "Stabilizing an interface means designing for callers you do not see yet."
use_when:
  - "The interface has many dependents across components or teams."
  - "Most changes to the interface come with edits in its dependents."
  - "The interface changes for reasons that belong to its implementation."
avoid_when:
  - "The interface is new and has one or two callers; let it settle first."
  - "All dependents live in the same small component and change in the same commit."
tradeoffs:
  - "A stable interface lets dependents ignore most changes behind it."
  - "Designing for stability takes more thought up front and may need a wider type."
  - "Freezing an interface too early locks in a poor design."
code_signals:
  - "rule-kind:api-stability"
  - "rule-kind:entrypoints"
  - "finding:hotspot"
  - "An index file whose exports appear in a large share of commits."
  - "Function signatures that grow a new optional parameter every few weeks."
  - "Exported types that mirror database columns or vendor payloads."
contract_templates:
  - |
    id: domain-api-stable
    kind: api-stability
    level: warn
    description: Breaks in the domain's public exports are reported in diff.
    components: [domain]
  - |
    id: domain-entrypoint
    kind: entrypoints
    level: warn
    description: Other components use the domain only through its index.
    targets: [domain]
related: [public-api-break-or-growth, deep-modules, hide-volatile-decisions, behavior-is-a-promise, hotspot]
sources:
  - title: "Hotspot Patterns: The Formal Definition and Automatic Detection of Architecture Smells (Mo, Cai, Kazman, Xiao, WICSA 2015)"
    url: "https://doi.org/10.1109/WICSA.2015.12"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Hyrum's Law"
    url: "https://www.hyrumslaw.com/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "A Philosophy of Software Design (Ousterhout)"
    url: "https://web.stanford.edu/~ouster/cgi-bin/aposd.php"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Unstable interface

## Symptoms

`domain/index.ts` appears in a large share of recent commits, and most of those commits also edit files in other components. Its exported types copy the shape of a database row, so every schema migration changes them. A function has gained a sixth optional flag. Dependents carry adapters and casts to cope with each version.

## Why it hurts

Each change to a shared interface is paid once per dependent. With twenty callers, a rename is twenty edits, twenty reviews, and twenty chances to get it wrong. Callers in other teams learn to fear upgrades and pin old versions. Worse, an interface that changes whenever its internals change is not hiding anything: the implementation leaks through it, so callers depend on details and break on changes that should have been private.

## How to fix

1. Find why it changes. Read recent changes to the interface and sort them: new needs from callers, or internal details leaking out.
2. Stop the leaks first. Replace exported storage or vendor types with types shaped for callers, and map inside the module.
3. Replace growing flag lists with one options object or separate, well named functions.

~~~ts
// before: find(id, withItems?, withCustomer?, includeDeleted?)
export interface FindOptions { include?: ("items" | "customer")[] }
export function findOrder(id: string, options: FindOptions = {}): Promise<Order> { /* ... */ }
~~~

4. For a needed change, add the new form next to the old one, move callers, then remove the old form.

## Architect signals

An api-stability rule makes `architect diff` report removed or changed exports at the component's entrypoints, and an entrypoints rule makes sure callers use only those files. A hotspot finding on an entrypoint file is a strong hint. When a break is intended, record a decision that lists the rule in `weakens`; the diff then reports the break as waived and names that decision.
