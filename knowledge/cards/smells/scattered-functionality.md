---
id: scattered-functionality
kind: smell
title: "Scattered functionality"
summary: "One concern, such as pricing or permission checks, is implemented in pieces across several components, so no single component owns it."
problem: "When a concern has no home, every change to it becomes a hunt across the codebase, and the copies drift apart until they disagree."
forces:
  - "Putting a small check where it is needed is faster than finding or building its owner."
  - "Each component team sees only its own piece, so the whole concern stays invisible."
  - "Moving the logic into one owner forces other components to depend on it."
use_when:
  - "The same rule has already been fixed in one place and missed in another."
  - "A routine change to the concern keeps touching three or more components."
  - "Two copies of the logic now return different answers for the same input."
avoid_when:
  - "The pieces only look alike and change for different reasons; merging them would couple unrelated rules."
  - "The concern is cross-cutting infrastructure, such as logging, that is meant to be called from everywhere through one small library."
tradeoffs:
  - "One owner gives one place to change and test the rule."
  - "Callers gain a dependency on the owner, which must then keep a stable interface."
  - "Gathering the pieces takes a migration, during which old and new code coexist."
code_signals:
  - "finding:hidden-change-coupling"
  - "The same constant, formula, or regular expression appears in several components."
  - "Feature commits for one concern touch files in many components at once."
  - "Several components import the same vendor SDK for the same purpose."
contract_templates:
  - |
    id: payments-sdk-in-billing
    kind: external-imports
    level: warn
    description: Only billing talks to the payment provider.
    packages: [stripe]
    allow_from: [billing]
related: [hidden-change-coupling, hide-volatile-decisions, single-state-owner, god-component, modular-monolith]
sources:
  - title: "Identifying Architectural Bad Smells (Garcia, Popescu, Edwards, Medvidovic, CSMR 2009)"
    url: "https://doi.org/10.1109/CSMR.2009.59"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "On the Criteria To Be Used in Decomposing Systems into Modules (Parnas, 1972)"
    url: "https://doi.org/10.1145/361598.361623"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Scattered functionality

## Symptoms

A discount rule lives partly in the checkout handler, partly in the invoice builder, and partly in a SQL view. Each piece is small and looks reasonable where it sits. The trouble shows in history: every pricing change is a commit that edits files in four components, and review comments ask "did you also update the other place?" Search for a tax rate or a role name and you find it in several folders, sometimes with different values.

## Why it hurts

A change to the concern has to find every piece, and nothing tells the author when one was missed. The miss is usually silent: the web shows one price and the invoice another. Tests are scattered too, so no suite covers the rule as a whole. Review load rises because each reviewer knows only one piece. Over time the copies drift, and deciding which copy is correct becomes its own project.

## How to fix

1. List every place the concern lives. Search by the constants and names, then check commits that touched the concern.
2. Pick one owner component, usually the one whose business meaning is closest.
3. Add one function there that answers the question, and move callers to it one at a time. Keep the old pieces until the last caller moves.

~~~ts
// billing/index.ts
export function discountFor(order: Order): Money { /* the only copy of the rule */ }

// checkout/submit.ts
import { discountFor } from "../billing/index.ts";
const total = subtotal.minus(discountFor(order));
~~~

4. Delete the old copies and their tests once they have no callers.

## Architect signals

Hidden change coupling findings list component pairs that change together without importing each other; several pairs that share one component often point at a scattered concern. Once the concern has an owner, keep it there. An external-imports rule limits a vendor SDK to one component, and a state-owner rule names the one component allowed to write the concern's data. Record the choice of owner as a decision so the next contributor finds it with `architect context`.
