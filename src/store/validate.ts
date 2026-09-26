import {
  type Architecture,
  type ConfigIssue,
  type Decision,
  normalizeDecisionId,
  referencedComponents,
  type RulesFile,
} from "../model/index.ts";
import { CONTRACT_PATHS } from "./contract-paths.ts";
import { compareIssues, issue } from "./parse.ts";

const MAX_WAIVER_DAYS = 180;
const SELECTOR_FIELDS = ["from", "to", "members", "targets", "components", "within", "allow_from"] as const;

function days(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function duplicates(ids: readonly string[]): Map<number, string> {
  const seen = new Set<string>();
  const out = new Map<number, string>();
  ids.forEach((id, i) => {
    if (seen.has(id)) out.set(i, id);
    seen.add(id);
  });
  return out;
}

/**
 * Checks cross references between components, rules, waivers, resources, and decisions.
 * Returns the issues and the rules with expired waivers removed.
 */
export function validateContract(
  contract: { architecture: Architecture; rules: RulesFile; decisions: Decision[] },
  options: { today: string },
): { issues: ConfigIssue[]; rules: RulesFile } {
  const { architecture, rules, decisions } = contract;
  const ARCH = CONTRACT_PATHS.architecture;
  const RULES = CONTRACT_PATHS.rules;
  const issues: ConfigIssue[] = [];
  const componentIds = new Set(architecture.components.map((c) => c.id));
  const resourceIds = new Set(architecture.resources.map((r) => r.id));
  const ruleIds = new Set(rules.rules.map((r) => r.id));
  const decisionsById = new Map(decisions.map((d) => [d.id, d]));

  for (const [i, id] of duplicates(architecture.components.map((c) => c.id))) {
    issues.push(issue("error", ARCH, `duplicate component id "${id}"`, `components[${i}].id`));
  }
  for (const [i, id] of duplicates(architecture.resources.map((r) => r.id))) {
    issues.push(issue("error", ARCH, `duplicate resource id "${id}"`, `resources[${i}].id`));
  }
  for (const [i, id] of duplicates(rules.rules.map((r) => r.id))) {
    issues.push(issue("error", RULES, `duplicate rule id "${id}"`, `rules[${i}].id`));
  }
  const native = decisions.filter((d) => !d.imported);
  for (const [i, id] of duplicates(native.map((d) => d.id))) {
    const file = native[i]?.file ?? CONTRACT_PATHS.decisions;
    issues.push(issue("error", file, `duplicate decision id "${id}"`));
  }

  const checkComponents = (file: string, path: string, selectors: readonly string[]): void => {
    for (const id of referencedComponents(selectors)) {
      if (!componentIds.has(id)) issues.push(issue("error", file, `unknown component "${id}"`, path));
    }
  };

  architecture.resources.forEach((resource, i) => {
    checkComponents(ARCH, `resources[${i}].owner`, [resource.owner]);
  });

  rules.rules.forEach((rule, i) => {
    const fields = rule as Record<string, unknown>;
    for (const field of SELECTOR_FIELDS) {
      const value = fields[field];
      if (Array.isArray(value)) checkComponents(RULES, `rules[${i}].${field}`, value as string[]);
    }
    if (rule.kind === "layers") {
      rule.layers.forEach((layer, j) => {
        checkComponents(RULES, `rules[${i}].layers[${j}]`, typeof layer === "string" ? [layer] : layer);
      });
    }
    if (rule.kind === "state-owner") {
      rule.resources?.forEach((id, j) => {
        if (!resourceIds.has(id)) issues.push(issue("error", RULES, `unknown resource "${id}"`, `rules[${i}].resources[${j}]`));
      });
    }
    rule.because.forEach((ref, j) => {
      const path = `rules[${i}].because[${j}]`;
      const id = normalizeDecisionId(ref);
      const decision = id === null ? undefined : decisionsById.get(id);
      if (decision === undefined) issues.push(issue("error", RULES, `unknown decision "${ref}"`, path));
      else if (decision.status === "rejected") issues.push(issue("warn", RULES, `cites rejected decision "${ref}"`, path));
    });
  });

  const waivers = rules.waivers.filter((waiver, i) => {
    const path = `waivers[${i}]`;
    if (!ruleIds.has(waiver.rule)) issues.push(issue("error", RULES, `unknown rule "${waiver.rule}"`, `${path}.rule`));
    checkComponents(RULES, `${path}.from`, [waiver.from]);
    if (waiver.to !== undefined) checkComponents(RULES, `${path}.to`, [waiver.to]);
    const remaining = days(options.today, waiver.expires);
    if (remaining > MAX_WAIVER_DAYS) {
      issues.push(issue("error", RULES, `waiver expires ${remaining} days from today; the limit is ${MAX_WAIVER_DAYS}`, `${path}.expires`));
    }
    if (remaining < 0) {
      issues.push(issue("warn", RULES, `waiver expired on ${waiver.expires} and no longer applies`, `${path}.expires`));
      return false;
    }
    return true;
  });

  for (const decision of decisions) {
    decision.supersedes.forEach((ref, j) => {
      const id = normalizeDecisionId(ref);
      if (id === null || !decisionsById.has(id)) issues.push(issue("warn", decision.file, `supersedes unknown decision "${ref}"`, `supersedes[${j}]`));
    });
    decision.governs.forEach((entry, j) => {
      if (!/[/*.]/.test(entry) && !componentIds.has(entry)) {
        issues.push(issue("warn", decision.file, `governs unknown component "${entry}"`, `governs[${j}]`));
      }
    });
  }

  issues.sort(compareIssues);
  return { issues, rules: { ...rules, waivers } };
}
