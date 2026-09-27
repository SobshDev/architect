---
id: hidden-change-coupling
kind: smell
title: "Hidden change coupling"
summary: "Two components keep changing in the same commits even though neither imports the other, so the link between them is invisible in the code."
problem: "An implicit contract that no import records gets broken by authors who do not know it exists, and the break shows up at runtime."
forces:
  - "Shared formats, protocols, and config keys connect code without any import."
  - "Import graphs are easy to check; runtime contracts are not."
  - "Making the contract explicit adds a shared module that both sides depend on."
use_when:
  - "A change to one side was released without the matching change to the other and caused an incident."
  - "Reviewers keep asking whether a paired file was also updated."
  - "The pair crosses a team or deploy boundary."
avoid_when:
  - "The co-change comes from bulk edits such as renames, formatting, or dependency upgrades."
  - "The pair is a test fixture and the code it tests, or generated code and its source."
  - "Support is low and confidence is close to the threshold; wait for more history."
tradeoffs:
  - "An explicit shared contract turns silent breaks into compile or test failures."
  - "The shared contract becomes a dependency that both sides must agree to change."
  - "Merging the two components removes the problem but grows one component."
code_signals:
  - "finding:hidden-change-coupling"
  - "Two components serialize and parse the same JSON shape with separate type definitions."
  - "A queue topic, event name, or environment variable spelled as a string literal in two places."
  - "Commit messages that say 'also update the worker' or 'keep in sync with'."
contract_templates:
  - |
    id: shared-contracts-stable
    kind: api-stability
    level: warn
    description: Changes to the shared message types are reviewed as API changes.
    components: [contracts]
related: [modularity-violation, history-before-restructuring, scattered-functionality, hotspot]
sources:
  - title: "Your Code as a Crime Scene, 2nd Edition (Tornhill)"
    url: "https://pragprog.com/titles/atcrime2/your-code-as-a-crime-scene-second-edition/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Hotspot Patterns: The Formal Definition and Automatic Detection of Architecture Smells (Mo, Cai, Kazman, Xiao, WICSA 2015)"
    url: "https://doi.org/10.1109/WICSA.2015.12"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Hidden change coupling

## Symptoms

The API writes an event to a queue and the worker reads it. Neither imports the other; both define their own `OrderPlaced` type. Git history shows that most commits touching one also touch the other. The dependency graph shows no edge, so a reviewer who looks only at imports sees two unrelated components. The same pattern appears with a config file read by two services, a database table written by one and read by another, or a URL built in the web client and parsed on the server.

## Why it hurts

The contract exists, but only in people's heads. A new contributor changes a field name on one side, tests pass on both sides because each has its own types, and the worker fails in production. Refactoring tools cannot follow the link. Estimates are wrong because the second half of every change is discovered late.

## How to fix

1. Confirm the coupling is real. Read a few of the shared commits and name the implicit contract.
2. Move the contract into code both sides import: a type, a schema, or a constant.

~~~ts
// contracts/order-placed.ts
export const ORDER_PLACED = "order.placed";
export interface OrderPlaced { orderId: string; totalCents: number }
~~~

3. Validate at the boundary with the shared schema, so a mismatch fails fast.
4. If the two components change together for every feature, consider merging them.

## Architect signals

Architect reads git history and reports component pairs that changed together often, above the support and confidence thresholds in `settings.history`, while neither imports the other. These are informational findings: `architect check --verbose` lists them, and `architect context` shows the change partners of the files a task touches. After the fix, the pair shows an import edge to the shared contract and the finding disappears. An api-stability rule on the contracts component makes future changes to the shared shape visible in `architect diff`, and a decision can record which component owns the contract.
