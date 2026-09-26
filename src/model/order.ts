/** Code-point string order: identical on every machine, unlike localeCompare, whose order depends on the runtime locale. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
