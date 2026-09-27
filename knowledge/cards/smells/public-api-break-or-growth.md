---
id: public-api-break-or-growth
kind: smell
title: "Public API break or growth"
summary: "A change removes or alters an export that other components use, or adds exports that widen the public surface without a decision."
problem: "Breaking changes to a public surface fail callers the author never saw, and unreviewed growth turns internal details into promises that are hard to take back."
forces:
  - "Exporting a helper is the quickest way to let another component use it."
  - "Callers depend on everything they can reach, not only what was intended."
  - "Keeping old forms alongside new ones adds code for a while."
use_when:
  - "The component has callers outside its team or repository."
  - "An export was removed or its signature changed in the current diff."
  - "The number of exports keeps rising while the component's purpose stays the same."
avoid_when:
  - "The component is internal, young, and every caller changes in the same commit."
  - "The change is to a surface already marked deprecated with a published removal date."
tradeoffs:
  - "Additive changes and deprecation periods protect callers at the cost of temporary duplication."
  - "Blocking growth keeps the surface small but makes authors justify each new export."
  - "An approved break in a decision is cheaper than years of compatibility code, when callers are few."
code_signals:
  - "rule-kind:api-stability"
  - "rule-kind:entrypoints"
  - "finding:unapproved-weakening"
  - "An export deleted or renamed in a diff with callers in other components."
  - "A helper exported from index.ts so that one other component can use it."
  - "Required parameters added to an existing exported function."
contract_templates:
  - |
    id: sdk-surface-stable
    kind: api-stability
    level: warn
    description: The SDK's exports must not break or grow without a decision.
    components: [sdk]
    allow_growth: false
  - |
    id: sdk-entrypoint
    kind: entrypoints
    level: warn
    description: Callers import the SDK only through its entrypoint.
    targets: [sdk]
related: [behavior-is-a-promise, unstable-interface, deep-modules, loosening-needs-a-decision, strangler-fig]
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

# Public API break or growth

## Symptoms

A pull request renames `createInvoice` to `issueInvoice` and updates the callers it can find. Another pull request exports `parseLegacyRow` from `billing/index.ts` because the reporting job needs it. Both look small in review. The first breaks a caller in another repository; the second makes a legacy detail part of billing's public surface for years.

## Why it hurts

A public export is a promise. Breaking it moves work to every caller, often at a bad time and without warning. Growth is quieter but also costly: each new export is one more thing callers can depend on, so the owner loses freedom to change internals. A surface that grows without review becomes shallow and hard to learn, and its internal details turn into behavior someone relies on.

## How to fix

1. For a break, make the change additive. Add the new name or overload, keep the old one working, and mark it deprecated.

~~~ts
export function issueInvoice(order: Order): Promise<Invoice> { /* ... */ }
/** @deprecated Use issueInvoice. Removed after the 2027-01 release. */
export const createInvoice = issueInvoice;
~~~

2. Move callers, then remove the old form in a later change with a decision that records the break.
3. For growth, ask whether the caller needs the helper or needs a higher level function. Prefer one deeper export over several helpers.
4. Keep internal helpers in internal files outside the entrypoints.

## Architect signals

An api-stability rule makes `architect diff` compare the exports at a component's entrypoints between base and head. Removed and changed exports are reported at the rule's level. With `allow_growth: false`, new exports are reported as warnings. An entrypoints rule makes the entrypoints the only public files. To approve an intended break, write a decision that lists the rule in `weakens`, and the diff marks the finding as waived. Dropping a file from the entrypoints to dodge the check is itself reported as an unapproved weakening unless a decision approves it.
