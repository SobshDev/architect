import type { Evidence } from "../model/index.ts";

/** Where a piece of evidence lives: a repository path, a file at a git revision, or a web page. */
export type EvidenceRef = { kind: "path"; path: string } | { kind: "git"; revision: string; path: string } | { kind: "url"; url: string };

/** Reads the text of a path or git reference; null when it does not exist. */
export type EvidenceReader = (ref: Exclude<EvidenceRef, { kind: "url" }>) => Promise<string | null>;

/**
 * verified: the quote was found in the source. unverified-url: Architect never fetches URLs, so a person has to check.
 * not-found, missing-source, and invalid-source are errors.
 */
export type EvidenceStatus = "verified" | "unverified-url" | "not-found" | "missing-source" | "invalid-source";

export interface EvidenceCheck {
  source: string;
  status: EvidenceStatus;
  message: string;
}

function repoPath(raw: string): string | null {
  const path = raw.trim().replace(/^\.\//, "");
  if (path === "" || path.startsWith("/") || path.includes("\\") || /^[a-z]:/i.test(path)) return null;
  if (path.split("/").some((segment) => segment === ".." || segment === "")) return null;
  return path;
}

/** Parses an evidence source: a repo-relative path, git:<revision>:<path>, or an http(s) URL. Null for anything else. */
export function parseEvidenceSource(source: string): EvidenceRef | null {
  const text = source.trim();
  if (/^https?:\/\/\S+$/i.test(text)) return { kind: "url", url: text };
  const git = /^git:([^:\s]+):(.+)$/.exec(text);
  if (git) {
    const path = repoPath(git[2] ?? "");
    return path === null ? null : { kind: "git", revision: git[1] ?? "", path };
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  const path = repoPath(text);
  return path === null ? null : { kind: "path", path };
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** True when quote appears in text word for word. Runs of whitespace (line breaks, indentation) compare equal. */
export function containsQuote(text: string, quote: string): boolean {
  const wanted = collapse(quote);
  return wanted !== "" && collapse(text).includes(wanted);
}

/** Checks every quote against its source. Sources are read once each. */
export async function checkEvidence(evidence: readonly Evidence[], read: EvidenceReader): Promise<EvidenceCheck[]> {
  const texts = new Map<string, Promise<string | null>>();
  const load = (ref: Exclude<EvidenceRef, { kind: "url" }>) => {
    const key = ref.kind === "git" ? `git:${ref.revision}:${ref.path}` : ref.path;
    let text = texts.get(key);
    if (text === undefined) {
      text = read(ref);
      texts.set(key, text);
    }
    return text;
  };
  const checks: EvidenceCheck[] = [];
  for (const item of evidence) {
    const ref = parseEvidenceSource(item.source);
    if (ref === null) {
      checks.push({ source: item.source, status: "invalid-source", message: "Use a repository path, git:<sha>:<path>, or an http(s) URL." });
      continue;
    }
    if (ref.kind === "url") {
      checks.push({ source: item.source, status: "unverified-url", message: "Architect does not fetch URLs; a reviewer must confirm the quote." });
      continue;
    }
    const text = await load(ref);
    if (text === null) checks.push({ source: item.source, status: "missing-source", message: "The source does not exist." });
    else if (containsQuote(text, item.quote)) checks.push({ source: item.source, status: "verified", message: "Quote found." });
    else checks.push({ source: item.source, status: "not-found", message: "The quote does not appear verbatim in the source." });
  }
  return checks;
}
