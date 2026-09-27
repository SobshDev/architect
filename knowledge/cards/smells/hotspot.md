---
id: hotspot
kind: smell
title: "Hotspot"
summary: "A large file that also changes often concentrates risk, so its defects and review cost dominate the codebase."
problem: "Most maintenance effort and many defects gather in a small set of big, busy files, and every change there risks breaking something unrelated."
forces:
  - "Adding to an existing file is easier than finding or creating the right home."
  - "Busy files attract more code because everything relevant is already there."
  - "Splitting a busy file conflicts with the work that keeps it busy."
use_when:
  - "The file is on the path of upcoming work."
  - "Defects or reverts keep landing in the same file."
  - "Merge conflicts in the file slow down parallel work."
avoid_when:
  - "The file is large but stable, or busy but small."
  - "The churn is generated code, a lock file, a changelog, or a data table."
  - "The file is scheduled for removal in a migration already under way."
tradeoffs:
  - "Splitting along reasons for change reduces conflicts and review scope."
  - "A split done without history can cut through code that changes together and make things worse."
  - "Refactoring a busy file competes with feature work for the same lines."
code_signals:
  - "finding:hotspot"
  - "A file of several thousand lines that appears in a large share of recent commits."
  - "Functions with many branches that grow a new case with every feature."
  - "Frequent merge conflicts and reverts on the same path."
contract_templates: []
related: [history-before-restructuring, god-component, hidden-change-coupling, deep-modules]
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

# Hotspot

## Symptoms

One file, often named after the product or the domain (`orders.ts`, `views.py`), is both large and in most pull requests. It has long functions with many branches, a growing list of imports, and a history of fixes. Many contributors touch it, and each knows only part of it. Size alone is not the smell and churn alone is not the smell; the combination is.

## Why it hurts

Change in a busy file has a wide blast radius because the code inside shares state and helpers. Reviews are slow because the diff sits among thousands of unrelated lines. Parallel branches conflict. Defects cluster there, so the file draws more fixes, which add more code. Tests for it tend to be broad and slow, since no smaller unit can be loaded alone.

## How to fix

1. Check history before cutting. Look at which parts of the file change together and which never do.
2. Extract the part that changes most, along its reason for change, into its own module with a narrow interface. Leave a call in the old place.

~~~python
# orders/pricing.py, extracted from orders/views.py
def price_order(order: Order, rules: PriceRules) -> Money:
    ...
~~~

3. Move tests with the extracted code so they run without the rest of the file.
4. Repeat for the next busiest part. Stop when the remaining file is stable.

## Architect signals

Architect scores each file by lines changed in the history window times its current size and reports the top files as informational hotspot findings, listed by `architect check --verbose`. Compare hotspots with hidden change coupling and god component findings: a hotspot inside a god component usually marks the first split. No rule forbids a hotspot. After a split, use entrypoints or allow-only rules to keep the extracted module's interface narrow, and record the split in a decision so later work extends the new module.
