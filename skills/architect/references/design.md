# Design reference

Contents: quality attribute scenarios · finding volatile decisions · the heuristics behind the rubric · from decisions to rules.

## Quality attribute scenarios

A quality attribute scenario turns "the system should be maintainable" into something you can test a design against. Write each one with six parts:

| Part | Question |
|---|---|
| Source | Who or what causes the event? |
| Stimulus | What happens? |
| Environment | Under which conditions (normal load, peak, during a deploy, a new developer)? |
| Artifact | Which part of the system is hit? |
| Response | What should the system or team do? |
| Response measure | How do we know it worked (a number, a time, a count of files touched)? |

Example 1, modifiability:

- Source: product team.
- Stimulus: asks to add a second payment provider next to the current one.
- Environment: normal development, one engineer familiar with the codebase.
- Artifact: the billing component.
- Response: the provider is added as a new adapter; checkout, orders, and domain code do not change.
- Response measure: at most one new folder and one wiring change outside it; done within three days.

Example 2, availability:

- Source: the external search index.
- Stimulus: stops responding.
- Environment: peak traffic.
- Artifact: the product listing page.
- Response: listing falls back to the cached catalog and marks results as possibly stale.
- Response measure: listing p95 stays under 800 ms and error rate under 0.5% during the outage.

Rank scenarios with the user by business value and by how hard they are to meet. The top three or four drive the component split; the rest check it. Cite the scenario in each decision's drivers, and name it when a change puts it at risk (rubric 11).

Modifiability scenarios map most directly to structural rules. Performance and availability scenarios usually become decisions about where caches, timeouts, and queues live, which in turn become ownership and dependency rules.

## Finding volatile decisions

List the things likely to change within the life of the system, then ask for each one how many files would change today if it did.

- External vendors and SDKs (payments, email, search, model providers).
- Data formats and protocols (wire formats, file formats, schema versions).
- Business policies (pricing, tax, eligibility, permissions).
- Storage and infrastructure choices (database, queue, cache).
- User interface technology and platform APIs.

Each item that touches more than one component is a candidate for its own module. Ask the user which ones they expect to change; do not guess volatility from folder names alone.

## The heuristics behind the rubric

**Information hiding** (rubric 2). Draw boundaries around decisions that might change, not around steps in a process. A module that hides "which tax vendor we use" survives a vendor switch; a module named "step 3: compute tax" leaks the vendor to every caller that handles its errors or formats. Test a boundary by asking: if this decision changed, which modules would I edit? The answer should be one.

**Deep modules** (rubric 3). A module is deep when its interface is small compared with the work it does. Signs of a shallow module: most functions forward to one other module, callers must call several functions in a fixed order, or the interface exposes the storage shape. Merge shallow layers into their callers or their dependency; split a module only when its parts hide different decisions.

**Coupling and cohesion** (rubric 4). Coupling is fine when it is short: two files in one component can share types and details freely. Across components, coupling should be weak (a narrow interface, data passed by value, events) and stable. When strong coupling crosses a long distance, either move the code together or put a narrow interface in between. Measure distance by component boundaries, teams, and deploy units.

**Change history** (rubric 5). The code shows what depends on what; history shows what changes together. Before splitting or merging, look at co-change: files that repeatedly change in the same commits belong in the same component even when no import connects them, and a component whose halves never change together can be split. Use `git log --follow` on the files, and the change partners in `architect context`. Hidden change coupling (co-change with no import) often means a duplicated rule or format that should have one owner.

**Single ownership of state** (rubric 6). Each table, collection, file, or cache has one component that writes it. Others read through that component or subscribe to its events. Two writers mean two places where an invariant can break.

**Promises at the boundary** (rubric 7). Anything another component, package, or user can observe is a promise: exports at entrypoints, HTTP and event payloads, CLI output, file formats. Changing it needs a decision, a deprecation, and a migration path. Keep the promised surface small so fewer changes need this.

**Direction** (rubric 8). Dependencies point from volatile, specific code toward stable, general code. When a lower layer needs something from a higher one, define an interface in the lower layer and let the higher one implement it. Cycles mean neither side can change or be tested alone.

## From decisions to rules

Each accepted structural decision should end up as at least one rule that fails when the decision is violated. Use the decision's outcome to pick the rule kind:

| Decision says | Rule kind |
|---|---|
| "X must not use Y" | `forbid` |
| "X may use only A and B" | `allow-only` |
| "Code flows from top to bottom in these tiers" | `layers`, plus `acyclic` |
| "These features stay separate" | `independent` |
| "Other modules use X only through its public API" | `entrypoints` on X |
| "Only the adapter talks to vendor V" | `external-imports` with `packages` and `allow_from` |
| "Only X writes table T" | `state-owner` with a resource owned by X |
| "X's API is a promise to consumers" | `api-stability` |
| "Stop building on X" | `deprecated` on X |

Steps:

1. Write or update the components in `architecture.yaml` so each rule can name components rather than paths.
2. Add the rule with `because` citing the decision id. Name the rule after the constraint (`domain-not-infra`), not the decision number.
3. Start at `warn` if the code does not yet comply, run `architect check --all`, and look at every finding: a finding the decision did not intend means the selectors are wrong, so fix them before going further.
4. When the findings are the intended ones, freeze them with `architect baseline update` and raise the rule to `error` once a human accepts the decision.
5. Add each assumption that a rule now enforces as `check: <rule id>` in the decision.

Some decisions cannot be checked structurally (a naming convention, a runtime timeout). Keep those as decisions with a `review_by` assumption and mention them in context; do not invent a loose rule that passes everything.
