---
status: accepted
date: 2026-09-26
decision-makers: [Gabriel Brument]
governs: [knowledge]
evidence:
  - source: docs/plan/v0.1.md
    quote: "Adaptations of CC BY 4.0 material go in `packs/cc-by/` with its own LICENSE and NOTICE."
  - source: docs/plan/v0.1.md
    quote: "CC BY-SA and unlicensed sources are `see-also` only."
---

# Knowledge card licensing

## Context and Problem Statement

Knowledge cards summarize architecture principles, smells, and patterns. Good source material comes under many licenses, and the package itself is MIT.

## Considered Options

* Original MIT cards; MIT and CC0 sources may be adapted; CC BY adaptations in a separate pack; CC BY-SA and unlicensed sources linked only
* Copy source text freely with attribution
* Link only, never adapt

## Decision Outcome

Chosen option: "Original MIT cards with a separate CC BY pack", because it keeps the package MIT while still crediting and reusing permissive sources.

### Consequences

* Good, because every card states its sources, licenses, and relation in front matter.
* Bad, because cards drawn from CC BY-SA material must be written from scratch.

### Confirmation

The card license lint in `bun run check` rejects adapted text from sources whose license does not allow it in that location.
