---
id: single-state-owner
kind: principle
title: "Give each piece of state one owner"
summary: "Only the owning component writes a table, collection, file, or cache; other components ask it."
problem: "When several components write the same store, each can break the store's invariants, and no single place can be changed or reasoned about when the data goes wrong."
forces:
  - "Writing a table directly is less code than calling another component."
  - "Reports and migrations often need broad write access."
  - "Detection of writes is heuristic across ORMs and raw SQL."
use_when:
  - "Adding a table, collection, queue, cache, or file that holds state."
  - "A component writes a store another component was built around."
  - "Data corruption bugs cannot be traced to one code path."
avoid_when:
  - "The store is scratch state private to one function or test."
  - "A shared store is deliberate, such as an append-only event log with a recorded decision."
tradeoffs:
  - "Other components need an API or events from the owner, which is more code."
  - "The owner can become a bottleneck for teams that need new writes."
code_signals:
  - "rule-kind:state-owner"
  - "Insert, update, or delete calls on one table from files in several components."
  - "ORM models imported and saved outside the component that defines them."
  - "Invariant checks duplicated in more than one writer."
contract_templates:
  - |
    id: invoice-writes
    kind: state-owner
    resources: [invoices]
    because: ["0006"]
related: [coupling-at-short-distance, shared-mutable-state, state-ownership-drift, transactional-outbox, cqrs]
sources:
  - title: "Balancing Coupling in Software Design (Khononov)"
    url: "https://www.informit.com/store/balancing-coupling-in-software-design-universal-design-9780137353521"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "On the Criteria To Be Used in Decomposing Systems into Modules (Parnas, 1972)"
    url: "https://doi.org/10.1145/361598.361623"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Give each piece of state one owner

## Why

A store has rules its data must follow: totals match line items, a status moves only forward. The component that owns the store can enforce those rules in one place. A second writer has to repeat them, and sooner or later it gets them wrong. Then nobody can tell which code path produced the bad row. One owner makes the store's behavior something you can read in one component, and makes changes to its shape local.

## In practice

1. List each store as a resource in `architecture.yaml` with an `owner` and write matchers. Presets cover Prisma, Drizzle, Convex, raw SQL, SQLAlchemy, and Django; a `pattern` covers the rest.
2. Add a `state-owner` rule. Findings are heuristic, so it defaults to warn; read each one.
3. Route writes from other components through the owner's entrypoint. In TypeScript, `billing.recordPayment(invoiceId, amount)` instead of `db.update(invoices)` in checkout. In Python, a service function in the owning Django app instead of `Invoice.objects.filter(...).update(...)` elsewhere.
4. Let readers read through the owner, or through a read model the owner publishes. Events suit components that only need to react.
5. For migrations and backfills, run them as the owner's code or record an exception in a decision.

## Checks

- Every resource in `architecture.yaml` has an owner.
- `architect check --all` shows no state-owner findings outside the baseline.
- Each invariant on a store is enforced in one component.
