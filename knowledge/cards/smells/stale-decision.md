---
id: stale-decision
kind: smell
title: "Stale decision"
summary: "An accepted decision whose assumptions are past their review date, or whose governed paths no longer exist, still steers the code."
problem: "Decisions are written for the facts of their time; when nobody revisits them, agents and reviewers keep enforcing a choice whose reasons may have expired, or trust a record that describes code that is gone."
forces:
  - "Reviewing old decisions is nobody's job, and the code still builds."
  - "Rewriting a decision feels heavier than leaving it."
  - "A decision can stay right long after its review date."
use_when:
  - "A change is about to touch the paths the decision governs."
  - "An assumption in the decision is plainly false today, such as a traffic level or a vendor."
  - "The decision governs a path that was renamed or deleted."
avoid_when:
  - "The decision still holds; renew it by moving the review date and noting why."
  - "The component it governs is itself about to be removed with a decision of its own."
tradeoffs:
  - "Frequent review dates keep decisions honest but create routine work."
  - "No review dates means no work and no warning when facts change."
code_signals:
  - "finding:stale-decision"
  - "An accepted decision whose governs list names a folder that no longer exists."
  - "An assumption with a review_by date in the past."
  - "Code comments that say a rule no longer makes sense while the rule stays in place."
contract_templates: []
related: [assumptions-with-checks, retrieve-decisions-first, superseded-dependency, respect-rejected-alternatives]
sources:
  - title: "Documenting Architecture Decisions (Nygard, 2011)"
    url: "https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "MADR: Markdown Architectural Decision Records"
    url: "https://adr.github.io/madr/"
    retrieved: "2026-09-26"
    license: none
    relation: see-also
---

# Stale decision

## Symptoms

Decision 0007 says "keep search in the monolith because we serve under 50 requests per second" and set a review date for last March. Traffic is now ten times higher. Another decision governs `src/legacy-billing/**`, which was deleted in a cleanup. Both are still `accepted`, so `architect context` hands them to every agent working nearby, and reviewers cite them in comments. Nobody has read them in a year.

## Why it hurts

A decision record has authority. If its reasons expired, that authority now points the wrong way: agents refuse a sound change because an old decision forbids it, or keep a rule whose cost no longer buys anything. Records that govern deleted paths teach readers that decisions describe nothing real, and then they skip the ones that matter. The damage is slow and quiet, the same way stale documentation hurts.

## How to fix

1. Read the stale decision and its assumptions against today's facts.
2. If it still holds, update the `review_by` date and add a sentence on what you checked.
3. If a governed path moved, point `governs` at the new path or component.
4. If the facts changed, write a new decision that supersedes it. Set the old one to `superseded` and fill `superseded-by`, then update rules that cite it.
5. Where you can, replace a date with a check: an assumption that names a rule id is verified on every run instead of once a year.

## Architect signals

`architect check` reports `stale-decision` for each accepted decision that has an assumption past its `review_by` date, and for each `governs` entry that matches no component and no analyzed file. The findings are informational and never fail a build. `architect decision list` shows statuses, and `architect explain decision:<id>` shows what a decision governs. A related finding flags assumptions whose `check` names a rule that does not exist.
