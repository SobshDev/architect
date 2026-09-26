---
status: accepted
date: 2026-09-26
decision-makers: [Gabriel Brument]
governs: [diff]
evidence:
  - source: docs/plan/v0.1.md
    quote: "Each weakening needs an accepted decision in head that lists it in `weakens`. Otherwise the finding is `unapproved-weakening` at error level."
  - source: docs/plan/v0.1.md
    quote: "The baseline only shrinks unless `--allow-grow` is passed, and growth counts as weakening."
---

# Approve weakening only with new or changed decisions

## Context and Problem Statement

The plan says a weakening needs an accepted decision in head that lists the rule in weakens. Read literally, a decision accepted a year ago that listed a rule in weakens would approve every later loosening of that rule, and nobody would review the new loosening. Two edge cases also need an answer: baseline growth for a rule that base did not enforce, and approvals of baseline growth that no single rule covers.

## Considered Options

* A decision approves a weakening only when it is new in head, or its weakens list changed since base
* Any accepted decision in head that lists the rule approves the weakening
* Approvals expire after a fixed number of days

## Decision Outcome

Chosen option: "A decision approves a weakening only when it is new in head, or its weakens list changed since base", because the pull request that loosens a rule must then carry the decision that approves it, so reviewers always see the reason next to the change.

Baseline growth counts as weakening only for rules that base enforced (present and not off). Adopting a new rule usually means baselining what it finds on day one, and that loosens nothing. Baseline growth is approved by a decision that lists the rule id or "baseline" in weakens.

### Consequences

* Good, because every loosening appears in the CI summary with its approving decision, in the same pull request.
* Good, because old approvals cannot be reused silently.
* Bad, because loosening the same rule twice needs two decisions, or an edit to the first one's weakens list.
