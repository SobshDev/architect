import { parse } from "yaml";
import { CardFrontMatterSchema, compareText, splitFrontMatter } from "../model/index.ts";
import type { Card } from "../model/index.ts";
import { EMBEDDED_CARDS } from "./cards.gen.ts";

export type CardPack = Card["pack"];

/** Parses a card file: YAML front matter validated by CardFrontMatterSchema, then the Markdown body. */
export function parseCard(file: string, text: string, pack: CardPack): Card {
  const { frontMatter, body } = splitFrontMatter(text);
  if (frontMatter === null) throw new Error(`${file}: missing YAML front matter`);
  let data: unknown;
  try {
    data = parse(frontMatter);
  } catch (error) {
    throw new Error(`${file}: invalid YAML front matter: ${(error as Error).message}`);
  }
  const result = CardFrontMatterSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`${file}: invalid card front matter: ${issues}`);
  }
  return { ...result.data, body: body.trim(), file, pack };
}

let cached: Card[] | null = null;

/** The cards embedded in cards.gen.ts, parsed once and sorted by id. */
export function loadCards(): Card[] {
  cached ??= EMBEDDED_CARDS.map((c) => parseCard(c.file, c.text, c.pack)).sort(
    (a, b) => compareText(a.id, b.id) || compareText(a.file, b.file),
  );
  return cached;
}
