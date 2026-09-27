---
id: shallow-module
kind: smell
title: "Shallow module"
summary: "A component whose interface is about as large as its implementation, so it adds a name to learn and a hop to follow without hiding anything."
problem: "Thin wrappers and pass-through layers multiply interfaces while leaving all the complexity visible, so callers pay the cost of the layer without getting any of the benefit."
forces:
  - "Layers feel like good structure, and small files look tidy."
  - "A wrapper can be a cheap place to add logging or a seam for tests."
  - "Merging layers makes the remaining module larger."
use_when:
  - "Most exports forward to one function in another component with the same arguments."
  - "A change to one feature needs edits in three layers that each rename the same call."
  - "Callers must call several functions in a fixed order to get one result."
avoid_when:
  - "The layer hides a volatile choice, such as a vendor SDK, behind an interface the core owns."
  - "The layer marks a real boundary: a package others install, a deploy unit, or a team."
tradeoffs:
  - "Merging removes indirection but makes one module bigger, which needs its own internal structure."
  - "A deeper interface takes more thought to design than a one-to-one wrapper."
code_signals:
  - "Entrypoint functions whose bodies are a single call to another component."
  - "A service class that mirrors every method of a repository one for one."
  - "Classes named Manager, Helper, or Wrapper with no state and no rules of their own."
  - "A change that edits the same signature in several stacked layers."
contract_templates: []
related: [deep-modules, hide-volatile-decisions, god-component, ports-and-adapters]
sources:
  - title: "A Philosophy of Software Design (Ousterhout)"
    url: "https://web.stanford.edu/~ouster/cgi-bin/aposd.php"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "On the Criteria To Be Used in Decomposing Systems into Modules (Parnas, 1972)"
    url: "https://doi.org/10.1145/361598.361623"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Shallow module

## Symptoms

Open a component's entrypoint and most exports are one line long. `UserService.getUser(id)` calls `UserRepository.getUser(id)`, and `updateUser` does the same. A controller calls a service that calls a manager that calls the database client, and each layer has the same method names. Adding a field to a user touches four files and changes no behavior in three of them. Callers still need to know the details the layers were meant to hide, such as which calls to make first.

## Why it hurts

Every module has a cost: a name, an interface, a file to open while reading. A deep module pays that cost back by hiding work. A shallow one does not, so the total complexity goes up. Changes spread across the stack because each layer repeats the same signature. Reviews grow with no gain in safety. Tests of a pass-through layer mostly check that one mock was called, which catches nothing.

## How to fix

1. List the exports of the suspect layer and mark which ones do real work: validation, defaults, retries, a translation of terms.
2. For each export that only forwards, point its callers at the target and delete it.
3. If nothing real is left, fold the layer into its caller or its dependency.
4. Where callers follow a fixed ritual, replace it with one call that states the intent.

~~~python
# Before: callers run tokenize, embed, and store in order.
# After: one call, and the steps become private.
def index_document(doc: Document) -> None:
    _store(_embed(_tokenize(doc.text)), doc.id)
~~~

5. Keep a layer that hides a volatile decision, even if it is thin today.

## Architect signals

Architect has no finding for shallowness, so this smell is found by reading. `architect graph` shows chains of components that each have one dependent and one dependency, which is a good place to look. `architect diff` lists API changes; a change that adds the same export to several stacked components points to pass-through layers. After merging layers, declare the new entrypoints so the surface stays small.
