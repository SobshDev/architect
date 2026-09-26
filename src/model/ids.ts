/** Normalizes decision references such as "ADR-0007", "7", or "0007-use-postgres" to "0007". */
export function normalizeDecisionId(ref: string): string | null {
  const match = /\d+/.exec(ref.trim());
  if (!match) return null;
  return match[0].padStart(4, "0");
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug === "" ? "decision" : slug;
}

export function decisionFileName(id: string, title: string): string {
  return `${id}-${slugify(title)}.md`;
}
