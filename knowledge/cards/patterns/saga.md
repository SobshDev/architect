---
id: saga
kind: pattern
title: Saga
summary: Run a business transaction that spans several services as a sequence of local transactions, with a compensating action for each step.
problem: >-
  When data lives in several services or databases, one ACID transaction cannot cover a business
  operation. Two-phase commit is slow, fragile, and often unavailable.
forces:
  - Each service must own and commit its own data.
  - The business operation must end in a consistent state, even after partial failure.
  - Some steps cannot be undone, only offset, such as a sent email or a charged card.
  - Intermediate states are visible to other readers.
use_when:
  - A business operation updates data owned by several services.
  - Each step can be compensated or retried.
  - Eventual consistency is acceptable for the operation.
avoid_when:
  - All the data lives in one database, where a local transaction is simpler.
  - The operation needs isolation that intermediate states would break.
tradeoffs:
  - Avoids distributed locks and keeps services autonomous.
  - Compensations are extra code with their own failure cases.
  - Missing isolation causes anomalies that must be designed for, such as lost updates.
  - Choreography is loose but hard to follow; orchestration is explicit but adds a coordinator.
code_signals:
  - rule-kind:state-owner
  - Handlers that undo or offset an earlier step, such as refund, release, or cancel.
  - A coordinator that records the step and state of each business transaction.
  - Events published after each local commit and consumed by the next step.
contract_templates:
  - |
    id: services-own-their-data
    kind: state-owner
    level: warn
    description: Each saga participant writes only its own resources.
related:
  - transactional-outbox
  - idempotency-key
  - event-sourcing
  - single-state-owner
sources:
  - title: "Sagas (Hector Garcia-Molina and Kenneth Salem, SIGMOD 1987)"
    url: https://doi.org/10.1145/38713.38742
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Pattern: Saga (Chris Richardson, microservices.io)"
    url: https://microservices.io/patterns/data/saga.html
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Azure Architecture Center: Saga pattern"
    url: https://learn.microsoft.com/en-us/azure/architecture/patterns/saga
    retrieved: "2026-09-26"
    license: CC-BY-4.0
    relation: see-also
---

## Context

Placing an order touches inventory, payment, and shipping, and each is owned by a different service with its own database. There is no single transaction that can commit all three.

## Solution

Break the operation into steps. Each step is a local transaction in one service. If a step fails, run the compensating actions for the steps that already committed, in reverse order.

~~~ts
const steps = [
  { run: reserveStock, undo: releaseStock },
  { run: chargeCard, undo: refundCard },
  { run: bookShipment, undo: cancelShipment },
];

export async function placeOrder(order: Order) {
  const done: typeof steps = [];
  try {
    for (const step of steps) { await step.run(order); done.push(step); }
  } catch (err) {
    for (const step of done.reverse()) await step.undo(order);
    throw err;
  }
}
~~~

Coordinate the steps in one of two ways. In orchestration, a coordinator calls each step and stores progress. In choreography, each service reacts to the previous service's event. Make every step and compensation idempotent, because messages repeat.

## Consequences

Services stay independent and the operation still finishes in a consistent state. But the design moves work into application code: compensations, retries, progress tracking, and handling of readers who see half-finished work. Testing must cover failure at each step.

## In Architect

A saga depends on each participant owning its data. Declare resources in architecture.yaml and use a state-owner rule so that only the owning component writes each one. Keep the coordinator in its own component. Record the steps, their compensations, and the chosen coordination style in a decision, since changing any of them changes the business guarantee.
