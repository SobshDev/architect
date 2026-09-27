import { describe, expect, test } from "bun:test";
import type { Card, CardSource } from "../model/index.ts";
import { cardsForFinding, KNOWN_SIGNALS, lintCards, parseCard, parseCorpus, searchCards } from "./index.ts";
import type { CardLintInput } from "./index.ts";

function card(id: string, over: Partial<Card> = {}): Card {
  const kind = over.kind ?? "principle";
  return {
    id,
    kind,
    title: id,
    summary: "summary",
    problem: "problem",
    forces: [],
    use_when: [],
    avoid_when: [],
    tradeoffs: [],
    code_signals: [],
    contract_templates: [],
    related: [],
    sources: [{ url: "https://example.com/book", retrieved: "2026-01-01", license: "proprietary", relation: "see-also" }],
    body: "",
    file: `knowledge/cards/${kind}s/${id}.md`,
    pack: "core",
    ...over,
  };
}

const adapted = (url: string, license: string, changes = "Rewritten."): CardSource => ({
  url,
  retrieved: "2026-01-01",
  license,
  relation: "adapted",
  changes,
});

const corpus = parseCorpus(`
version: 1
repos:
  - { dir: a, url: https://github.com/acme/mit-repo, sha: x, license: MIT, relation: adapted }
  - { dir: b, url: https://github.com/acme/ccby-repo, sha: x, license: CC-BY-4.0, relation: cc-by }
  - { dir: c, url: https://github.com/acme/sa-repo, sha: x, license: CC-BY-SA-4.0, relation: see-also }
`);

function lint(cards: Card[], over: Partial<CardLintInput> = {}) {
  return lintCards({ cards, notice: "", packLicense: null, packNotice: null, corpus, today: "2026-06-01", ...over });
}
const errors = (input: Parameters<typeof lint>) => lint(...input).filter((i) => i.level === "error").map((i) => i.message);

describe("parseCard", () => {
  test("parses front matter and body", () => {
    const c = parseCard(
      "knowledge/cards/principles/x.md",
      "---\nid: x\nkind: principle\ntitle: X\nsummary: S\nproblem: P\nsources:\n  - { url: https://e.com, retrieved: 2026-01-01, license: none, relation: see-also }\n---\n\n# X\n",
      "core",
    );
    expect(c.body).toBe("# X");
    expect(c.use_when).toEqual([]);
    expect(c.pack).toBe("core");
  });
  test("errors name the file", () => {
    expect(() => parseCard("a.md", "no front matter", "core")).toThrow(/^a\.md: missing/);
    expect(() => parseCard("b.md", "---\nid: [\n---\n", "core")).toThrow(/^b\.md: invalid YAML/);
    expect(() => parseCard("c.md", "---\nid: c\nkind: essay\n---\n", "core")).toThrow(/^c\.md: invalid card front matter: .*kind/);
  });
});

describe("lintCards license matrix", () => {
  const cases: [string, Card["pack"], boolean][] = [
    ["MIT", "core", true],
    ["CC0-1.0", "core", true],
    ["CC-BY-4.0", "core", false],
    ["CC-BY-SA-4.0", "core", false],
    ["proprietary", "core", false],
    ["none", "core", false],
    ["CC-BY-4.0", "cc-by", true],
    ["CC0-1.0", "cc-by", true],
    ["CC-BY-SA-4.0", "cc-by", false],
  ];
  for (const [license, pack, ok] of cases) {
    test(`${license} adapted in ${pack}: ${ok ? "allowed" : "rejected"}`, () => {
      const c = card("x", { pack, file: pack === "core" ? "knowledge/cards/principles/x.md" : "packs/cc-by/cards/x.md", sources: [adapted("https://site.org/a/b/c", license)] });
      const all = "https://site.org/a/b";
      const msgs = errors([[c], { notice: all, packLicense: "L", packNotice: all }]);
      expect(msgs.some((m) => m.includes("cannot be adapted"))).toBe(!ok);
    });
  }
  test("see-also sources are never license-checked", () => {
    expect(errors([[card("x", { sources: [{ url: "https://s.org/x", retrieved: "2026-01-01", license: "CC-BY-SA-4.0", relation: "see-also" }] })]])).toEqual([]);
  });
  test("adapted sources must describe changes", () => {
    const c = card("x", { sources: [adapted("https://s.org/x", "CC0-1.0", " ")] });
    expect(errors([[c]])).toEqual(["adapted source https://s.org/x must describe its changes"]);
  });
});

