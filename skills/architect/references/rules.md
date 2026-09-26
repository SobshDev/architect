# Rules reference

Contents: files and selectors · rule fields · the ten rule kinds · waivers · the baseline · weakening and approval.

## Files and selectors

`architecture.yaml` maps files to components. Each file belongs to the first component, in file order, whose `paths` globs match it. `entrypoints` are the globs other components may import. `resources` name stored state and its owner.

```yaml
version: 1
components:
  - id: domain
    paths: ["src/domain/**"]
    entrypoints: ["src/domain/index.ts"]
  - id: billing
    paths: ["src/billing/**"]
    entrypoints: ["src/billing/index.ts"]
    owner: "@payments-team"
  - id: infra
    paths: ["src/infra/**"]
  - id: legacy-api
    paths: ["src/legacy/**"]
    deprecated:
      reason: Replaced by the v2 HTTP layer.
      replacement: http
  - id: http
    paths: ["src/http/**"]
resources:
  - id: invoices
    owner: billing
    writes:
      - preset: drizzle
settings:
  exclude: ["**/*.test.ts"]
  adr_dirs: ["docs/adr"]
```

A selector picks one side of an edge:

| Selector | Matches |
|---|---|
| `billing` | files of the component with that id |
| `path:src/**/generated/**` | internal files matching the glob |
| `pkg:lodash`, `pkg:@aws-sdk/*` | packages by name glob (external or workspace) |
| `*` | every internal file |

Prefer component ids. Use `path:` for a slice inside a component and `pkg:` for third party code.

## Fields every rule has

- `id`: lowercase, unique, stable. Findings, waivers, baseline entries, and decisions refer to it.
- `kind`: one of the ten kinds below.
- `level`: `error` (default; fails check and CI), `warn` (reported, never fails), or `off`.
- `because`: decision ids that justify the rule. Required at `error`. Cite the decision that made the design choice, not a generic one.
- `include_type_imports`: default `true`. Set `false` only when type-only imports carry no runtime or design coupling for this rule; turning it off later counts as weakening.
- `description`: optional one line for humans.

Start new rules on existing code at `warn`, baseline what they find, then raise them to `error` once a human accepts the cited decision.

## Rule kinds

### forbid

The `from` side must not depend on the `to` side. Use it for one specific banned edge.

```yaml
rules:
  - id: domain-not-infra
    kind: forbid
    from: [domain]
    to: [infra, "pkg:pg"]
    because: ["0003"]
```

### allow-only

The `from` side may depend only on its own component and the listed targets. With `scope: all`, external packages must also appear as `pkg:` selectors in `to`. Use it for a core that should stay small and pure.

```yaml
rules:
  - id: domain-dependencies
    kind: allow-only
    from: [domain]
    to: ["pkg:zod"]
    scope: all
    because: ["0003"]
```

### layers

Highest layer first. A layer may depend on layers after it, never on layers before it. A list groups peers in one layer. With `allow_skip: false`, a layer may use only the layer directly below it. Use it for the main dependency direction of the system.

```yaml
rules:
  - id: layering
    kind: layers
    layers:
      - http
      - [billing, catalog]
      - domain
    allow_skip: true
    because: ["0002"]
```

Peers in one layer may still import each other; add `independent` to forbid that.

### acyclic

No dependency cycles. `scope: components` (default) or `files`; `within` limits the check to some selectors. Use it everywhere; cycles make change order unpredictable.

```yaml
rules:
  - id: no-cycles
    kind: acyclic
    because: ["0002"]
  - id: no-file-cycles-in-domain
    kind: acyclic
    scope: files
    within: [domain]
    level: warn
```

### independent

The members must not depend on each other in any direction. Use it for sibling features, plugins, or bounded contexts.

```yaml
rules:
  - id: features-independent
    kind: independent
    members: [billing, catalog, shipping]
    because: ["0004"]
```

### entrypoints

Other components may import the `targets` only through their entrypoints (from `architecture.yaml`, or `entrypoints` on the rule to override). Use it to keep internals private.

