---
id: behavior-is-a-promise
kind: principle
title: "Treat observable behavior as a promise"
summary: "Exports at entrypoints, wire formats, and CLI output change only with a decision and a migration path."
problem: "Consumers depend on everything they can observe, so a change that looks internal to its author can break callers, clients, or scripts downstream."
forces:
  - "Consumers rely on behavior nobody documented, including ordering and error text."
  - "Freezing everything stops a component from improving."
  - "The author of a change rarely sees all its consumers."
use_when:
  - "Changing exports at a component's entrypoint."
  - "Changing HTTP payloads, event schemas, file formats, or CLI output."
  - "Removing or renaming anything another package or team consumes."
avoid_when:
  - "The code is private to one component and never observable outside it."
  - "The project has no consumers yet and says so in a decision."
tradeoffs:
  - "Migration paths and deprecation periods slow change."
  - "A small promised surface means fewer promises, but also less that consumers can do without asking."
code_signals:
  - "rule-kind:api-stability"
  - "rule-kind:entrypoints"
  - "rule-kind:deprecated"
  - "finding:deprecated-dependency"
  - "Removed or renamed exports at an entrypoint in a diff."
  - "Changed field names or types in a serialized payload."
  - "Changed column order or wording in command output that scripts parse."
contract_templates:
  - |
    id: sdk-api
    kind: api-stability
    components: [sdk]
    allow_growth: false
    because: ["0007"]
  - |
    id: no-new-legacy-users
    kind: deprecated
    components: [legacy-api]
    because: ["0008"]
related: [deep-modules, loosening-needs-a-decision, public-api-break-or-growth, unstable-interface, strangler-fig]
sources:
  - title: "Hyrum's Law"
    url: "https://www.hyrumslaw.com/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "A Philosophy of Software Design (Ousterhout)"
    url: "https://web.stanford.edu/~ouster/cgi-bin/aposd.php"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Treat observable behavior as a promise

## Why

Hyrum's Law observes that with enough users, every observable behavior of a system will be depended on by somebody, whatever the documentation says. So the real interface is everything a consumer can see: exported functions and types, response shapes, error messages, output order. Changing any of it can break someone. Treating it as a promise means making such changes on purpose, with a record and a way for consumers to move.

## In practice

1. Know your promised surface: entrypoints in `architecture.yaml`, public HTTP and event schemas, CLI output, and files you write for others.
2. Keep it small. Export from `index.ts` or `__init__.py` only what consumers need, and enforce it with an `entrypoints` rule.
3. Mark components other teams consume with `api-stability`. `architect diff --base origin/main` then reports removed or changed exports, and new ones when growth is off.
4. To change a promise, write a decision: what changes, who is affected, and the migration path. Add the new form first, mark the old one deprecated, and remove it later.
5. Mark a component being replaced as `deprecated` in `architecture.yaml` with a replacement, and add a `deprecated` rule so it gains no new dependents.
6. Version wire formats and keep readers tolerant of unknown fields.

## Checks

- `architect diff` shows no API break at a stable component without a decision in the same change.
- Every deprecation names a replacement and a removal plan.
- Deprecated components gain no new dependents.
