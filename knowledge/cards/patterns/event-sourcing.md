---
id: event-sourcing
kind: pattern
title: Event sourcing
summary: Store every change to an entity as an immutable event and derive current state by replaying those events.
problem: >-
  Storing only current state loses the history of how it came to be. Audits, debugging, and new
  views of past behavior become impossible or need separate logging that drifts from the truth.
forces:
  - Some domains need a complete, trustworthy history.
  - Events are a public contract once stored; they cannot be edited.
  - Replaying long histories is slow without snapshots.
  - Schema changes must handle every event version ever written.
use_when:
  - The history of changes is itself valuable, as in finance, logistics, or compliance.
  - Several read models need to be built and rebuilt from the same facts.
  - The domain is naturally described as a sequence of events.
avoid_when:
  - Only the current state matters and history is rarely read.
  - The team is new to the pattern and the domain is simple; the cost is high to reverse.
tradeoffs:
  - A full audit trail and the ability to rebuild any view.
  - Event schemas become permanent, so versioning is required.
  - Queries need projections, and the store is harder to inspect by hand.
code_signals:
  - rule-kind:state-owner
  - rule-kind:api-stability
  - finding:contract-changed
  - An append-only events table or event store client.
  - Aggregates rebuilt by folding over a list of events.
  - Event upcasters or version fields on stored events.
contract_templates:
  - |
    id: events-are-stable
    kind: api-stability
    level: warn
    description: Stored event types may grow but never change or disappear.
    components: [events]
  - |
    id: event-store-single-writer
    kind: state-owner
    level: warn
    description: Only the domain's aggregates append to the event store.
    resources: [event-store]
related:
  - cqrs
  - transactional-outbox
  - behavior-is-a-promise
  - public-api-break-or-growth
sources:
  - title: "Event Sourcing (Martin Fowler)"
    url: https://martinfowler.com/eaaDev/EventSourcing.html
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Azure Architecture Center: Event Sourcing pattern"
    url: https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing
    retrieved: "2026-09-26"
    license: CC-BY-4.0
    relation: see-also
---

## Context

An account balance is stored as one number. When a customer disputes it, nobody can show how it got there. Adding an audit log helps, but the log and the balance can disagree.

## Solution

Make the events the source of truth. Each command validates against current state and appends one or more events. Current state is the result of applying all events in order. Read models are projections that subscribe to the event stream.

~~~ts
type AccountEvent =
  | { type: "opened"; v: 1 }
  | { type: "deposited"; v: 1; cents: number }
  | { type: "withdrew"; v: 1; cents: number };

export function balance(events: AccountEvent[]): number {
  return events.reduce((sum, e) =>
    e.type === "deposited" ? sum + e.cents : e.type === "withdrew" ? sum - e.cents : sum, 0);
}
~~~

Store snapshots for long streams. Version every event type, and add upcasters that read old versions, because stored events are never rewritten.

## Consequences

History is complete and trustworthy by construction. New views can be built from old facts. The cost is significant: event schemas are permanent, queries need projections, and developers must learn a different style. Fixing bad data means appending corrective events.

## In Architect

Put event type definitions in their own component and protect it with an api-stability rule, since changing a stored event shape breaks replay. A contract change there needs a decision. Declare the event store as a resource with a state-owner rule so that only aggregates append to it. Record the versioning policy in a decision.
