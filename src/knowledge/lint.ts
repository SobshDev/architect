import { parse } from "yaml";
import { z } from "zod";
import { compareText } from "../model/index.ts";
import type { Card, CardKind, CardSource } from "../model/index.ts";
import { KNOWN_SIGNALS, isMachineSignal } from "./signals.ts";

export const CorpusEntrySchema = z.object({
  dir: z.string().min(1),
  url: z.string().min(1),
  sha: z.string().optional(),
  license: z.string().min(1),
  relation: z.enum(["adapted", "cc-by", "see-also"]),
  use: z.string().optional(),
});
export type CorpusEntry = z.infer<typeof CorpusEntrySchema>;

/** Parses knowledge/corpus.yaml. */
export function parseCorpus(text: string): CorpusEntry[] {
  const result = z.object({ repos: z.array(CorpusEntrySchema).default([]) }).safeParse(parse(text));
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`knowledge/corpus.yaml: ${issues}`);
  }
  return result.data.repos;
}

export interface CardIssue {
  level: "error" | "warn";
  file: string;
  message: string;
}

export interface CardLintInput {
  cards: Card[];
  /** Root NOTICE text, or null when the file is missing. */
  notice: string | null;
  packLicense: string | null;
  packNotice: string | null;
  corpus: CorpusEntry[];
  expectedCounts?: Partial<Record<CardKind, number>>;
  /** ISO date used for the future retrieved-date warning. Defaults to today (UTC). */
  today?: string;
}

const ADAPTABLE: Record<Card["pack"], readonly string[]> = {
  core: ["MIT", "CC0-1.0"],
  "cc-by": ["MIT", "CC0-1.0", "CC-BY-4.0"],
};
const KNOWN = new Set(KNOWN_SIGNALS);
const PACK_DIR = "packs/cc-by";

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function corpusRepoFor(url: string, corpus: readonly CorpusEntry[]): CorpusEntry | undefined {
  return corpus.find((repo) => {
    const base = trimSlash(repo.url);
    return url === base || (url.startsWith(base) && /[/?#]/.test(url.charAt(base.length)));
  });
}

/** The repository a source URL belongs to: the corpus URL, else the origin plus its first two path segments. */
function repositoryUrl(url: string, corpus: readonly CorpusEntry[]): string {
  const repo = corpusRepoFor(url, corpus);
  if (repo) return trimSlash(repo.url);
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean).slice(0, 2);
    return [parsed.origin, ...segments].join("/");
  } catch {
    return trimSlash(url);
  }
}

function mentions(text: string, url: string): boolean {
  return text.includes(url);
}

/** Checks ids, links, signals, licensing, attribution, and counts across a set of cards. */
export function lintCards(input: CardLintInput): CardIssue[] {
  const issues: CardIssue[] = [];
  const error = (file: string, message: string) => issues.push({ level: "error", file, message });
  const today = input.today ?? new Date().toISOString().slice(0, 10);

  const files = new Map<string, string[]>();
  for (const card of input.cards) files.set(card.id, [...(files.get(card.id) ?? []), card.file]);
  for (const [id, list] of files) {
    if (list.length > 1) for (const file of list) error(file, `duplicate card id "${id}" (also in ${list.filter((f) => f !== file).join(", ")})`);
  }

  for (const card of input.cards) {
    const name = card.file.split("/").pop()?.replace(/\.md$/, "");
    if (name !== card.id) error(card.file, `id "${card.id}" differs from the file name "${name}"`);

    const folder = /^knowledge\/cards\/([^/]+)\/[^/]+$/.exec(card.file)?.[1];
    if (folder !== undefined && folder !== `${card.kind}s`) {
      error(card.file, `kind "${card.kind}" does not match folder "knowledge/cards/${folder}/"`);
    }

    for (const related of card.related) {
      if (!files.has(related)) error(card.file, `related card "${related}" does not exist`);
    }

    for (const signal of card.code_signals) {
      if (isMachineSignal(signal) && !KNOWN.has(signal)) error(card.file, `unknown code signal "${signal}"`);
    }

    for (const source of card.sources) lintSource(card, source, input, today, issues);
  }

  if (input.cards.some((c) => c.pack === "cc-by")) {
    if (input.packLicense === null) error(`${PACK_DIR}/LICENSE`, "missing; required when the cc-by pack has cards");
    if (input.packNotice === null) error(`${PACK_DIR}/NOTICE`, "missing; required when the cc-by pack has cards");
  }

  if (input.expectedCounts) {
    for (const [kind, expected] of Object.entries(input.expectedCounts)) {
      const actual = input.cards.filter((c) => c.kind === kind).length;
      if (actual !== expected) error("knowledge/cards", `expected ${expected} ${kind} cards, found ${actual}`);
    }
  }

  return issues.sort(
    (a, b) => compareText(a.file, b.file) || compareText(a.level, b.level) || compareText(a.message, b.message),
  );
}

function lintSource(card: Card, source: CardSource, input: CardLintInput, today: string, issues: CardIssue[]): void {
  const push = (level: CardIssue["level"], message: string) => issues.push({ level, file: card.file, message });
  if (source.retrieved > today) push("warn", `source ${source.url} has a retrieved date in the future (${source.retrieved})`);
  if (source.relation !== "adapted") return;

  if (!source.changes?.trim()) push("error", `adapted source ${source.url} must describe its changes`);
  if (!ADAPTABLE[card.pack].includes(source.license)) {
    push("error", `source ${source.url} is ${source.license}, which cannot be adapted in the ${card.pack} pack; use see-also`);
  }

  const repo = corpusRepoFor(source.url, input.corpus);
  if (repo?.relation === "see-also") push("error", `corpus repo ${repo.url} is see-also only and cannot be adapted`);
  if (repo?.relation === "cc-by" && card.pack !== "cc-by") {
    push("error", `corpus repo ${repo.url} may be adapted only in ${PACK_DIR}`);
  }

  const repository = repositoryUrl(source.url, input.corpus);
  if (source.license === "MIT" && !(input.notice !== null && mentions(input.notice, repository))) {
    push("error", `adapted MIT source needs ${repository} in NOTICE`);
  }
  if (card.pack === "cc-by" && input.packNotice !== null && !mentions(input.packNotice, repository)) {
    push("error", `adapted source needs ${repository} in ${PACK_DIR}/NOTICE`);
  }
}
