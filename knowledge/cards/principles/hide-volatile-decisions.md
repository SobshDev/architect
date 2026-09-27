---
id: hide-volatile-decisions
kind: principle
title: "Hide each volatile decision behind one module"
summary: "When a vendor, format, or policy could change, exactly one component should know it."
problem: "A choice that is likely to change, such as a payment vendor or a file format, leaks into many modules, so changing it later means editing and retesting code across the system."
forces:
  - "Hiding a choice needs an interface, which costs design effort now."
  - "Nobody can predict every change; hiding everything creates needless layers."
  - "Vendor SDKs are convenient to call directly from wherever they are needed."
use_when:
  - "Adding a dependency on an external vendor, SDK, or service."
  - "Choosing a storage engine, wire format, or schema version."
  - "Encoding a business policy such as pricing, tax, or eligibility that the business expects to change."
avoid_when:
  - "The choice is stable for the life of the system, such as the language's standard library."
  - "Only one module will ever use it and it is already private to that module."
tradeoffs:
  - "One more interface to maintain, in exchange for changes that stay inside one component."
  - "The interface can hide useful vendor features; expose them deliberately when needed."
code_signals:
  - "rule-kind:external-imports"
  - "rule-kind:entrypoints"
  - "finding:hidden-change-coupling"
  - "The same vendor package imported from several components."
  - "Vendor error types or response shapes appearing in callers' code."
  - "A format or policy constant duplicated in more than one component."
contract_templates:
  - |
    id: stripe-only-in-payments
    kind: external-imports
    packages: [stripe]
    allow_from: ["path:src/payments/stripe/**"]
    because: ["0005"]
  - |
    id: payments-public-surface
    kind: entrypoints
    targets: [payments]
    because: ["0005"]
related: [deep-modules, coupling-at-short-distance, ports-and-adapters, anti-corruption-layer, scattered-functionality, boundary-bypass]
sources:
  - title: "On the Criteria To Be Used in Decomposing Systems into Modules (Parnas, 1972)"
    url: "https://doi.org/10.1145/361598.361623"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
  - title: "A Philosophy of Software Design (Ousterhout)"
    url: "https://web.stanford.edu/~ouster/cgi-bin/aposd.php"
    retrieved: "2026-09-26"
    license: proprietary
    relation: see-also
---

# Hide each volatile decision behind one module

## Why

Parnas argued that modules should be drawn around design decisions likely to change, not around the steps of a process. If a decision is known by one module, changing it touches one module. If it is spread over ten, every change is a project. Vendors get replaced, formats get new versions, and policies change with the business. These are the decisions worth hiding.

## In practice

1. List what could change: vendors and SDKs, data formats, storage, business policies. Ask the team which ones they expect to change; do not guess from folder names.
2. For each, ask how many files would change today if it did. More than one component is a warning sign.
3. Give the decision one home. In TypeScript, put the Stripe client in `src/payments/stripe/` behind a `PaymentGateway` interface exported from `src/payments/index.ts`. In Python, keep `boto3` calls in `storage/s3_adapter.py` and expose plain functions or a protocol class.
4. Make the interface speak your domain: return your own types and errors, not the vendor's.
5. Encode it. An `external-imports` rule with `packages` and `allow_from` confines the SDK to the adapter. An `entrypoints` rule keeps callers on the public surface.
6. Record the choice as a decision, and list the rules as checks for its assumptions.

## Checks

- For each volatile choice, you can name the one component that knows it.
- `architect check --all` passes the rules that confine the vendor package.
- No vendor type appears in the signatures of exports at other components' entrypoints.
- Hidden change coupling between components does not point at a duplicated format or policy.
