---
id: ports-and-adapters
kind: pattern
title: Ports and adapters
summary: Keep application logic at the center behind interfaces it owns, and connect databases, UIs, and external services through adapters on the outside.
problem: >-
  Business logic that calls frameworks, databases, and HTTP clients directly is hard to test and
  hard to move. Each technology change reaches into the core.
forces:
  - Business rules change for business reasons; technology changes for other reasons.
  - Tests of business logic should run without real infrastructure.
  - Interfaces for every call add indirection.
  - Frameworks encourage placing logic in their controllers and models.
use_when:
  - The application has meaningful business logic worth protecting.
  - The same logic is driven by several inputs, such as HTTP, a CLI, and tests.
  - Infrastructure choices are likely to change.
avoid_when:
  - The program is a thin data pipe or a small script with no domain rules.
  - The team cannot keep adapters thin, so the pattern adds only files.
tradeoffs:
  - The core becomes testable and independent of technology.
  - More interfaces and mapping code between core types and adapter types.
  - Poorly chosen ports leak infrastructure details anyway.
code_signals:
  - rule-kind:layers
  - rule-kind:forbid
  - rule-kind:external-imports
  - rule-kind:allow-only
  - finding:new-component-edge
  - Interfaces declared in the core and implemented in infrastructure code.
  - Domain files importing database drivers, HTTP clients, or framework packages.
  - A composition root that wires adapters into the core at startup.
contract_templates:
  - |
    id: hexagon-layers
    kind: layers
    level: warn
    description: Adapters depend on the application core, and the core depends only on the domain.
    layers:
      - [http-adapter, db-adapter]
      - application
      - domain
  - |
    id: domain-imports-nothing-external
    kind: allow-only
    level: warn
    description: The domain depends on no other component and no external package.
    from: [domain]
    to: []
    scope: all
  - |
    id: core-not-to-adapters
    kind: forbid
    level: warn
    description: The core never imports an adapter.
    from: [domain, application]
    to: [http-adapter, db-adapter]
related:
  - anti-corruption-layer
  - directed-acyclic-dependencies
  - layer-violation
  - hide-volatile-decisions
sources:
  - title: "Hexagonal architecture (Alistair Cockburn)"
    url: https://alistair.cockburn.us/hexagonal-architecture/
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

## Context

An application's rules are mixed with SQL queries, HTTP handling, and calls to third-party SDKs. Testing a pricing rule needs a database. Switching the payment provider means editing the checkout logic.

## Solution

Put the application logic at the center. Where it needs the outside world, it defines a port: an interface in its own terms. Adapters implement ports for a given technology. Driving adapters, such as HTTP handlers and CLIs, call into the core. Driven adapters, such as repositories and API clients, are called by the core through the ports it owns.

~~~ts
// application/ports.ts, owned by the core
export interface PaymentGateway {
  charge(customerId: string, cents: number): Promise<{ ok: boolean }>;
}

// adapters/stripe-gateway.ts, outside the core
import type { PaymentGateway } from "../application/index.ts";
export class StripeGateway implements PaymentGateway { /* calls the SDK */ }
~~~

A composition root at startup chooses the adapters and passes them in. Tests pass in fakes.

## Consequences

The core can be tested fast and in isolation. Infrastructure can change without touching business rules. The pattern adds interfaces and mapping code, and it only helps if ports are shaped by what the core needs rather than by what a vendor offers.

## In Architect

This pattern maps directly to rules. A layers rule puts adapters above the application and the domain below it. An allow-only rule with scope all keeps the domain free of other components and external packages. A forbid rule catches the core importing an adapter. A new edge from the core to an adapter is a layer violation, so fix the dependency direction rather than baselining it.
