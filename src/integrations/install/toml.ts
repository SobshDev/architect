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
