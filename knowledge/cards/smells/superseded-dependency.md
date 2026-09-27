---
id: superseded-dependency
kind: smell
title: "Dependency on a superseded decision"
summary: "A rule's because list cites a decision that has been superseded, deprecated, or rejected, so the rule rests on a reason the team no longer holds."
problem: "Rules outlive the decisions that justify them; when a decision is replaced and the rules citing it are not updated, the contract enforces the old reasoning and readers follow a link to a choice that no longer stands."
forces:
  - "Superseding a decision is one file edit, but the rules citing it live elsewhere."
  - "The rule may still be right under the new decision, just with a different reason."
  - "Removing the citation drops an error-level rule below its required justification."
use_when:
  - "A decision was just superseded or deprecated."
  - "A reviewer or agent asks why a rule exists and the cited decision says it no longer applies."
  - "The new decision changes what the rule should allow."
avoid_when:
  - "The rule is about to be deleted with a decision that approves the removal."
tradeoffs:
  - "Updating citations right away keeps the contract honest at the cost of one more edit per supersession."
  - "Citing both old and new decisions keeps history but blurs which reason applies."
code_signals:
  - "finding:superseded-citation"
  - "A rule in rules.yaml whose because list names a decision with status superseded."
  - "A new decision that supersedes an old one while no rule cites the new decision."
  - "A rule that cites a rejected decision, which usually means the id is wrong."
contract_templates: []
related: [stale-decision, loosening-needs-a-decision, respect-rejected-alternatives, retrieve-decisions-first]
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

# Dependency on a superseded decision

## Symptoms

The rule `domain-not-infra` says `because: ["0003"]`. Decision 0003 now has `status: superseded` and `superseded-by: 0012`. Nobody updated the rule. An agent asked to explain the rule follows the link, reads 0003, and learns that its reasoning was replaced. Another rule cites a decision that was rejected, because someone copied the wrong id. The rules still run, but the reasons behind them point at the past.

## Why it hurts

A rule is only as trustworthy as its reason. When the reason is retired, readers have two bad choices: follow the old reasoning, or ignore the rule because it looks orphaned. Agents are worse off, since they take the cited text as the current intent. The new decision may also have changed what the rule should allow, so the rule now blocks work the team agreed to or lets through what the team now forbids.

## How to fix

1. Open the replacing decision and read what it says about the rule's subject.
2. If the rule still fits, change `because` to cite the new decision. Nothing else changes.
3. If the new decision loosens the rule, edit the rule and make sure the new decision lists the rule id in `weakens`, so the change is approved rather than flagged.
4. If it tightens the rule, edit the rule and cite the new decision.
5. Make it a habit: when you supersede a decision, search `rules.yaml` for its id in the same change.

## Architect signals

`architect check` reports `superseded-citation` for each rule whose `because` cites a decision with status superseded, deprecated, or rejected, and names the replacement when `superseded-by` is set. The finding is informational. `architect explain rule:<id>` shows the cited decisions and their status. A weakened rule without a matching `weakens` entry shows up as `unapproved-weakening` in `architect diff`.
