import { RULE_KINDS, compareText } from "../model/index.ts";

export const FINDING_SIGNAL_PREFIX = "finding:";
export const RULE_KIND_SIGNAL_PREFIX = "rule-kind:";

const BUILT_IN_FINDINGS = [
  "contract-changed",
  "deprecated-dependency",
  "generated-drift",
  "god-component",
  "hidden-change-coupling",
  "hotspot",
  "hub-component",
  "new-component-edge",
  "new-cycle",
  "propagation-cost-rise",
  "stale-decision",
  "superseded-citation",
  "unapproved-weakening",
  "unstable-dependency",
];

/** Machine-readable code_signals a card may use, sorted. */
export const KNOWN_SIGNALS: readonly string[] = [
  ...BUILT_IN_FINDINGS.map((id) => FINDING_SIGNAL_PREFIX + id),
  ...RULE_KINDS.map((kind) => RULE_KIND_SIGNAL_PREFIX + kind),
].sort(compareText);

/** Signals with the finding: or rule-kind: prefix are machine-readable; all other code_signals are prose. */
export function isMachineSignal(signal: string): boolean {
  return signal.startsWith(FINDING_SIGNAL_PREFIX) || signal.startsWith(RULE_KIND_SIGNAL_PREFIX);
}
