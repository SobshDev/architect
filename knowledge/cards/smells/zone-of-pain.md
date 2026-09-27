---
id: zone-of-pain
kind: smell
title: "Zone of pain"
summary: "A component is concrete and heavily depended on, so it is both hard to change and likely to need change."
problem: "Code with many dependents is costly to change, and concrete code with no abstractions offers no way to extend it without editing it. When such code does need to change, the edit spreads to every dependent."
forces:
  - "Concrete code is simpler to write and read than code behind interfaces."
  - "Once many callers depend on it, every change needs coordination."
  - "Some concrete, stable code is fine because it almost never changes."
use_when:
  - "The component changes often, which shows up as hotspots or large diffs across its dependents."
  - "Callers need different variants and keep adding flags or special cases to the shared code."
  - "Tests of dependents are slow or brittle because they use the concrete implementation directly."
avoid_when:
  - "The component is a stable utility that rarely changes, such as date formatting or a value type."
  - "It wraps a standard library or a mature package with a fixed interface."
tradeoffs:
  - "Adding interfaces makes the component more abstract but adds indirection for every caller."
  - "Reducing dependents by splitting the component moves the cost to callers, who must change their imports."
code_signals:
  - "Abstractness near 0: the component exports classes and functions, almost no interfaces or protocols."
  - "Instability near 0: many components import it and it imports little."
  - "Many dependents call concrete classes directly, often constructing them with new."
  - "Boolean flags and mode parameters pile up in shared functions to serve different callers."
contract_templates:
  - |
    id: shared-db-surface
    kind: api-stability
    level: warn
    description: Changes to the widely used database layer show up in every diff.
    components: [db]
    allow_growth: false
related: [unstable-dependency, hide-volatile-decisions, ports-and-adapters, public-api-break-or-growth, hotspot]
sources:
  - title: "Clean Architecture (Robert C. Martin)"
    url: "https://www.oreilly.com/library/view/clean-architecture-a/9780134494272/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Your Code as a Crime Scene, 2nd Edition (Adam Tornhill)"
    url: "https://pragprog.com/titles/atcrime2/your-code-as-a-crime-scene-second-edition/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Zone of pain

## Symptoms

A component such as `db`, `models`, or `utils` is imported by most of the codebase, imports little itself, and exports only concrete classes and functions. Callers construct its classes directly and reach into their fields. Shared functions grow flags like `includeArchived` or `legacyMode` for one caller each. When its schema or signature changes, the diff touches dozens of files in many components.

## Why it hurts

The pain comes from combining two facts: many dependents, and no seams. Every change has to be made in place and then absorbed by every caller. Teams either coordinate large changes or avoid changing the code at all, so workarounds pile up in callers instead. Tests of dependents use the real implementation, so they are slow and fail for reasons unrelated to the code under test.

## How to fix

First check history. If the component rarely changes, it is not a problem worth fixing.

If it does change:

1. Find the parts that change most. These are usually the decisions most likely to vary, such as storage, formats, or vendor calls.
2. Put those parts behind an interface that dependents use, and keep the concrete implementation behind it.
3. Move callers to the interface one at a time.
4. Split out parts that only one or two callers use, so the shared surface shrinks.

~~~py
class OrderStore(Protocol):
    def get(self, order_id: str) -> Order: ...

# callers accept an OrderStore; only the composition root builds SqlOrderStore
~~~

## Architect signals

Architect has no dedicated finding. Use `architect graph --format json` and look for components with high fan-in, low fan-out, and few exported types. Hotspot findings on the same component tell you it changes often, which is when the zone of pain hurts. An `api-stability` rule with `allow_growth: false` makes every change to its surface visible in `architect diff`, and `unstable-dependency` findings on edges into it deserve a second look.
