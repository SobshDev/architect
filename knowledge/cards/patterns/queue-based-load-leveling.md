---
id: queue-based-load-leveling
kind: pattern
title: Queue-based load leveling
summary: Put a queue between a bursty producer and a slower consumer so the consumer works at a steady rate.
problem: >-
  When callers send work directly to a service, traffic spikes arrive at full force. The service
  either scales for the peak, which is costly, or fails under it.
forces:
  - Demand arrives in bursts; capacity is cheaper when steady.
  - Callers want a fast acknowledgement.
  - Some work can finish later without harm to the user.
  - A queue hides backlog unless it is measured.
use_when:
  - Work can be processed asynchronously after the request returns.
  - Load is spiky and the consumer has a fixed or slowly scaling capacity.
  - The consumer protects a fragile resource, such as a legacy database or a rate-limited API.
avoid_when:
  - The caller needs the result in the same request.
  - The backlog would grow without bound because average load exceeds capacity.
tradeoffs:
  - Smooths load and decouples producer and consumer availability.
  - Adds latency, a broker to operate, and at-least-once delivery to handle.
  - Error reporting moves from the request to dead-letter queues and monitoring.
code_signals:
  - rule-kind:forbid
  - rule-kind:independent
  - Request handlers that enqueue work and return an accepted status.
  - Worker processes that poll or subscribe to a queue with a fixed concurrency.
  - Dead-letter queues and queue depth alerts.
contract_templates:
  - |
    id: producers-and-workers-independent
    kind: independent
    level: warn
    description: The API and the workers share only the message contract.
    members: [api, workers]
related:
  - bulkhead
  - idempotency-key
  - transactional-outbox
  - retry
sources:
  - title: "Azure Architecture Center: Queue-Based Load Leveling pattern"
    url: https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling
    retrieved: "2026-09-26"
    license: CC-BY-4.0
    relation: see-also
---

## Context

A service receives uploads that each need heavy processing. Most of the day traffic is light, but at the top of each hour it jumps tenfold. Sizing the processors for that peak wastes money, and sizing them for the average drops requests.

## Solution

Accept the request, put a message on a durable queue, and return. Workers pull messages at the rate they can handle. The queue absorbs bursts and releases them over time.

~~~ts
// api
export async function upload(req: Request) {
  const id = await store.save(await req.arrayBuffer());
  await queue.send("process-upload", { id });
  return new Response(null, { status: 202 });
}

// worker, fixed concurrency
queue.consume("process-upload", { concurrency: 4 }, async (msg) => process(msg.id));
~~~

Make consumers idempotent, because brokers usually deliver at least once. Send poison messages to a dead-letter queue after a few attempts. Alert on queue depth and on the age of the oldest message.

## Consequences

The consumer runs at a steady pace and the producer stays responsive. Each can be deployed and scaled on its own. Users wait longer for results and need a way to learn the outcome, such as polling or a notification. The queue is new infrastructure to run.

## In Architect

Make the producer and the workers separate components that share only a message contract component. An independent rule keeps them from importing each other. Treat the message schema as a public API with an api-stability rule on the contract component, since producers and consumers deploy at different times. Record the delivery guarantee in a decision.
