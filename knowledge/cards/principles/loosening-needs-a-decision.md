---
id: loosening-needs-a-decision
kind: principle
title: "Loosening a rule needs its own decision"
summary: "Removing, lowering, narrowing, or waiving a rule, or growing the baseline, needs a decision that lists the rule in weakens and that a human accepts."
problem: "Rules erode one convenient edit at a time: a level lowered to pass CI, a waiver added, a baseline regenerated, until the checks no longer protect the design."
forces:
  - "The fastest way to a green build is often to edit the rule."
  - "Some rules are wrong for a case and should change."
  - "Agents and developers under time pressure see the rule as the obstacle."
use_when:
  - "A change edits rules.yaml, architecture.yaml, waivers, or baseline.json."
  - "A finding blocks a change and the rule seems wrong for this case."
  - "Adding a waiver for a deliberate, temporary exception."
avoid_when:
  - "The change tightens rules only, such as adding a rule or raising a level; that needs no weakening approval."
tradeoffs:
  - "Every loosening costs a written decision and a human review."
  - "Waivers expire, so temporary exceptions need follow-up, which is the point."
code_signals:
  - "finding:unapproved-weakening"
  - "finding:contract-changed"
  - "A diff that lowers a rule level, removes a selector, or adds a waiver."
  - "baseline.json growing in a change that also adds features."
  - "Workarounds such as dynamic imports or copied code next to a rule's boundary."
contract_templates: []
related: [behavior-is-a-promise, respect-rejected-alternatives, assumptions-with-checks, retrieve-decisions-first]
sources:
  - title: "Documenting Architecture Decisions (Nygard, 2011)"
    url: "https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Building Evolutionary Architectures, 2nd Edition (Ford, Parsons, Kua, Sadalage)"
    url: "https://www.oreilly.com/library/view/building-evolutionary-architectures/9781492097532/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Loosening a rule needs its own decision

## Why

Rules are how decisions stay true in code. If they can be loosened as easily as code is written, they only record what the code already does. Nygard's case for decision records is that the reasons behind architecture must stay visible. A loosening is a design change like any other, so it deserves the same record. Evolutionary architecture treats such checks as fitness functions: they guide change only while they are kept honest.

## In practice

1. When a finding blocks you, fix the code first: move it, import through the entrypoint, invert the dependency, or call the owning component.
2. If the rule itself is wrong for the case, leave the code consistent with the rule. Propose a decision with `architect decision new "<title>" --weakens <rule-id>` explaining why, with evidence.
3. Make the rules change in the same change set: a narrower selector, a lower level, or a waiver with a reason, an expiry, and the decision id. Prefer a waiver for a new, deliberate exception, since it expires.
4. Leave the decision proposed. A human accepts it; only then does `architect diff` show the weakening as approved.
5. Never edit `baseline.json` by hand or pass `--allow-grow` without an accepted decision listing `baseline` in `weakens`.
6. Do not route around a rule with dynamic imports, renamed paths, or copied code.

## Checks

- `architect diff --base <main>` reports no unapproved weakening.
- Each waiver names a decision and an expiry date.
- The baseline only shrinks, except in changes with an approving decision.
- Every contract file change in a diff is explained by the change description or a decision.
