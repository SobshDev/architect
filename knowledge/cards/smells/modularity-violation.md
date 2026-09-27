---
id: modularity-violation
kind: smell
title: "Modularity violation"
summary: "Components that the design says are independent keep changing together, which shows the declared modules do not match the real ones."
problem: "The declared structure promises that a change stays inside one module, but history shows it does not, so plans and ownership built on the structure are wrong."
forces:
  - "The declared structure is easy to read and review; the real structure only shows in history."
  - "Teams plan and assign work by the declared modules."
  - "Changing the declared structure, or the code, both carry a cost."
use_when:
  - "The components are covered by an independent rule or belong to different owners."
  - "Estimates for work in one component keep missing the edits needed in the other."
  - "A split into packages or services is planned along the declared lines."
avoid_when:
  - "The co-change is from repository-wide chores such as upgrades or renames."
  - "The history window covers a one-time migration that is now finished."
tradeoffs:
  - "Fixing the code restores independence but may need a new shared abstraction."
  - "Fixing the design by merging or moving boundaries is honest but changes ownership."
  - "Leaving it costs nothing today and keeps misleading every plan."
code_signals:
  - "finding:hidden-change-coupling"
  - "rule-kind:independent"
  - "Components listed as independent that show up together in most feature commits."
  - "Parallel type definitions or copied logic in two components that must stay aligned."
contract_templates:
  - |
    id: features-independent
    kind: independent
    level: warn
    description: Billing and shipping must be changeable without each other.
    members: [billing, shipping]
related: [hidden-change-coupling, hide-volatile-decisions, scattered-functionality, unbalanced-coupling]
sources:
  - title: "Detecting Software Modularity Violations (Wong et al., ICSE 2011)"
    url: "https://doi.org/10.1145/1985793.1985850"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Exploring the Structure of Complex Software Designs (MacCormack, Rusnak, Baldwin, 2006)"
    url: "https://doi.org/10.1287/mnsc.1060.0552"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "On the Criteria To Be Used in Decomposing Systems into Modules (Parnas, 1972)"
    url: "https://doi.org/10.1145/361598.361623"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Modularity violation

## Symptoms

`rules.yaml` declares billing and shipping independent, and the import checks pass. Yet the last twenty feature commits in billing each came with a shipping change. The two components each hold a copy of the address format, or each encode the same assumption about how orders split into parcels. The import graph and the change history tell two different stories about the system.

## Why it hurts

Modules exist so that a design decision is hidden in one place. When two independent modules change together, a decision leaked into both. Every plan built on the declared structure is then wrong: estimates skip the second half, ownership sends reviews to one team when two are affected, and a planned service split would turn today's co-change into cross-service releases.

## How to fix

1. Name the leaked decision. Read the shared commits and find what both sides know, such as a data format or a business rule.
2. Choose where it belongs. If one side can own it, move it there and have the other side call the owner through its entrypoint; this adds an honest dependency.
3. If neither side should depend on the other, move the decision into a small third component both use.

~~~ts
// addresses/index.ts, a small shared module both depend on
export interface PostalAddress { line1: string; city: string; postcode: string; country: string }
export function formatLabel(a: PostalAddress): string { /* ... */ }
~~~

4. If the two sides share too much for either option, the declared boundary is wrong. Merge them and update the contract.

## Architect signals

Hidden change coupling findings list component pairs that change together without imports. When the pair is also covered by an independent rule, the history contradicts the design, which is a modularity violation. The independent rule keeps imports out; only a follow-up history check shows the co-change is gone. Record the chosen owner of the leaked decision, or the merge, in a decision so the rules and the real modules match again.
