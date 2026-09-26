import { posix } from "node:path";

/** Normalizes a repo-relative path to posix form without a leading "./". */
export function toRepoPath(path: string): string {
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  if (normalized === ".") return "";
  return normalized.startsWith("./") ? normalized.slice(2) : normalized;
}

export function dirOf(path: string): string {
  const dir = posix.dirname(path);
  return dir === "." ? "" : dir;
}
