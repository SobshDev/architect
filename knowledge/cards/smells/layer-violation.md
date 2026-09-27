---
id: layer-violation
kind: smell
title: "Layer violation"
summary: "A component imports a component in a higher layer, or skips layers it was told not to skip, against the declared direction of dependencies."
problem: "Lower layers are meant to be stable and general. When they reach up into volatile, specific code, every change at the top can break the bottom, and the layering stops describing the system."
forces:
  - "The data or function you need already exists in a higher layer."
  - "Moving it down or adding an interface takes longer than one import."
  - "Layer names are sometimes vague, so it is unclear where new code belongs."
use_when:
  - "Domain or core code imports HTTP handlers, UI, database clients, or framework modules."
  - "The violation is new in the current change and has no decision behind it."
  - "The lower layer is shared by several callers who now inherit the upward dependency."
avoid_when:
  - "The layering itself is wrong for the system; fix the declared layers in a decision instead of bending the code."
  - "The edge is already in the baseline and the code around it is about to be deleted."
tradeoffs:
  - "Inverting the dependency adds an interface owned by the lower layer."
  - "Strict layering without skips is easier to read but produces pass-through code."
code_signals:
  - "rule-kind:layers"
  - "rule-kind:forbid"
  - "rule-kind:allow-only"
  - "A domain file imports from src/api/ or src/web/."
  - "A core module imports a database driver or an HTTP client package."
  - "A shared helper module imports a feature module."
contract_templates:
  - |
    id: layering
    kind: layers
    level: warn
    description: Entry points depend on features, features depend on the domain, never the reverse.
    layers:
      - [api, web]
      - [billing, catalog]
      - domain
  - |
    id: domain-not-infra
    kind: forbid
    level: warn
    description: The domain never imports infrastructure or the database driver.
    from: [domain]
    to: [infra, "pkg:pg"]
  - |
    id: domain-depends-on-nothing
    kind: allow-only
    level: warn
    description: The domain may depend only on the model.
    from: [domain]
    to: [model]
related: [directed-acyclic-dependencies, ports-and-adapters, unstable-dependency, cyclic-dependency, loosening-needs-a-decision]
sources:
  - title: "Software Architecture in Practice, 4th Edition (Bass, Clements, Kazman)"
    url: "https://www.informit.com/store/software-architecture-in-practice-9780136886099"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Clean Architecture (Robert C. Martin)"
    url: "https://www.oreilly.com/library/view/clean-architecture-a/9780134494272/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Refactoring for Software Architecture Smells (Samarthyam, Suryanarayana, Sharma, 2016)"
    url: "https://doi.org/10.1145/2975945.2975946"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Layer violation

## Symptoms

A file in a low layer imports a file in a higher one. Typical cases: `src/domain/order.ts` imports a request type from `src/api/`, a repository imports a React hook, or a Python service module imports a Django view. Sometimes the edge skips layers when the rule says it should not. In the component graph, an arrow points up.

## Why it hurts

The lower layer now changes whenever the higher one changes. A tweak to an HTTP handler can break domain tests. Every other caller of the lower layer pulls in the upper layer too, so builds and test setups grow. Reviewers can no longer trust the layer diagram, and new code copies the bad edge because it is already there.

## How to fix

Take the smallest step that removes the upward edge.

1. If the lower layer only needs a type, move the type down, or define its own type and map at the boundary.
2. If it needs behavior, invert it: declare an interface in the lower layer and implement it above.

~~~py
# domain/ports.py
class Notifier(Protocol):
    def send(self, user_id: str, text: str) -> None: ...

# web/email_notifier.py implements Notifier; the app wires it in at startup
~~~

3. If the code sits in the wrong layer, move the file and update its component.
4. If the declared layers are wrong, change the rule through a decision that lists the rule in `weakens`.

## Architect signals

A `layers` rule reports edges against the declared order; `allow_skip: false` also reports skipped layers. `forbid` bans specific edges such as domain to a driver package, and `allow-only` keeps a core component down to a short list of targets. `architect check --changed` catches the edge while you work, and `architect diff` flags a weakening if someone loosens the rule to let it through.
