import { Bm25Index } from "../model/index.ts";
import type { Card, CardKind, Finding } from "../model/index.ts";
import { FINDING_SIGNAL_PREFIX, RULE_KIND_SIGNAL_PREFIX } from "./signals.ts";

// Title and summary are repeated so their terms count more than the rest of the card.
const HEADLINE_WEIGHT = 3;

function searchText(card: Card): string {
  const headline = `${card.title}\n${card.summary}\n`.repeat(HEADLINE_WEIGHT);
  return [headline, card.problem, ...card.use_when, ...card.code_signals, card.body].join("\n");
}

/** BM25 search over cards. Highest score first; ties break by id. */
export function searchCards(
  cards: readonly Card[],
  query: string,
  options: { kinds?: CardKind[]; limit?: number } = {},
): { card: Card; score: number }[] {
  const pool = options.kinds ? cards.filter((c) => options.kinds?.includes(c.kind)) : cards;
  const byId = new Map(pool.map((c) => [c.id, c]));
  const index = new Bm25Index(pool.map((c) => ({ id: c.id, text: searchText(c) })));
  return index.search(query, options.limit ?? 10).flatMap((hit) => {
    const card = byId.get(hit.id);
    return card ? [{ card, score: hit.score }] : [];
  });
}

/** Cards that name the finding's rule (finding:<rule>) or kind (rule-kind:<kind>) in their code_signals. */
export function cardsForFinding(cards: readonly Card[], finding: Pick<Finding, "rule" | "kind">): Card[] {
  const signals = new Set([FINDING_SIGNAL_PREFIX + finding.rule, RULE_KIND_SIGNAL_PREFIX + finding.kind]);
  return cards.filter((c) => c.code_signals.some((s) => signals.has(s)));
}
