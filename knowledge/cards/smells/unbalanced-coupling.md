---
id: unbalanced-coupling
kind: smell
title: "Unbalanced coupling"
summary: "Components that are far apart share a lot of knowledge about each other, or components that share a lot are placed far apart."
problem: "Strong coupling across a long distance makes every change to one side a coordinated change across teams, releases, or services."
forces:
  - "Reading another component's internals is the quickest way to get the data you need."
  - "Distance, such as a separate team or service, raises the cost of every shared change."
  - "Reducing shared knowledge needs an explicit contract, which someone has to design and maintain."
use_when:
  - "A change inside one component regularly breaks another that belongs to a different team or deploy unit."
  - "Two components meant to be independent now import each other's internal files."
  - "A split into services is planned and the future service boundaries cross strong coupling."
avoid_when:
  - "The coupled code sits in one small component owned by one team; strong coupling at short distance is fine."
  - "The shared knowledge is a stable, published contract that rarely changes."
tradeoffs:
  - "Narrow contracts between distant components let each side change alone."
  - "Contracts need translation code on at least one side."
  - "Merging tightly coupled components reduces distance but makes one larger unit to own."
code_signals:
  - "finding:new-component-edge"
  - "rule-kind:independent"
  - "rule-kind:entrypoints"
  - "One component imports internal files, not the entrypoint, of a component owned by another team."
  - "Two services read and write the same database tables."
  - "A small change in one component comes with matching edits in a distant one."
contract_templates:
  - |
    id: features-independent
    kind: independent
    level: warn
    description: Feature components do not depend on each other.
    members: [billing, catalog, shipping]
  - |
    id: import-through-entrypoints
    kind: entrypoints
    level: warn
    description: Other components import billing and catalog only through their public files.
    targets: [billing, catalog]
related: [coupling-at-short-distance, boundary-bypass, anti-corruption-layer, modular-monolith]
sources:
  - title: "Balancing Coupling in Software Design (Khononov)"
    url: "https://www.informit.com/store/balancing-coupling-in-software-design-universal-design-9780137353521"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Domain-Driven Design (Evans)"
    url: "https://www.informit.com/store/domain-driven-design-tackling-complexity-in-the-heart-9780321125217"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Unbalanced coupling

## Symptoms

The shipping component reads `billing/internal/invoice-row.ts` to get a total. A catalog service queries the orders table directly. Each import is harmless on its own. Together they mean the two sides share details of data shape and behavior while living in different folders, owned by different people, deployed at different times. The opposite case also exists: two components split apart that change together in every commit, with a wide interface between them.

## Why it hurts

Coupling costs little when the coupled code is close, because one person changes both sides in one commit. Distance multiplies the cost. Across teams, a change needs a meeting. Across deploys, it needs a staged rollout. When the shared knowledge is an internal detail, the owner cannot even see who depends on it, so a refactoring inside billing breaks shipping in production.

## How to fix

1. Find edges that cross a long distance and ask what knowledge they share. Detail knowledge, such as a table layout or an internal class, is the expensive kind.
2. Replace it with a small contract at the owner's entrypoint: a function or a data type designed for callers.

~~~ts
// billing/index.ts
export interface InvoiceSummary { id: string; totalCents: number }
export function invoiceSummary(id: string): Promise<InvoiceSummary> { /* ... */ }
~~~

3. Move callers to the contract, then make the internal files private.
4. If two components share so much that no narrow contract fits, reduce the distance instead: merge them or give them one owner.

## Architect signals

`architect diff` reports new component edges, which is where distant coupling starts. An independent rule lists components that must not depend on each other at all, and an entrypoints rule makes the others go through public files. Unstable dependency findings show edges where a stable component leans on a volatile one. Record why two components are kept apart in a decision, and cite it in `because` when you raise the rules to error.
