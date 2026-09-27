---
id: god-component
kind: smell
title: "God component"
summary: "One component holds a large share of the codebase's files and lines, so it mixes many responsibilities and most changes land in it."
problem: "A component that owns most of the code cannot hide anything from itself. Unrelated features share files and helpers, boundaries inside it are invisible to rules, and its size makes it hard to understand, test, and review."
forces:
  - "Adding code to the big component is always the easy path because everything is already there."
  - "Splitting it takes planning and touches many files."
  - "A single component is simple to configure when a project is young."
use_when:
  - "Several teams or features change the component for unrelated reasons."
  - "Rules cannot express the boundaries you care about because they all sit inside one component."
  - "It is also a hotspot or a hub."
avoid_when:
  - "The project is small or early and one component honestly describes it."
  - "The component is large but cohesive, such as generated code or one well-bounded engine."
tradeoffs:
  - "More components means more boundaries, entry points, and rules to maintain."
  - "A split along the wrong lines creates hidden change coupling between the new pieces."
code_signals:
  - "finding:god-component"
  - "One folder holds more than a third of the files and lines of the project."
  - "Unrelated features share helper files inside the same component."
  - "Most commits touch it, whatever the feature."
contract_templates:
  - |
    id: split-pieces-independent
    kind: independent
    level: warn
    description: The feature components carved out of the old app component do not import each other.
    members: [orders, invoicing, shipping]
  - |
    id: split-pieces-public-surfaces
    kind: entrypoints
    level: warn
    description: The new components are used only through their entry points.
    targets: [orders, invoicing, shipping]
related: [hub-component, history-before-restructuring, modular-monolith, scattered-functionality, hotspot]
sources:
  - title: "Refactoring for Software Architecture Smells (Samarthyam, Suryanarayana, Sharma, 2016)"
    url: "https://doi.org/10.1145/2975945.2975946"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Balancing Coupling in Software Design (Vlad Khononov)"
    url: "https://www.informit.com/store/balancing-coupling-in-software-design-universal-design-9780137353521"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "Domain-Driven Design (Eric Evans)"
    url: "https://www.informit.com/store/domain-driven-design-tackling-complexity-in-the-heart-9780321125217"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# God component

## Symptoms

One component, often called `app`, `server`, or `src`, holds most of the files. Features like orders, invoices, and shipping live side by side and import each other's internals freely. The component graph looks small and clean because the real dependencies are inside one box. Most commits touch it, and many people edit it for different reasons.

## Why it hurts

Rules only see edges between components, so everything inside the god component is unchecked. Features couple to each other without anyone noticing, and a change to one breaks another. Tests are hard to scope, so the whole suite runs on every change. Reviewers cannot tell from a path which feature a file belongs to, and merge conflicts rise as more people work in the same files.

## How to fix

Split by reason for change, guided by history.

1. Read the change coupling: files that change together belong together. Clusters from `architect init` and hidden change coupling findings are a good start.
2. Declare the new components in `architecture.yaml` for folders that already exist, even before moving code. This alone makes their edges visible.
3. Add `independent` and `entrypoints` rules at warn and baseline current violations.
4. Move code and fix imports feature by feature, letting the baseline shrink.
5. Keep shared pieces small; do not replace one god component with a new `shared` one.

~~~yaml
components:
  - id: orders
    paths: ["src/orders/**"]
  - id: invoicing
    paths: ["src/invoicing/**"]
~~~

## Architect signals

Architect reports `god-component` when a component holds more than 30 percent of both the files and the lines, in a project with at least four components. It is informational; see it with `architect check --verbose`. Look for the same component in hotspot and hub findings. Once split, `independent` and `entrypoints` rules on the new pieces keep the boundaries, and a decision records why the split lines were chosen.
