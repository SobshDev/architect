---
id: shared-mutable-state
kind: smell
title: "Shared mutable state"
summary: "Several components write the same table, collection, or in-memory object, so no single place defines what a valid write looks like."
problem: "When many components write one piece of state, its invariants live in many places at once, and a change to the shape or rules of that state has to be found and repeated in every writer."
forces:
  - "Writing a row directly is faster than asking the owning component to do it."
  - "An ORM or database client is importable from anywhere, so nothing stops a second writer."
  - "Routing every write through one owner adds an API and a call hop."
use_when:
  - "A bug came from two writers applying different rules to the same record."
  - "A schema change or migration is planned for the shared state."
  - "Writers sit in components owned by different teams or deployed separately."
avoid_when:
  - "The writers are files inside one component that already owns the state."
  - "The state is an append-only log where each writer adds its own entries and nobody updates them."
tradeoffs:
  - "One owner keeps invariants in one place but becomes a dependency for every writer."
  - "Reads can stay shared; restricting only writes gives most of the benefit at lower cost."
code_signals:
  - "rule-kind:state-owner"
  - "The same table name appears in insert or update calls in several components."
  - "Validation for one record type is copied into more than one module."
  - "A module-level dict, cache, or singleton that other components mutate."
contract_templates:
  - |
    id: orders-single-writer
    kind: state-owner
    level: warn
    description: Only the component that owns the orders resource writes to it.
    resources: [orders]
related: [single-state-owner, state-ownership-drift, scattered-functionality, transactional-outbox]
sources:
  - title: "Domain-Driven Design (Evans)"
    url: "https://www.informit.com/store/domain-driven-design-tackling-complexity-in-the-heart-9780321125217"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "On the Criteria To Be Used in Decomposing Systems into Modules (Parnas, 1972)"
    url: "https://doi.org/10.1145/361598.361623"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Shared mutable state

## Symptoms

The same table shows up in write calls across the tree. The checkout code inserts into `orders`, the admin panel updates its status, and a nightly job patches totals. Each writer has its own idea of a valid order. In Python the same thing happens with a module-level dict that three packages import and mutate. History shows fixes that land in one writer and then, weeks later, the same fix in another.

## Why it hurts

An invariant such as "a shipped order has a tracking number" holds only if every writer enforces it. Adding a column or a rule means finding every writer, and the one you miss corrupts data quietly. Tests of one writer cannot catch another writer's mistakes. Reviews get harder because a small change to the state can break code in a component the reviewer never opened. Concurrent writers also race, and those bugs are rare and hard to reproduce.

## How to fix

1. Pick one owner for the state and write it down as a resource in `architecture.yaml` with its write matchers.
2. Add a `state-owner` rule at warn and baseline the existing foreign writes, so new ones show up at once.
3. Give the owner a small write API named after intent, then move writers onto it one at a time.

~~~ts
// orders/index.ts, the only writer of the orders table
export async function markShipped(orderId: string, tracking: string): Promise<void> {
  if (!tracking) throw new Error("a shipped order needs a tracking number");
  await db.orders.update({ where: { id: orderId }, data: { status: "shipped", tracking } });
}
~~~

4. When another component must react to a change, let the owner publish an event instead of letting the reader write back.

## Architect signals

A `state-owner` rule reports each write to a declared resource from a component other than its owner. The findings are heuristic because they come from write matchers such as the Prisma or raw SQL presets, so read each one before acting. Once the baseline for the rule is empty, raise it to error with a decision that names the owner.
