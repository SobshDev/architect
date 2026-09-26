// Small BM25 ranking used for knowledge cards and decision retrieval. Deterministic: ties break by id.

const STOPWORDS = new Set(
  "a an and are as at be but by can do for from has have how i if in into is it its of on or should so that the their then there these this to use used using was we what when where which while who why will with you your".split(" "),
);

export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    tokens.push(raw.length > 4 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return tokens;
}

export interface SearchDocument {
  id: string;
  text: string;
}

export interface SearchHit {
  id: string;
  score: number;
}

export class Bm25Index {
  private readonly docs: { id: string; tf: Map<string, number>; length: number }[];
  private readonly df = new Map<string, number>();
  private readonly avgLength: number;

  constructor(
    documents: readonly SearchDocument[],
    private readonly k1 = 1.2,
    private readonly b = 0.75,
  ) {
    this.docs = documents.map((d) => {
      const tf = new Map<string, number>();
      const tokens = tokenize(d.text);
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
      return { id: d.id, tf, length: tokens.length };
    });
    const total = this.docs.reduce((sum, d) => sum + d.length, 0);
    this.avgLength = this.docs.length === 0 ? 0 : total / this.docs.length;
  }

  search(query: string, limit = 10): SearchHit[] {
    const terms = [...new Set(tokenize(query))];
    const n = this.docs.length;
    const hits: SearchHit[] = [];
    for (const doc of this.docs) {
      let score = 0;
      for (const term of terms) {
        const f = doc.tf.get(term);
        if (!f) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        const norm = this.avgLength === 0 ? 1 : 1 - this.b + (this.b * doc.length) / this.avgLength;
        score += (idf * f * (this.k1 + 1)) / (f + this.k1 * norm);
      }
      if (score > 0) hits.push({ id: doc.id, score });
    }
    hits.sort((x, y) => y.score - x.score || x.id.localeCompare(y.id));
    return hits.slice(0, limit);
  }
}
