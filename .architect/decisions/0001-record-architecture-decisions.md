---
status: accepted
date: 2026-09-26
decision-makers: [Gabriel Brument]
governs: ["*"]
evidence:
  - source: docs/plan/v0.1.md
    quote: "Each weakening needs an accepted decision in head that lists it in `weakens`."
---

# Record architecture decisions

## Context and Problem Statement

Architect exists so that design intent survives across agent sessions. Its own design needs the same treatment: rules without recorded reasons get deleted by the first change they inconvenience.

## Considered Options

* Record decisions as MADR 4.0 files in .architect/decisions, linked from rules through `because`
* Keep design notes in the README
* Keep no written decisions and rely on code review

## Decision Outcome

Chosen option: "MADR files in .architect/decisions", because rules can cite them, CI can require them when a rule loosens, and agents can retrieve them before editing.

### Consequences

* Good, because every error-level rule names the decision that justifies it.
* Good, because loosening a rule requires a new accepted decision that lists it in `weakens`.
* Bad, because writing a decision costs time on each structural change.

### Confirmation

`architect check` rejects error-level rules without `because`, and `architect ci` reports unapproved weakenings.
