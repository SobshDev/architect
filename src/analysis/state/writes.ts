// Finds lines that write to declared resources (state ownership). Every matcher is a heuristic that looks at one
// line at a time, so a statement split across lines is missed and a matching string inside other code is reported.
// Django instance saves (obj.save()) are out of scope: the model class is not visible on that line.
import type { Language, Resource, WritePreset, WriteSite } from "../../model/index.ts";
import { compareText } from "../../model/index.ts";

const MAX_TEXT = 200;

interface LineMatcher {
  resource: string;
  /** Lowercase words of which at least one must appear on the line, a cheap filter before the regex. */
  needles: string[];
  test(line: string): boolean;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Identifier boundaries for names that may contain "$". */
const BEFORE = "(?<![\\w$])";
const AFTER = "(?![\\w$])";

const PRISMA_METHODS = "create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany";
const DJANGO_METHODS = "create|bulk_create|update|bulk_update|update_or_create|get_or_create|delete";

function regexMatcher(resource: string, needles: string[], regexes: RegExp[]): LineMatcher {
  return {
    resource,
    needles: needles.map((n) => n.toLowerCase()),
    test: (line) => regexes.some((r) => r.test(line)),
  };
}

/** Convex: the first argument is a table-name string, or an id whose name mentions the table (userId, user._id, user.id). */
function convexMatcher(resource: string, name: string): LineMatcher {
  const n = escape(name);
  const insert = new RegExp(`\\bctx\\.db\\.insert\\(\\s*(["'\`])${n}\\1`);
  const other = /\bctx\.db\.(?:patch|replace|delete)\(\s*([^,)]*)/g;
  // Tables are usually plural (users) and ids singular (userId), so the singular form counts too.
  const forms = [name, ...(name.length > 1 && /s$/i.test(name) ? [name.slice(0, -1)] : [])].map(escape).join("|");
  const idMention = new RegExp(`(?:^|[^\\w$])(?:${forms})(?:Id|\\._id|\\.id)${AFTER}`, "i");
  return {
    resource,
    needles: ["ctx.db."],
    test(line) {
      if (insert.test(line)) return true;
      for (const match of line.matchAll(other)) {
        const arg = (match[1] ?? "").trim();
        const literal = /^(["'`])(.*)\1$/.exec(arg);
        if (literal ? literal[2] === name : idMention.test(arg)) return true;
      }
      return false;
    },
  };
}

function presetMatcher(resource: string, preset: WritePreset, name: string): LineMatcher {
  const n = escape(name);
  switch (preset) {
    case "convex":
      return convexMatcher(resource, name);
    case "prisma": {
      // Prisma client accessors lowercase the model's first letter (model User -> prisma.user).
      const first = name.charAt(0);
      const head = first.toLowerCase() === first.toUpperCase() ? escape(first) : `[${first.toLowerCase()}${first.toUpperCase()}]`;
      const accessor = head + escape(name.slice(1));
      return regexMatcher(resource, [name], [new RegExp(`${BEFORE}[A-Za-z_$][\\w$]*\\.${accessor}\\.(?:${PRISMA_METHODS})\\s*\\(`)]);
    }
    case "drizzle":
      return regexMatcher(resource, [name], [new RegExp(`\\.(?:insert|update|delete)\\(\\s*(?:[\\w$]+\\.)*${n}\\s*\\)`)]);
    case "sql": {
      const part = `\\\\?["\`[]?`;
      const end = `\\\\?["\`\\]]?`;
      const table = `(?:${part}[\\w$]+${end}\\.)?${part}${n}${end}(?![\\w$])`;
      return regexMatcher(
        resource,
        [name],
        [
          new RegExp(`\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+${table}`, "i"),
          new RegExp(`\\bUPDATE\\s+${table}\\s+(?:(?:AS\\s+)?\\w+\\s+)?SET\\b`, "i"),
          new RegExp(`\\bDELETE\\s+FROM\\s+${table}`, "i"),
          new RegExp(`\\bMERGE\\s+INTO\\s+${table}`, "i"),
          new RegExp(`\\bTRUNCATE\\s+(?:TABLE\\s+)?${table}`, "i"),
        ],
      );
    }
    case "sqlalchemy":
      return regexMatcher(
        resource,
        [name],
        [
          new RegExp(`${BEFORE}(?:insert|update|delete)\\(\\s*${n}\\s*\\)`),
          new RegExp(`\\bsession\\.(?:add|merge)\\(\\s*${n}\\s*\\(`),
          new RegExp(`${BEFORE}${n}\\.__table__\\.(?:insert|update|delete)\\s*\\(`),
        ],
      );
    case "django":
      return regexMatcher(resource, [name], [new RegExp(`${BEFORE}${n}\\.objects\\b.*\\.(?:${DJANGO_METHODS})\\s*\\(`)]);
  }
}

function patternMatcher(resource: string, pattern: string): LineMatcher {
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch (error) {
    throw new Error(`resource ${resource}: invalid write pattern ${JSON.stringify(pattern)}: ${(error as Error).message}`);
  }
  return { resource, needles: [], test: (line) => regex.test(line) };
}

const compiled = new WeakMap<readonly Resource[], LineMatcher[]>();

/** Matchers of every resource, compiled once per resources array. Throws on an invalid pattern, naming the resource. */
function matchersOf(resources: readonly Resource[]): LineMatcher[] {
  let matchers = compiled.get(resources);
  if (matchers) return matchers;
  matchers = [];
  for (const resource of resources) {
    for (const matcher of resource.writes) {
      const name = matcher.name ?? resource.id;
      if (matcher.preset !== undefined) matchers.push(presetMatcher(resource.id, matcher.preset, name));
      if (matcher.pattern !== undefined) matchers.push(patternMatcher(resource.id, matcher.pattern));
    }
  }
  compiled.set(resources, matchers);
  return matchers;
}

function isComment(trimmed: string, language: Language): boolean {
  if (language === "python") return trimmed.startsWith("#");
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

/** Lines of the text that write a resource, one site per line and resource, sorted by line then resource. */
export function findWrites(text: string, language: Language, resources: readonly Resource[]): WriteSite[] {
  const matchers = matchersOf(resources);
  if (matchers.length === 0) return [];
  const sites: WriteSite[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const trimmed = line.trim();
    if (trimmed === "" || isComment(trimmed, language)) continue;
    const lower = line.toLowerCase();
    const hits = new Set<string>();
    for (const m of matchers) {
      if (hits.has(m.resource)) continue;
      if (m.needles.length > 0 && !m.needles.some((needle) => lower.includes(needle))) continue;
      if (m.test(line)) hits.add(m.resource);
    }
    for (const resource of [...hits].sort(compareText)) sites.push({ line: i + 1, resource, text: trimmed.slice(0, MAX_TEXT) });
  }
  return sites;
}
