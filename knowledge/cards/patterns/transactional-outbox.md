---
id: transactional-outbox
kind: pattern
title: Transactional outbox
summary: Write outgoing messages to an outbox table in the same database transaction as the state change, then publish them from that table.
problem: >-
  A service must update its database and publish an event. Doing both directly risks one
  succeeding without the other, since the database and the broker do not share a transaction.
forces:
  - The event must be published if and only if the state change commits.
  - Distributed transactions across the database and broker are rarely available.
  - Consumers must tolerate duplicates, because the relay can publish twice.
  - Event order often matters per entity.
use_when:
  - A service publishes events or commands as a result of local state changes.
  - Losing or inventing an event would corrupt downstream state.
avoid_when:
  - The store and the broker share a transaction.
  - Events are advisory, so an occasional loss is acceptable.
tradeoffs:
  - Guarantees that commits and messages match.
  - Adds a table, a relay process, and cleanup of published rows.
  - Delivery is at least once, so consumers need idempotency.
code_signals:
  - rule-kind:state-owner
  - rule-kind:external-imports
  - An outbox table written inside the same transaction as domain tables.
  - A relay that polls the outbox or tails the database log and publishes to a broker.
  - Domain code that calls a broker client directly after a commit.
contract_templates:
  - |
    id: broker-client-only-in-relay
    kind: external-imports
    level: warn
    description: Only the outbox relay talks to the message broker.
    packages: ["kafkajs", "amqplib"]
    allow_from: [outbox-relay]
  - |
    id: outbox-single-owner
    kind: state-owner
    level: warn
    description: Domain code inserts into the outbox; only the relay marks rows published.
    resources: [outbox]
related:
  - saga
  - idempotency-key
  - event-sourcing
  - queue-based-load-leveling
sources:
  - title: "Pattern: Transactional outbox (Chris Richardson, microservices.io)"
    url: https://microservices.io/patterns/data/transactional-outbox.html
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

## Context

An order service saves an order and then publishes an OrderPlaced event. If the process crashes between the two, the order exists but nobody hears about it. If it publishes first and the commit fails, downstream services act on an order that does not exist.

## Solution

In the same transaction that saves the order, insert the event into an outbox table. A separate relay reads unpublished rows in order, publishes them, and marks them sent.

~~~ts
await db.transaction(async (tx) => {
  await tx.run("INSERT INTO orders (id, total) VALUES (?, ?)", [order.id, order.total]);
  await tx.run("INSERT INTO outbox (topic, key, payload) VALUES (?, ?, ?)",
    ["order-placed", order.id, JSON.stringify(order)]);
});

// relay, in its own process
for (const row of await db.all("SELECT * FROM outbox WHERE sent = 0 ORDER BY seq LIMIT 100")) {
  await broker.publish(row.topic, row.key, row.payload);
  await db.run("UPDATE outbox SET sent = 1 WHERE seq = ?", [row.seq]);
}
~~~

The relay can poll, or it can read the database's change log. Either way, a crash after publishing and before marking causes a duplicate, so consumers must deduplicate.

## Consequences

Commits and messages can no longer diverge. The service code stays simple: it only writes rows. The costs are the relay, its monitoring, and pruning of old rows. Latency rises by the polling interval.

## In Architect

Declare the outbox table as a resource and keep publishing in a relay component. An external-imports rule that allows the broker client only in the relay stops domain code from publishing directly and bypassing the outbox. Record the delivery guarantee, at least once and ordered per key, in a decision so consumers can rely on it.
