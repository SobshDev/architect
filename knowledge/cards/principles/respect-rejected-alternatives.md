---
id: respect-rejected-alternatives
kind: principle
title: "Don't bring back a rejected alternative without a new decision"
summary: "Read a decision's considered options before proposing one again, and reopen a rejected option only through a new decision that answers the original reasons."
problem: "Options the team already weighed and turned down come back in new changes, restarting settled debates or quietly undoing a tradeoff without anyone deciding to."
forces:
  - "A rejected option can look obvious to someone who did not see why it lost."
  - "Circumstances change, and an old rejection may no longer hold."
  - "Writing a new decision takes more effort than just coding the option."
use_when:
  - "Proposing a design, library, or pattern for a governed area."
  - "A change adds a dependency or structure that a decision mentions."
  - "Reviewing a change that reverses how something was built."
avoid_when:
  - "No decision governs the area and none mentions the option."
tradeoffs:
  - "Reopening a choice costs a written decision, which slows quick reversals."
  - "Holding to a rejection whose reasons have expired keeps a worse design; the fix is a new decision, not silence."
code_signals:
  - "rule-kind:deprecated"
  - "rule-kind:external-imports"
  - "rule-kind:forbid"
  - "finding:deprecated-dependency"
  - "A new import of a package a decision lists as a rejected option."
  - "A change that reintroduces a structure a superseded decision replaced."
contract_templates:
  - |
    id: no-orm-in-reports
    kind: external-imports
    from: [reports]
    forbid: [sqlalchemy]
    because: ["0009"]
related: [retrieve-decisions-first, loosening-needs-a-decision, assumptions-with-checks, superseded-dependency]
sources:
  - title: "MADR: Markdown Architectural Decision Records"
    url: "https://adr.github.io/madr/"
    retrieved: "2026-09-26"
    license: MIT
    relation: see-also
  - title: "Documenting Architecture Decisions (Nygard, 2011)"
    url: "https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Don't bring back a rejected alternative without a new decision

## Why

MADR asks each decision to list its considered options and the pros and cons of each. That record is how a team avoids having the same argument twice. Nygard's point is similar: without the context, a later developer can only blindly accept a decision or blindly change it. A rejected option is a result, not a gap. Bringing it back without reading why it lost wastes the earlier work and risks the very problems it was rejected for.

## In practice

1. Before proposing a design, run `architect context --task "<topic>"` and `architect decision list`. Read the Considered Options and Pros and Cons of each governing decision, including rejected decisions.
2. If your idea is already listed and lost, find the reasons. Ask whether they still hold: did the load, the vendor, or the team change?
3. If they still hold, choose another design.
4. If they no longer hold, write a new decision with `architect decision new "<title>" --supersedes <id>`. State what changed since the original, answer each original reason with evidence, and keep `status: proposed`.
5. Where a rejection is structural, encode it so it cannot slip back unnoticed: `external-imports` with `forbid` for a rejected library, `forbid` for a rejected edge, or `deprecated` on a component being retired.

## Checks

- Every proposal that revives a rejected option cites the old decision and answers its reasons.
- No change adds a rejected library or structure without a decision in the same change.
- Rules that encode rejections cite the decision that made them.
