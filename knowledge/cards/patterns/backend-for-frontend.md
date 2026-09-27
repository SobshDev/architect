---
id: backend-for-frontend
kind: pattern
title: Backend for frontend
summary: Give each kind of client its own thin server-side backend that shapes data and calls for that client.
problem: >-
  A single general API serves web, mobile, and partner clients with different needs. It either
  grows many client-specific options or forces clients to make many calls and discard most data.
forces:
  - Clients differ in screen size, network, release cycle, and data needs.
  - Client teams want to change their API without negotiating with every other client.
  - Duplicated logic across backends drifts apart.
  - Business rules belong in shared services, not in client-facing glue.
use_when:
  - Several client types need noticeably different payloads or flows.
  - Each client has a team that can own its backend.
  - Clients would otherwise orchestrate many calls over slow networks.
avoid_when:
  - All clients need roughly the same data.
  - There is one client, or no team to own an extra backend.
tradeoffs:
  - Each client gets an API fitted to it and can evolve on its own schedule.
  - More deployable units, and a risk of copied logic across backends.
  - A backend that absorbs business rules becomes a second, hidden domain layer.
code_signals:
  - rule-kind:independent
  - rule-kind:forbid
  - finding:god-component
  - Separate API gateways or servers per client, such as web-bff and mobile-bff.
  - Aggregation handlers that call several services and reshape the results.
  - Business rules duplicated in two backends.
contract_templates:
  - |
    id: bffs-independent
    kind: independent
    level: warn
    description: Each backend for frontend stays separate from the others.
    members: [web-bff, mobile-bff]
  - |
    id: services-not-to-bffs
    kind: forbid
    level: warn
    description: Shared services never depend on a client backend.
    from: [domain]
    to: [web-bff, mobile-bff]
related:
  - ports-and-adapters
  - cqrs
  - god-component
  - scattered-functionality
sources:
  - title: "Pattern: Backends For Frontends (Sam Newman)"
    url: https://samnewman.io/patterns/architectural/bff/
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Azure Architecture Center: Backends for Frontends pattern"
    url: https://learn.microsoft.com/en-us/azure/architecture/patterns/backends-for-frontends
    retrieved: "2026-09-26"
    license: CC-BY-4.0
    relation: see-also
---

## Context

A mobile app loads a home screen that needs profile, orders, and recommendations. The general API returns each in full, in three calls, over a slow network. The web app wants different fields. Each change to the shared API needs both teams to agree.

## Solution

Give each client type its own backend, owned by the client's team. The backend calls shared services, combines and trims their results, and exposes exactly what that client needs. Business rules stay in the shared services; the backend only adapts.

~~~ts
// mobile-bff/home.ts
export async function home(userId: string) {
  const [profile, orders, recs] = await Promise.all([
    profiles.get(userId), orders.recent(userId, 3), recommendations.top(userId, 5),
  ]);
  return { name: profile.firstName, orders: orders.map((o) => ({ id: o.id, status: o.status })), recs };
}
~~~

Keep backends thin. When two backends need the same logic, move it into a shared service instead of copying it.

## Consequences

Clients get fast, fitted APIs and can ship without coordinating every change. The system gains more services to deploy and watch. The main risk is drift: a backend that accumulates rules becomes a god component, and copies of logic in several backends diverge.

## In Architect

Declare each backend as a component. An independent rule keeps the backends from importing each other, which pushes shared logic down into services. A forbid rule keeps shared services from depending on any backend. Watch the god-component finding on backends, which signals that business rules are collecting in the wrong place.
