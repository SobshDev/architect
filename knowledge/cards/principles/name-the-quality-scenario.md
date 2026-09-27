---
id: name-the-quality-scenario
kind: principle
title: "Name the affected quality scenario and its evidence"
summary: "Say which quality attribute scenario a change serves or risks, and quote the evidence that supports the claim."
problem: "Design arguments about maintainability or performance go in circles because nobody states which concrete situation the design must handle or how success is measured."
forces:
  - "Quality goals like scalable or maintainable sound agreed but mean different things to different people."
  - "Writing scenarios takes time with stakeholders."
  - "Evidence is scattered across docs, code, and history."
use_when:
  - "Designing a new system or component."
  - "Proposing a decision or reviewing one."
  - "A change trades one quality for another, such as speed of delivery against modifiability."
avoid_when:
  - "The change has no structural effect, such as a bug fix inside one function."
tradeoffs:
  - "Scenarios take effort to write and keep ranked."
  - "A measurable response can be wrong; review it when evidence changes."
code_signals:
  - "finding:propagation-cost-rise"
  - "finding:hotspot"
  - "Decisions whose drivers name no scenario or measure."
  - "Review threads that argue about maintainability or scalability in general terms."
  - "A propagation cost rise or a new hotspot in the artifact that a high-ranked scenario names."
contract_templates: []
related: [retrieve-decisions-first, assumptions-with-checks, hide-volatile-decisions, circuit-breaker, bulkhead]
sources:
  - title: "Software Architecture in Practice, 4th Edition (Bass, Clements, Kazman)"
    url: "https://www.informit.com/store/software-architecture-in-practice-9780136886099"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "MADR: Markdown Architectural Decision Records"
    url: "https://adr.github.io/madr/"
    retrieved: "2026-09-26"
    license: MIT
    relation: see-also
---

# Name the affected quality scenario and its evidence

## Why

Bass, Clements, and Kazman write quality requirements as scenarios with six parts: source, stimulus, environment, artifact, response, and response measure. "Maintainable" becomes "a product team adds a second payment provider; only the payments component changes; done in three days." A scenario makes a design testable against a situation. Naming it in a change says what the change is for and what it puts at risk. Quoting evidence keeps the claim honest.

## In practice

1. When designing, write the top scenarios with the team in the six parts and rank them by value and difficulty. The top few drive the component split.
2. When planning a change, name the scenario it serves or risks: "keeps the tax rule change inside billing", or "adds a network call on the checkout path, which risks the p95 latency scenario."
3. Cite the scenario in a decision's drivers, and state which options serve it better.
4. Back claims with verbatim evidence: a line from a doc, code at a commit (`git:<sha>:<path>`), or a URL. Architect's decision lint rejects quotes it cannot find, so copy exactly.
5. Tie structural scenarios to checks. A modifiability scenario about vendors maps to `external-imports` and `entrypoints` rules; a propagation cost rise in `architect diff` is a hint that one is at risk.
6. Performance and availability scenarios usually become decisions about timeouts, caches, and queues, with `review_by` dates when no rule can check them.

## Checks

- Each structural decision names at least one scenario in its drivers.
- Each claim in a proposal has a quote that `architect decision lint` accepts.
- Reviews can point to the scenario a change risks and its measure.