```yaml
rules:
  - id: public-surfaces
    kind: entrypoints
    targets: [domain, billing]
    because: ["0002"]
```

### external-imports

Two forms. Form 1 restricts what `from` may import with `allow` or `forbid` lists of package name globs, written without the `pkg:` prefix. Form 2 restricts which code may import `packages` with `allow_from` (an empty list means nobody). Built-ins (`node:*`, `bun:*`, Python stdlib) pass unless `allow_builtins: false`. Use form 2 to confine a vendor SDK to one adapter.

```yaml
rules:
  - id: stripe-only-in-billing
    kind: external-imports
    packages: [stripe]
    allow_from: ["path:src/billing/stripe/**"]
    because: ["0005"]
  - id: domain-no-network-clients
    kind: external-imports
    from: [domain]
    forbid: [axios, "@aws-sdk/*"]
    level: warn
```

Do not mix the forms in one rule.

### state-owner

Only the owner component in `resources` writes a resource. Detection uses write matchers (presets for Convex, Prisma, Drizzle, raw SQL, SQLAlchemy, Django, or a `pattern` regex), so findings are heuristic and the level defaults to `warn`.

```yaml
rules:
  - id: invoice-writes
    kind: state-owner
    resources: [invoices]
    because: ["0006"]
```

### api-stability

Diff mode only. Reports removed or changed exports at the components' entrypoints; with `allow_growth: false`, new exports are warnings too. Use it for modules other teams or packages consume.

```yaml
rules:
  - id: domain-api
    kind: api-stability
    components: [domain]
    allow_growth: false
    because: ["0007"]
```

### deprecated

Diff mode only. The components (default: those marked `deprecated` in `architecture.yaml`) must not gain new dependents. Existing dependents are reported, not failed.

```yaml
rules:
  - id: no-new-legacy-users
    kind: deprecated
    because: ["0008"]
```

## Waivers

A waiver accepts findings of one rule between a `from` selector and an optional `to` selector, for a limited time. It needs a `reason` and an `expires` date at most 180 days after the day the rules load; expired waivers stop applying and produce a warning. Link the decision that approved it.

```yaml
rules:
  - id: domain-not-infra
    kind: forbid
    from: [domain]
    to: [infra]
    because: ["0003"]
waivers:
  - rule: domain-not-infra
    from: "path:src/domain/reports/**"
    to: infra
    reason: Report export reads the warehouse client directly until the reporting port lands.
    expires: "2027-02-01"
    decision: "0009"
```

Prefer a waiver over a baseline entry when the exception is new and deliberate, since it expires. Adding a waiver is weakening: it needs a decision.

## The baseline

`baseline.json` holds fingerprints of accepted existing violations, each with a count. A fingerprint hashes the rule, source file, target, and edge kind (for cycles, the rule and the sorted members), never line numbers, so moving code does not break matches. Findings that match are `baselined` and never fail a run.

- `architect status` shows what remains.
- `architect baseline update` rewrites it from current findings and only shrinks it.
- `architect baseline update --allow-grow` may add entries. Growth counts as weakening for any rule base already enforced.

Never edit `baseline.json` by hand.

## Weakening and approval

`architect diff` and `architect ci` compare the contract at base and head. Weakening is detected two ways:

- Syntactic: a rule removed, a level lowered, a selector narrowed or a rule otherwise loosened, `include_type_imports` turned off, a waiver added, or the baseline grown.
- Semantic: base rules find violations on the head graph that head rules do not.

Each weakening needs an accepted decision in head that lists the rule id in `weakens` (or `baseline` for baseline growth). That decision must be new in this change, or its `weakens` list must have changed since base; an old approval does not cover a new loosening. Without one, the diff reports `unapproved-weakening` at error level and exits 1.

To loosen a rule correctly:

1. Propose a decision that explains why, lists the rule in `weakens`, and cites evidence.
2. Make the rules change in the same change set.
3. Leave the decision proposed; a human accepts it, and CI then shows the weakening as approved.
