---
status: accepted
date: 2026-09-02
governs: [domain]
---

# Keep the domain pure

## Context and Problem Statement

Business rules changed every time the storage layer changed.

## Considered Options

* Ports and adapters: the domain owns interfaces, infra implements them
* Let the domain call the database directly

## Decision Outcome

Chosen option: "Ports and adapters: the domain owns interfaces, infra implements them", because storage can then change without touching business rules.
