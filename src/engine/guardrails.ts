// Boundary rules a team already wrote down: import restrictions in agent instructions and contributor docs, and
// scripts that check boundaries. Init quotes them verbatim as evidence in a proposed decision, so a person can
// turn each one into a checked rule.
import { posix } from "node:path";
import { BLOCK_BEGIN, BLOCK_END } from "../integrations/index.ts";
import type { Evidence, FileSource } from "../model/index.ts";

const DOCS = /^(|.*\/)(AGENTS|CLAUDE|CONTRIBUTING|ARCHITECTURE)\.md$/i;
const DOC_DIRS = /^(docs?|\.github)\/.*(architecture|boundar|layer|convention|guideline)[^/]*\.md$/i;
const SCRIPT = /(^|\/)[^/]*(boundar|layer|architecture|import[-_]?lint|dependency[-_]?check|check[-_]?imports)[^/]*\.(py|sh|ts|js|mjs|rb)$/i;
const RULE_LINE = /\b(never|must not|mustn't|do not|don't|may not|cannot|can't|only|forbidden|not allowed)\b.*\b(import|depend|call|reference|reach into)/i;
const SCRIPT_LINE = /\b(forbid|forbidden|disallow|not allowed|must not|boundar|layer)/i;
const MAX_PER_FILE = 5;
const MAX_TOTAL = 15;

/** Lines outside Architect's own managed block that state an import or dependency restriction. */
function docLines(text: string): string[] {
  const out: string[] = [];
  let managed = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === BLOCK_BEGIN) managed = true;
    if (!managed && line.length >= 12 && line.length <= 300 && RULE_LINE.test(line)) out.push(line);
    if (line === BLOCK_END) managed = false;
  }
  return out;
}

function scriptLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 12 && line.length <= 300 && SCRIPT_LINE.test(line));
}

/** Verbatim quotes of existing guardrails, in path order, at most a few per file. */
export async function findGuardrails(source: FileSource, files: readonly string[]): Promise<Evidence[]> {
  const candidates = files.filter((f) => !f.startsWith(".architect/") && !f.split("/").includes("node_modules") && (DOCS.test(f) || DOC_DIRS.test(f) || SCRIPT.test(f)));
  const texts = await source.readFiles(candidates);
  const evidence: Evidence[] = [];
  for (const path of candidates) {
    const text = texts.get(path);
    if (text === undefined) continue;
    const isScript = SCRIPT.test(path) && !path.endsWith(".md");
    const lines = [...new Set(isScript ? scriptLines(text) : docLines(text))].slice(0, MAX_PER_FILE);
    const note = isScript ? `boundary check script ${posix.basename(path)}` : undefined;
    for (const quote of lines) evidence.push(note === undefined ? { source: path, quote } : { source: path, quote, note });
  }
  return evidence.slice(0, MAX_TOTAL);
}