describe("lintCards corpus relations and notices", () => {
  test("see-also corpus repos are never adapted, even under an allowed license", () => {
    const c = card("x", { sources: [adapted("https://github.com/acme/sa-repo/blob/main/x.md", "CC0-1.0")] });
    expect(errors([[c]]).some((m) => m.includes("see-also only"))).toBe(true);
  });
  test("cc-by corpus repos are adapted only in the cc-by pack", () => {
    const src = adapted("https://github.com/acme/ccby-repo/README.md", "CC-BY-4.0");
    const core = card("x", { sources: [src] });
    expect(errors([[core]]).some((m) => m.includes("only in packs/cc-by"))).toBe(true);
    const pack = card("y", { pack: "cc-by", file: "packs/cc-by/cards/y.md", sources: [src] });
    expect(errors([[pack], { packLicense: "L", packNotice: "Adapted from https://github.com/acme/ccby-repo" }])).toEqual([]);
  });
  test("corpus matching respects the URL path boundary", () => {
    const c = card("x", { sources: [adapted("https://github.com/acme/sa-repo-two/x", "CC0-1.0")] });
    expect(errors([[c]])).toEqual([]);
  });
  test("adapted MIT sources need their repository in NOTICE", () => {
    const corpusSrc = card("x", { sources: [adapted("https://github.com/acme/mit-repo/tree/main/retry", "MIT")] });
    expect(errors([[corpusSrc]])).toEqual(["adapted MIT source needs https://github.com/acme/mit-repo in NOTICE"]);
    expect(errors([[corpusSrc], { notice: "- https://github.com/acme/mit-repo (MIT)" }])).toEqual([]);
    const other = card("y", { sources: [adapted("https://gitlab.com/org/proj/-/blob/main/a.md", "MIT")] });
    expect(errors([[other], { notice: null }])).toEqual(["adapted MIT source needs https://gitlab.com/org/proj in NOTICE"]);
  });
  test("cc-by pack cards require the pack LICENSE and NOTICE, and the NOTICE names each repository", () => {
    const c = card("x", { pack: "cc-by", file: "packs/cc-by/cards/x.md", sources: [adapted("https://github.com/acme/ccby-repo/a", "CC-BY-4.0")] });
    expect(lint([c]).map((i) => i.file)).toEqual(["packs/cc-by/LICENSE", "packs/cc-by/NOTICE"]);
    expect(errors([[c], { packLicense: "L", packNotice: "nothing" }])).toEqual([
      "adapted source needs https://github.com/acme/ccby-repo in packs/cc-by/NOTICE",
    ]);
  });
  test("future retrieved dates warn", () => {
    const c = card("x", { sources: [{ url: "https://s.org", retrieved: "2026-06-02", license: "none", relation: "see-also" }] });
    expect(lint([c]).map((i) => i.level)).toEqual(["warn"]);
  });
});

describe("lintCards structure", () => {
  test("duplicate ids, file names, folders, related ids, signals", () => {
    const cards = [
      card("a", { related: ["b", "missing"], code_signals: ["finding:hotspot", "finding:bogus", "rule-kind:layers", "imports from many modules"] }),
      card("b", { kind: "smell", file: "knowledge/cards/principles/b.md" }),
      card("c", { file: "knowledge/cards/principles/not-c.md" }),
      card("a", { file: "knowledge/cards/principles/a2.md" }),
    ];
    const msgs = errors([cards]);
    expect(msgs).toContain('related card "missing" does not exist');
    expect(msgs).toContain('unknown code signal "finding:bogus"');
    expect(msgs).toContain('kind "smell" does not match folder "knowledge/cards/principles/"');
    expect(msgs).toContain('id "c" differs from the file name "not-c"');
    expect(msgs.filter((m) => m.startsWith('duplicate card id "a"'))).toHaveLength(2);
    expect(msgs).toHaveLength(7);
  });
  test("counts per kind", () => {
    const cards = [card("a"), card("b"), card("c", { kind: "smell" })];
    expect(errors([cards, { expectedCounts: { principle: 2, smell: 1, pattern: 0 } }])).toEqual([]);
    expect(errors([cards, { expectedCounts: { principle: 3 } }])).toEqual(["expected 3 principle cards, found 2"]);
  });
  test("every rule kind and built-in finding has a known signal", () => {
    expect(KNOWN_SIGNALS).toContain("rule-kind:state-owner");
    expect(KNOWN_SIGNALS).toContain("finding:new-cycle");
    expect([...KNOWN_SIGNALS].sort()).toEqual([...KNOWN_SIGNALS]);
  });
});

describe("searchCards", () => {
  const cards = [
    card("retry", { kind: "pattern", title: "Retry", summary: "Retry transient failures with backoff.", body: "Timeouts happen." }),
    card("circuit-breaker", { kind: "pattern", title: "Circuit breaker", summary: "Stop calling a failing dependency.", body: "Retry storms overload a dependency; a breaker trips after failures." }),
    card("cycles", { kind: "smell", title: "Dependency cycles", summary: "Modules that import each other.", code_signals: ["finding:new-cycle"] }),
  ];
  test("title and summary outrank body mentions", () => {
    expect(searchCards(cards, "retry").map((h) => h.card.id)).toEqual(["retry", "circuit-breaker"]);
  });
  test("filters by kind and limits", () => {
    expect(searchCards(cards, "dependency", { kinds: ["smell"] }).map((h) => h.card.id)).toEqual(["cycles"]);
    expect(searchCards(cards, "dependency", { limit: 1 })).toHaveLength(1);
  });
  test("ties break by id regardless of input order", () => {
    const twins = [card("b-card", { title: "Same" }), card("a-card", { title: "Same" })];
    expect(searchCards(twins, "same").map((h) => h.card.id)).toEqual(["a-card", "b-card"]);
    expect(searchCards([...twins].reverse(), "same")).toEqual(searchCards(twins, "same"));
  });
  test("a query with no matching terms returns nothing", () => {
    expect(searchCards(cards, "the and of")).toEqual([]);
  });
});

describe("cardsForFinding", () => {
  const cards = [
    card("cycles", { code_signals: ["finding:new-cycle", "rule-kind:acyclic"] }),
    card("layers", { code_signals: ["rule-kind:layers"] }),
    card("prose", { code_signals: ["new-cycle appears in the report"] }),
  ];
  test("matches by finding rule or rule kind, ignoring prose signals", () => {
    expect(cardsForFinding(cards, { rule: "new-cycle", kind: "metric" }).map((c) => c.id)).toEqual(["cycles"]);
    expect(cardsForFinding(cards, { rule: "no-ui-to-db", kind: "layers" }).map((c) => c.id)).toEqual(["layers"]);
    expect(cardsForFinding(cards, { rule: "x", kind: "forbid" })).toEqual([]);
  });
});
