/** Bytes scanned for a NUL byte when deciding whether a file is binary (same window git uses). */
const BINARY_WINDOW = 8000;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** UTF-8 text of the bytes, or null when a NUL byte in the first 8,000 bytes marks them binary. Keeps a BOM so text hashes match git blobs. */
export function decodeText(bytes: Uint8Array): string | null {
  const end = Math.min(bytes.length, BINARY_WINDOW);
  for (let i = 0; i < end; i++) if (bytes[i] === 0) return null;
  return decoder.decode(bytes);
}

/** Maps items with at most `limit` calls in flight; results keep input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
