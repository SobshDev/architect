---
id: deep-modules
kind: principle
title: "Prefer deep modules"
summary: "A component's interface should be much smaller than the work it does; merge layers that only pass calls through."
problem: "Systems split into many thin layers force callers to learn many small interfaces, and each layer adds cost without hiding anything."
forces:
  - "Small classes and files feel tidy, but the count of interfaces grows with them."
  - "A deep module is large inside and can grow into a god component."
  - "Some layers exist for a real boundary such as a deploy unit or a team."
use_when:
  - "Designing the public surface of a component."
  - "Reviewing a layer whose functions mostly forward to one other module."
  - "Callers must call several functions in a fixed order to get one result."
avoid_when:
  - "The layer hides a volatile decision or marks a team or deploy boundary."
  - "Merging would produce a component that owns unrelated responsibilities."
tradeoffs:
  - "Fewer, larger components, in exchange for simpler interfaces and fewer places to look."
  - "A deep module's internals need their own structure, since the boundary no longer forces it."
code_signals:
  - "rule-kind:entrypoints"
  - "rule-kind:api-stability"
  - "Entrypoint exports that each forward to one function in another component."
  - "Callers that must call init, configure, and run in sequence."
  - "Interfaces that expose storage rows or internal flags directly."
  - "A component whose exports outnumber its internal functions."
contract_templates:
  - |
    id: search-public-surface
    kind: entrypoints
    targets: [search]
    because: ["0004"]
  - |
    id: search-api-small
    kind: api-stability
    components: [search]
    allow_growth: false
    level: warn
related: [hide-volatile-decisions, behavior-is-a-promise, shallow-module, god-component]
sources:
  - title: "A Philosophy of Software Design (Ousterhout)"
    url: "https://web.stanford.edu/~ouster/cgi-bin/aposd.php"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "On the Criteria To Be Used in Decomposing Systems into Modules (Parnas, 1972)"
    url: "https://doi.org/10.1145/361598.361623"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Prefer deep modules

## Why

Ousterhout describes a module's value as the functionality it provides minus the cost of learning its interface. A deep module offers a lot behind a small interface: a file system call that hides buffering, caching, and device details. A shallow module has an interface nearly as complex as its body, so it adds a name to learn and a hop to follow without removing any complexity. Layers that only pass calls along are the common case.

## In practice

1. Read a component's entrypoint. Count the exports and ask what each one hides. If most forward to one other module, the layer is shallow.
2. Merge pass-through layers into their caller or their dependency. A `UserService` that wraps each `UserRepository` method one for one can usually go.
3. Design the interface around what callers want done, not around the steps. Prefer `index_document(doc)` over `tokenize`, `embed`, `store` called in order.
4. Give sensible defaults so common calls need few arguments.
5. Keep the surface small on purpose: declare entrypoints in `architecture.yaml` and add an `entrypoints` rule so internals stay private. For components others depend on, `api-stability` with `allow_growth: false` makes new exports visible in review.
6. Split a deep module only when its parts hide different decisions, not because it is long.

## Checks

- Each export at an entrypoint does meaningful work or hides a decision.
- Callers use one or two calls for a common task, without a fixed ritual.
- No component exists only to forward calls, unless a decision records why.
- `architect diff` shows few new exports per change at stable components.
