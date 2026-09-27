---
id: cqrs
kind: pattern
title: Command query responsibility segregation
summary: Use separate models for changing data and for reading it, so each can be shaped for its own job.
problem: >-
  One model that serves both updates and complex reads becomes a compromise. Validation and
  invariants fight with query shapes, joins, and denormalized views.
forces:
  - Writes need invariants, validation, and a clear owner.
  - Reads need fast, varied shapes that do not match the write model.
  - Read and write load can differ by orders of magnitude.
  - A second model adds synchronization and possible staleness.
use_when:
  - Read and write needs differ sharply in shape or scale.
  - The domain has rich rules on the write side.
  - Several views of the same data are needed, such as search, reports, and screens.
avoid_when:
  - The domain is mostly create, read, update, and delete with simple screens.
  - Readers cannot tolerate any delay between a write and its visibility.
tradeoffs:
  - Each side is simpler and can scale and change on its own.
  - Two models to maintain, plus the code that projects writes into read views.
  - Separate stores make read views eventually consistent.
code_signals:
  - rule-kind:forbid
  - rule-kind:independent
  - rule-kind:state-owner
  - Command handlers that return no data, and query handlers that write nothing.
  - Projection code that builds read tables from write events or change logs.
  - Separate read and write database connections or schemas.
contract_templates:
  - |
    id: queries-do-not-use-commands
    kind: independent
    level: warn
    description: The command and query sides do not import each other.
    members: [commands, queries]
  - |
    id: read-models-owned-by-projections
    kind: state-owner
    level: warn
    description: Only the projection component writes read models.
    resources: [read-models]
related:
  - event-sourcing
  - single-state-owner
  - backend-for-frontend
  - cache-aside
sources:
  - title: "CQRS (Martin Fowler)"
    url: https://martinfowler.com/bliki/CQRS.html
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Azure Architecture Center: CQRS pattern"
    url: https://learn.microsoft.com/en-us/azure/architecture/patterns/cqrs
    retrieved: "2026-09-26"
    license: CC-BY-4.0
    relation: see-also
---

## Context

An application's domain model enforces many rules when data changes. Its screens and reports also need many different read shapes. The same classes try to do both, and each new report adds fields and joins that the write side does not need.

## Solution

Split the model. Commands go to a write model that validates, enforces invariants, and commits. Queries go to read models shaped for each consumer. A projection keeps read models up to date from the write side, synchronously in the same transaction or asynchronously from events.

~~~ts
// commands: change state, return nothing useful to render
export async function renameProduct(cmd: { id: string; name: string }): Promise<void> {
  const product = await products.load(cmd.id);
  product.rename(cmd.name);
  await products.save(product);
}

// queries: read a view built for the screen
export function productList(page: number) {
  return db.query("SELECT id, name, price FROM product_list_view LIMIT 50 OFFSET ?", [page * 50]);
}
~~~

The split can be as small as separate code paths over one database. Separate stores are a further step, taken only when load or shape demands it.

## Consequences

Each side becomes easier to reason about and to optimize. The cost is more code, the projection logic, and, with separate stores, stale reads that the UI must handle. Applied to a simple domain, CQRS adds complexity without payoff.

## In Architect

Declare the command side, the query side, and the projections as components. An independent rule keeps the command and query sides from importing each other. Declare the read models as a resource and use a state-owner rule so that only projections write them. Record the consistency expectation, synchronous or eventual, in a decision.
