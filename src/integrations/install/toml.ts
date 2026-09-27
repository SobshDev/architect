// Minimal TOML handling for one table, without a TOML library: the rest of the file is kept byte for byte.

const HEADER = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(#.*)?$/;

function headerName(line: string): string | null {
  const match = HEADER.exec(line.replace(/\r$/, ""));
  if (match === null) return null;
  // Normalizes quoted keys and spaces around dots: [ mcp_servers . "architect" ] is mcp_servers.architect.
  return (match[1] ?? "")
    .split(".")
    .map((part) => part.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2"))
    .join(".");
}

/** Line range [start, end) of a table: its header up to the next header, minus trailing blank and comment lines. */
function tableRange(lines: readonly string[], name: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => headerName(line) === name);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (headerName(lines[i] ?? "") !== null) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && /^\s*(#.*)?\r?$/.test(lines[end - 1] ?? "")) end--;
  return { start, end };
}

/** The table's text, header included, or null when the file has no such table. */
export function readTomlTable(existing: string | null, name: string): string | null {
  if (existing === null) return null;
  const lines = existing.split("\n");
  const range = tableRange(lines, name);
  return range === null ? null : lines.slice(range.start, range.end).join("\n");
}

const KEY_LINE = /^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=(.*)$/;

function keyPath(raw: string): string[] {
  return raw.split(".").map((part) => part.trim().replace(/^"(.*)"$|^'(.*)'$/, "$1$2"));
}

/**
 * True when the table called name is defined without its own header: with dotted keys (a.b.key = 1) or an
 * inline table (a = { b = {...} }). Adding a [a.b] header next to either makes the file invalid TOML.
 */
export function definedWithoutHeader(existing: string | null, name: string): boolean {
  if (existing === null) return false;
  const target = name.split(".");
  let table: string[] = [];
  for (const line of existing.split("\n")) {
    const header = headerName(line);
    if (header !== null) {
      table = header === "" ? [] : header.split(".");
      continue;
    }
    const match = KEY_LINE.exec(line.replace(/\r$/, ""));
    if (match === null) continue;
    const full = [...table, ...keyPath(match[1] ?? "")];
    const shared = Math.min(full.length, target.length);
    if (full.slice(0, shared).join(".") !== target.slice(0, shared).join(".")) continue;
    // A key under the table's own header, or one of its sub-tables, is the normal form.
    if (table.length >= target.length) continue;
    if (full.length > target.length) return true;
    // The key names the table or one of its parents: only an inline table can hold it.
    const rest = target.slice(full.length);
    const value = match[2] ?? "";
    if (full.length === target.length && value.trimStart().startsWith("{")) return true;
    if (rest.length > 0 && new RegExp(`[{,]\\s*["']?${rest[0]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']?\\s*[.=]`).test(value)) return true;
  }
  return false;
}

/** Replaces the table called name with table (a header plus its keys), or appends it after a blank line. */
export function upsertTomlTable(existing: string | null, name: string, table: string): string {
  const body = table.replace(/\n+$/, "");
  if (existing === null || existing.trim() === "") return `${body}\n`;
  const lines = existing.split("\n");
  const range = tableRange(lines, name);
  if (range === null) return `${existing.replace(/\n+$/, "")}\n\n${body}\n`;
  return [...lines.slice(0, range.start), body, ...lines.slice(range.end)].join("\n");
}

/** A TOML basic string. JSON string escapes are valid TOML escapes. */
export function tomlString(value: string): string {
  return JSON.stringify(value);
}
