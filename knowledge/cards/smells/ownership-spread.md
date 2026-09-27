---
id: ownership-spread
kind: smell
title: "Ownership spread"
summary: "A component is changed by many people from many teams, and nobody is its clear owner."
problem: "When a component has no owner and a long tail of occasional authors, nobody holds its design in their head, so its boundaries erode and its defects rise."
forces:
  - "Open contribution lets anyone fix what they need."
  - "Assigning an owner creates a review bottleneck and a single point of knowledge."
  - "Team boundaries change faster than code boundaries."
use_when:
  - "A component's recent commits come from many authors who each made only a few changes."
  - "Review requests for the component sit unanswered or get approved by whoever is free."
  - "The component is also a hotspot or shows hidden change coupling."
avoid_when:
  - "The component is small and stable, so wide authorship reflects rare, simple edits."
  - "It is a deliberately shared kernel with an agreed review process."
tradeoffs:
  - "A named owner gives consistent design but can slow other teams down."
  - "Splitting a component along team lines can fix ownership but adds a boundary that needs its own interface."
code_signals:
  - "Many authors across a component in the last year, with no one above a small share of the commits."
  - "No owner field for the component in architecture.yaml."
  - "CODEOWNERS entries that point to a whole organization or are missing for the folder."
  - "Commit messages from several teams that each add their own special case."
contract_templates: []
related: [hotspot, god-component, scattered-functionality, history-before-restructuring]
sources:
  - title: "Don't Touch My Code! Examining the Effects of Ownership on Software Quality (Bird, Nagappan, Murphy, Gall, Devanbu, 2011)"
    url: "https://doi.org/10.1145/2025113.2025119"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "How Do Committees Invent? (Conway, 1968)"
    url: "https://www.melconway.com/Home/Committees_Paper.html"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Your Code as a Crime Scene, 2nd Edition (Tornhill)"
    url: "https://pragprog.com/titles/atcrime2/your-code-as-a-crime-scene-second-edition/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Ownership spread

## Symptoms

Run `git shortlog -sn --since=12.months -- src/shared/` and you get thirty names, the top one with a tenth of the commits. The component has no `owner` in `architecture.yaml`, and CODEOWNERS either skips it or lists everyone. Each team that touches it adds a flag or a branch for its own case. Nobody can say what the component is for in one sentence, and its design history lives in closed pull requests nobody reads.

## Why it hurts

Code with many minor contributors tends to have more defects, because each author knows only their corner. Design decisions go unmade: nobody refuses a special case, so the component grows into a god component. Reviews are shallow because reviewers lack context. When something breaks, on-call has nobody to page. Knowledge also leaks out as people move on, since no one person collects it.

## How to fix

1. Measure first. Count authors and commit shares per component over the history window, and check whether the component is a hotspot.
2. Name an owner in `architecture.yaml` and in CODEOWNERS, even a provisional one. An owner reviews changes and keeps the design; they do not write every line.
3. Look at why different teams edit it. If each team edits its own part, split the component along those lines so each part has one team.
4. If it is a shared kernel on purpose, record that in a decision and add rules that keep it small, such as an `entrypoints` rule and `api-stability` with `allow_growth: false`.

## Architect signals

Architect has no ownership finding, so check this by hand. `architect explain component:<id>` shows whether an owner is declared. Hotspot and hidden change coupling findings often point to the same components, and a hotspot with no owner is the first one to fix. Once an owner exists, decisions that govern the component should list them as a decision maker.
