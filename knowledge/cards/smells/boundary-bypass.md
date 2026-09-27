---
id: boundary-bypass
kind: smell
title: "Boundary bypass"
summary: "Code imports another component's internal files instead of its declared entry point, so private details turn into public promises."
problem: "A component's entry point is the surface its owners agreed to keep stable. Deep imports reach past it, so every internal rename or move can break callers the owners never knew about."
forces:
  - "The internal function already does what the caller needs."
  - "Adding it to the entry point feels like a bigger, more visible change."
  - "Editors auto-import the deepest path they find."
use_when:
  - "Callers outside the component import files under its internal folders."
  - "Refactors inside a component keep breaking code in other components."
  - "The component is shared by several teams or packages."
avoid_when:
  - "The import is from a test that sits next to the code it tests."
  - "The component has no declared entry points yet; declare them first, then check."
tradeoffs:
  - "Entry points need upkeep: each new export is a deliberate choice."
  - "Barrel files that re-export everything remove the smell on paper but not the coupling."
code_signals:
  - "rule-kind:entrypoints"
  - "Imports like ../billing/internal/tax.ts instead of ../billing/index.ts."
  - "Python imports such as from billing._rates import table from another package."
  - "A rename inside one component forces edits in several others."
contract_templates:
  - |
    id: public-surfaces
    kind: entrypoints
    level: warn
    description: Other components import billing and catalog only through their index files.
    targets: [billing, catalog]
  - |
    id: billing-entry
    kind: entrypoints
    level: warn
    description: Billing exposes only its index and its public types file.
    targets: [billing]
    entrypoints: ["src/billing/index.ts", "src/billing/types.ts"]
related: [hide-volatile-decisions, behavior-is-a-promise, public-api-break-or-growth, deep-modules]
sources:
  - title: "On the Criteria To Be Used in Decomposing Systems into Modules (Parnas, 1972)"
    url: "https://doi.org/10.1145/361598.361623"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Hyrum's Law"
    url: "https://www.hyrumslaw.com/"
    retrieved: "2026-09-26"
    license: none
    relation: see-also
---

# Boundary bypass

## Symptoms

Imports reach deep into another component: `import { round } from "../billing/internal/money.ts"` instead of `"../billing/index.ts"`. In Python, one package imports an underscore module from another. The entry point file exists but many callers ignore it. In history, small internal refactors are followed by fix commits in unrelated components.

## Why it hurts

Every internal file that someone imports becomes part of the public surface, whether the owners know or not. They can no longer rename, split, or delete it without a search across the codebase. Hidden behavior gets relied on as well: callers depend on the exact rounding or ordering of a helper that was never meant to be shared. Reviews get slower because a change inside one folder can break code far away.

## How to fix

1. Declare entry points for the component in `architecture.yaml`, usually its `index.ts` or `__init__.py`.
2. For each deep import, decide: is this something the component should offer? If yes, export it from the entry point on purpose, with a name that fits the public surface. If no, the caller should use a different public function or keep its own copy.
3. Rewrite the import to go through the entry point. This is mechanical and safe to do one caller at a time.
4. Avoid barrels that re-export every file; they hide the same coupling behind one path.

~~~ts
// billing/index.ts
export { invoiceTotal } from "./invoice.ts";
export type { Invoice } from "./types.ts";
~~~

## Architect signals

The `entrypoints` rule reports imports into a target component that do not land on one of its entry points. It uses the component's own `entrypoints` globs unless the rule overrides them. Start it at warn, baseline the existing deep imports, and let the baseline shrink as callers move. Pair it with `api-stability` on the same components so changes to the now small public surface show up in `architect diff`.
