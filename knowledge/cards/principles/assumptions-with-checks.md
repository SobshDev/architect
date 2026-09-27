---
id: assumptions-with-checks
kind: principle
title: "Record new assumptions with checks"
summary: "Each assumption a decision relies on gets a rule that fails when it breaks, or a review date."
problem: "Decisions rest on assumptions about load, vendors, or structure that silently stop being true, and the decision keeps being followed long after its basis is gone."
forces:
  - "Many assumptions cannot be checked structurally."
  - "Review dates get ignored unless something reports them."
  - "Writing down assumptions exposes uncertainty some would rather not show."
use_when:
  - "Writing or reviewing any decision."
  - "A design depends on a limit, a vendor behavior, or a structural property."
  - "Superseding a decision whose assumptions changed."
avoid_when:
  - "The statement is a fact that cannot change within the life of the system."
tradeoffs:
  - "Each checked assumption adds a rule to maintain."
  - "Review dates create periodic work, which is cheaper than acting on a dead assumption."
code_signals:
  - "finding:stale-decision"
  - "finding:superseded-citation"
  - "rule-kind:external-imports"
  - "rule-kind:forbid"
  - "rule-kind:independent"
  - "Decisions with an empty assumptions list that mention limits or vendors."
  - "Assumptions past their review date."
contract_templates:
  - |
    id: stripe-only-in-payments
    kind: external-imports
    packages: [stripe]
    allow_from: ["path:src/payments/stripe/**"]
    because: ["0005"]
related: [loosening-needs-a-decision, name-the-quality-scenario, respect-rejected-alternatives, stale-decision]
sources:
  - title: "Building Evolutionary Architectures, 2nd Edition (Ford, Parsons, Kua, Sadalage)"
    url: "https://www.oreilly.com/library/view/building-evolutionary-architectures/9781492097532/"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "MADR: Markdown Architectural Decision Records"
    url: "https://adr.github.io/madr/"
    retrieved: "2026-09-26"
    license: MIT
    relation: see-also
---

# Record new assumptions with checks

## Why

Every decision is made under assumptions: invoice volume stays below a limit, only one module calls the vendor, two features stay separate. When an assumption breaks, the decision may stop being right, but nothing says so. Evolutionary architecture's answer is to attach automated checks, fitness functions, to the qualities that matter. Architect applies the same idea to decisions: a structural assumption names the rule that keeps it true, and anything else gets a date for someone to look again.

## In practice

1. When writing a decision, list each assumption it depends on as a separate entry in `assumptions`, stated so a reader can tell if it still holds.
2. For a structural assumption, add or reuse a rule and set `check: <rule-id>`. "Only payments calls Stripe" becomes an `external-imports` rule; "catalog never imports billing" becomes `forbid` or `independent`.
3. For anything else, such as load, latency, or vendor pricing, set `review_by` to a date when it should be looked at again.
4. Run `architect decision lint` until it is clean.
5. When `architect check` reports a stale decision, reread its assumptions. If they no longer hold, propose a superseding decision; if they do, propose a new review date.
6. When a check rule fails, treat it as news about the decision, not only about the code.

## Checks

- Every assumption in accepted decisions has a `check` or a `review_by`.
- Every `check` names a rule that exists and cites the decision.
- No decision is past its review date without a proposal to renew or supersede it.
