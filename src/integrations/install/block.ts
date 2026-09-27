export const BLOCK_BEGIN = "<!-- architect:begin -->";
export const BLOCK_END = "<!-- architect:end -->";

/**
 * Puts block (which starts with BLOCK_BEGIN and ends with BLOCK_END) into existing text:
 * replaces the first managed block, or appends it after a blank line. Text outside the block is kept byte for byte.
 * Throws when a begin marker has no end marker after it, since replacing to the end of the file could delete user text.
 */
export function upsertManagedBlock(existing: string | null, block: string): string {
  const body = block.replace(/\n+$/, "");
  if (existing === null || existing.trim() === "") return `${body}\n`;
  const lines = existing.split("\n");
  const begin = lines.findIndex((line) => line.trim() === BLOCK_BEGIN);
  if (begin === -1) return `${existing.replace(/\n+$/, "")}\n\n${body}\n`;
  const end = lines.findIndex((line, i) => i > begin && line.trim() === BLOCK_END);
  if (end === -1) throw new Error(`found "${BLOCK_BEGIN}" without a following "${BLOCK_END}"`);
  return [...lines.slice(0, begin), body, ...lines.slice(end + 1)].join("\n");
}
