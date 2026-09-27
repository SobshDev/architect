---
id: state-ownership-drift
kind: smell
title: "State ownership drift"
summary: "State that once had one writer slowly gains writers in other components, one small shortcut at a time."
problem: "Ownership of state is usually decided early and then left implicit, so each feature that needs a quick write adds another writer, and the owner's invariants stop being the whole truth."
forces:
  - "Each new writer looks harmless in its own pull request."
  - "The owning component may be slow to change or owned by another team."
  - "Write access to the database is the same everywhere, so the drift leaves no trace in imports."
use_when:
  - "A resource has a declared owner and a new foreign write appears in a diff."
  - "The owner's invariants were broken by data it did not write."
  - "A migration is planned and the list of writers is unknown."
avoid_when:
  - "Ownership is moving on purpose; record that with a decision and update the resource owner instead."
  - "The new write is in a test fixture or seed script that runs outside production."
tradeoffs:
  - "Catching drift early is cheap; unwinding five writers later is not."
  - "Declaring owners for every resource takes effort; start with the state that has real invariants."
code_signals:
  - "rule-kind:state-owner"
  - "A pull request adds an insert or update call for a table that belongs to another component."
  - "The owner's write API exists but a caller bypasses it for one field."
  - "A resource in architecture.yaml whose owner no longer matches who writes it."
contract_templates:
  - |
    id: state-has-one-writer
    kind: state-owner
    level: warn
    description: Every declared resource is written only by its owner.
related: [shared-mutable-state, single-state-owner, loosening-needs-a-decision, boundary-bypass]
sources:
  - title: "Domain-Driven Design (Evans)"
    url: "https://www.informit.com/store/domain-driven-design-tackling-complexity-in-the-heart-9780321125217"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Building Evolutionary Architectures, 2nd Edition (Ford, Parsons, Kua, Sadalage)"
    url: "https://www.oreilly.com/library/view/building-evolutionary-architectures/9781492097532/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# State ownership drift

## Symptoms

The billing component was meant to be the only writer of `invoices`. A year later the support tool sets `invoices.refunded`, a report job fixes rounding in place, and a webhook handler marks invoices paid. None of these changes looked like a design choice at the time. Git history shows the writes arriving one per quarter, each in a pull request about something else. The owner's code still looks correct, which is why nobody noticed.

## Why it hurts

Drift turns a clear design into shared mutable state without anyone deciding it. The owner's tests keep passing while the data they protect goes wrong. When the owner changes a rule, such as how a refund affects the balance, the foreign writers keep applying the old one. On-call engineers debug the owner first and lose hours before finding the other writer. Each extra writer also makes the next one look normal.

## How to fix

1. Declare the resource and its owner in `architecture.yaml`, with write matchers for how the code writes it.
2. Add a `state-owner` rule and baseline what exists today. From then on the baseline only shrinks.
3. For each foreign write, add the missing operation to the owner's API and switch the caller. A write that bypasses the API for one field usually means that API lacks one function.
4. If a different component should own the state now, write a decision, change the resource's owner, and move the writes in one step.

## Architect signals

The `state-owner` rule reports a finding for each write from a non-owner, and `architect diff --base <main>` shows the new ones in the pull request that adds them. That is the moment to fix drift, since the author still has context. Changing a resource's owner or widening the rule to accept a second writer is a loosening, so it needs a decision that lists the rule in `weakens`.
