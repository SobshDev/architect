---
id: history-before-restructuring
kind: principle
title: "Check change history before splitting or merging"
summary: "Before moving code between components, look at which files change together and where change concentrates."
problem: "Restructuring based only on the import graph or folder names can split code that always changes together, or leave together code that never does."
forces:
  - "History reflects the past, and the reason for past co-change may be gone."
  - "Large sweeping commits create false co-change."
  - "Reading history takes time that a quick refactor does not budget for."
use_when:
  - "Planning to split, merge, or move a component."
  - "Choosing which area to refactor first."
  - "A module feels hard to change but its imports look clean."
avoid_when:
  - "The repository has little history, such as a new project or a fresh import from another VCS."
  - "The restructuring is required by an accepted decision whatever the history shows."
tradeoffs:
  - "History is noisy; thresholds on support and confidence trade missed pairs for false ones."
  - "Hotspot ranking favors large, busy files, which are not always the riskiest."
code_signals:
  - "finding:hidden-change-coupling"
  - "finding:hotspot"
  - "Files in different components that appear in the same commits repeatedly."
  - "A file with both high churn and large size."
  - "Many authors changing the same small area."
contract_templates: []
related: [coupling-at-short-distance, hotspot, hidden-change-coupling, ownership-spread]
sources:
  - title: "Your Code as a Crime Scene, Second Edition (Tornhill)"
    url: "https://pragprog.com/titles/atcrime2/your-code-as-a-crime-scene-second-edition/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Check change history before splitting or merging

## Why

The import graph shows what depends on what. History shows what changes together, which is what the structure has to serve. Tornhill treats version control as a record of behavior: files that keep changing in the same commits share a reason to change, whether or not one imports the other. Hotspots, where churn meets size, show where effort goes. A restructuring that ignores both can make future changes harder.

## In practice

1. Before splitting or merging, run `architect context <paths>` and read the change partners it lists for those files.
2. Run `architect check --all` and read hidden change coupling and hotspot findings. They come from `git log` over recent months, skip very large commits, and require a minimum support and confidence.
3. For detail, read `git log --follow -- <file>` and look at why the partner files changed. Shared reasons suggest one component; unrelated reasons suggest the pairing is incidental.
4. Group files that change together into the same component. Split a component whose halves never change together.
5. A pair with no import that always changes together often hides a duplicated format or rule. Give it one owner instead of moving whole files.
6. Start refactoring at hotspots that also break rules; they pay back fastest.

## Checks

- The plan for a split or merge cites the co-change evidence it relied on.
- After the change, hidden change coupling across the new boundary goes down, not up.
- Hotspots touched by the change are simpler afterwards, or the plan says why not.
