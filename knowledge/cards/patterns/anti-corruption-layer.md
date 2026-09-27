---
id: anti-corruption-layer
kind: pattern
title: Anti-corruption layer
summary: Translate between your domain model and an external or legacy model in one dedicated component, so the foreign model never leaks inward.
problem: >-
  Integrating with a legacy system or third-party API tempts code to use that system's types,
  names, and quirks directly. Over time your own model bends to match a model you do not control.
forces:
  - The external model is shaped by another team's needs and history.
  - The external system can change on its own schedule.
  - Translation code is tedious and easy to spread across call sites.
  - A thin wrapper that only renames fields adds cost without protection.
use_when:
  - Your domain model and the external model differ in meaning, not only in naming.
  - The external system is legacy, poorly designed, or likely to be replaced.
  - Several parts of your code need the external system.
avoid_when:
  - The external model is a stable, well-designed standard you are glad to adopt.
  - Only one small call site touches the external system and it is unlikely to grow.
tradeoffs:
  - Keeps the domain clean and makes replacing the external system cheaper.
  - Adds a component to build, test, and keep in sync with the external API.
  - Translation can add latency and lose details the domain did not model.
code_signals:
  - rule-kind:external-imports
  - rule-kind:allow-only
  - rule-kind:forbid
  - finding:new-component-edge
  - Vendor SDK or legacy client types appearing in domain code.
  - Mapping functions between external DTOs and domain types.
  - A facade component whose public API uses only domain types.
contract_templates:
  - |
    id: vendor-sdk-only-in-acl
    kind: external-imports
    level: warn
    description: Only the anti-corruption layer imports the vendor SDK.
    packages: ["vendor-sdk"]
    allow_from: [acl]
  - |
    id: domain-not-to-legacy
    kind: forbid
    level: warn
    description: Domain code reaches the legacy system only through the anti-corruption layer.
    from: [domain]
    to: [legacy]
related:
  - ports-and-adapters
  - strangler-fig
  - hide-volatile-decisions
  - boundary-bypass
sources:
  - title: "Domain-Driven Design: Tackling Complexity in the Heart of Software (Eric Evans)"
    url: https://www.informit.com/store/domain-driven-design-tackling-complexity-in-the-heart-9780321125217
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Azure Architecture Center: Anti-corruption Layer pattern"
    url: https://learn.microsoft.com/en-us/azure/architecture/patterns/anti-corruption-layer
    retrieved: "2026-09-26"
    license: CC-BY-4.0
    relation: see-also
---

## Context

Your system needs data or behavior from a system with a different model: a legacy database, a partner API, a purchased package. Its concepts overlap with yours but do not match. A "customer" there may be an account, a contact, and a billing record at once.

## Solution

Create one component that owns the conversation with the external system. On the inside it offers an interface written in your domain's terms. On the outside it speaks the external protocol and model. It contains the translators, the facades over awkward APIs, and any adapters for transport or authentication.

~~~ts
// acl/orders.ts: the only file that knows the legacy shape
import type { LegacyOrderRow } from "legacy-erp-client";
import type { Order } from "../domain/index.ts";

export function toOrder(row: LegacyOrderRow): Order {
  return { id: row.ORD_NO, total: row.AMT_CENTS / 100, status: row.STS === "C" ? "closed" : "open" };
}
~~~

The domain depends on the layer's interface. It never imports the external client or its types.

## Consequences

The domain stays coherent and testable without the external system. When the external system changes or is replaced, the change stays in one component. The layer is real work: it must be maintained, and it can become a bottleneck if every team adds to it without a clear owner.

## In Architect

Declare the layer as its own component with a small entrypoint. Use an external-imports rule so that only the layer imports the external client package, and a forbid rule so that domain code does not import the legacy component. A new edge from the domain to the external component is a boundary bypass. Record why the layer exists in a decision, so that later work does not remove it as needless indirection.
