---
id: idempotency-key
kind: pattern
title: Idempotency key
summary: Let clients attach a unique key to a request so that the server performs the operation at most once and replays the stored result on repeats.
problem: >-
  Networks drop responses. A client that retries a payment or order creation cannot tell whether
  the first attempt succeeded, so a naive retry can charge twice or create duplicates.
forces:
  - Clients must retry to survive transient failures.
  - Side effects such as charges and emails must happen once.
  - Concurrent duplicates can arrive while the first request is still running.
  - Stored keys cost space and need an expiry.
use_when:
  - An operation has side effects and clients may retry it.
  - Messages are delivered at least once, as with most queues.
  - Several steps of a saga or workflow may be replayed.
avoid_when:
  - The operation is naturally idempotent, such as setting a value or deleting by id.
  - Requests are never retried and duplicates are harmless.
tradeoffs:
  - Makes retries safe and simplifies client logic.
  - Requires a durable key store and careful locking for concurrent duplicates.
  - The server must reject a reused key with a different payload.
code_signals:
  - rule-kind:state-owner
  - An Idempotency-Key header or a request id field on write endpoints.
  - A table of keys with stored response codes and bodies.
  - Unique constraints on message ids in consumers.
contract_templates:
  - |
    id: idempotency-keys-single-owner
    kind: state-owner
    level: warn
    description: Only the request middleware writes the idempotency key store.
    resources: [idempotency-keys]
related:
  - retry
  - transactional-outbox
  - saga
  - behavior-is-a-promise
sources:
  - title: "Stripe API reference: Idempotent requests"
    url: https://docs.stripe.com/api/idempotent_requests
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Implementing Stripe-like Idempotency Keys in Postgres (Brandur Leach)"
    url: https://brandur.org/idempotency-keys
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

## Context

A mobile client submits an order. The server creates it, but the response is lost. The client retries. Without help, the server creates a second order.

## Solution

The client generates a unique key for each logical operation and sends it with every attempt. The server records the key before doing work. On a repeat, it returns the saved result instead of running again. If the same key arrives with a different payload, it rejects the request.

~~~ts
export async function createOrder(key: string, body: OrderInput) {
  return db.transaction(async (tx) => {
    const seen = await tx.get("SELECT status, response, hash FROM idem WHERE key = ? FOR UPDATE", [key]);
    if (seen) {
      if (seen.hash !== hash(body)) throw new Conflict("key reused with a different request");
      return seen.response;
    }
    const order = await insertOrder(tx, body);
    await tx.run("INSERT INTO idem (key, status, response, hash) VALUES (?, 200, ?, ?)", [key, order, hash(body)]);
    return order;
  });
}
~~~

Store the key in the same transaction as the side effect when possible. Scope keys to the caller, and expire them after a period longer than any client retry window.

## Consequences

Clients can retry freely, and servers stay correct under duplicate delivery. The cost is a key store, a lookup on every write, and handling of in-flight duplicates. External side effects, such as calls to other APIs, need their own keys passed along.

## In Architect

Handle keys in one component, usually request middleware or a consumer wrapper. Declare the key store as a resource and use a state-owner rule so that nothing else writes to it. Idempotent behavior is part of the public contract, so record it in a decision and treat its removal as a weakening.
