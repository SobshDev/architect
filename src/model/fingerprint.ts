import { createHash } from "node:crypto";

/** Stable 16-hex-digit hash of the parts. Line numbers never go in, so moving code keeps fingerprints. */
export function fingerprint(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 16);
}

/** Fingerprint of an edge finding: rule, source file, target (file or package), and edge kind. */
export function edgeFingerprint(rule: string, from: string, target: string, kind: string): string {
  return fingerprint(["edge", rule, from, target, kind]);
}

/** Fingerprint of a cycle: rule plus the sorted member ids, independent of where the cycle was entered. */
export function cycleFingerprint(rule: string, members: readonly string[]): string {
  return fingerprint(["cycle", rule, ...[...members].sort()]);
}

/** Fingerprint for findings keyed by something other than an edge (decisions, metrics, API symbols). */
export function keyFingerprint(rule: string, ...key: string[]): string {
  return fingerprint(["key", rule, ...key]);
}
