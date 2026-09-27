// The overview an agent gets at session start.
import { describeRule } from "./rules.ts";
import { assemble, code, codeList, headerWith, makeItem, quoteLine, uriFor } from "./text.ts";
import type { ContextBrief, ContextInput, ContextItem } from "./types.ts";
import { compareText, coveragePercent, isLowCoverage, notAnalyzedText } from "../model/index.ts";

const SESSION_CAP = 600;

export function sessionBrief(input: ContextInput): ContextBrief {
  const budget = Math.min(input.budget ?? SESSION_CAP, SESSION_CAP);
  const items: ContextItem[] = [];
  const components = [...input.architecture.components].sort((a, b) => compareText(a.id, b.id));
  for (const c of components) {
    const deprecated =
      c.deprecated === undefined || c.deprecated === false
        ? ""
        : typeof c.deprecated === "object" && c.deprecated.replacement !== undefined
          ? ` (deprecated, use ${code(c.deprecated.replacement)})`
          : " (deprecated)";
    items.push(makeItem("component", c.id, uriFor("components", c.id), "component map", [`- Component ${code(c.id)}: ${codeList(c.paths, 3)}${deprecated}`]));
  }
  const rules = input.rules.rules.filter((r) => r.level === "error").sort((a, b) => compareText(a.id, b.id));
  for (const r of rules) {
    items.push(makeItem("rule", r.id, uriFor("rules", r.id), "error-level rule", [`- Rule ${code(r.id)} (${r.kind}): ${describeRule(r)}`]));
  }
  const decisions = input.decisions
    .filter((d) => d.status === "accepted" && (d.governs.length === 0 || d.governs.includes("*")))
    .sort((a, b) => compareText(a.id, b.id));
  for (const d of decisions) {
    const uri = uriFor("decisions", d.id);
    items.push(makeItem("decision", d.id, uri, "applies to the whole repository", [`Decision ${code(d.id)} (accepted) applies everywhere: ${uri}`, quoteLine(d.title)]));
  }
  const footer: string[] = [];
  const baselined = (input.findings ?? []).filter((f) => f.status === "baselined").length;
  if (baselined > 0) {
    const count = baselined === 1 ? "1 existing violation is" : `${baselined} existing violations are`;
    footer.push(`${count} frozen in the baseline. Do not add new ones.`);
  }
  footer.push("Before editing, call `architect context --paths <files>` (CLI) or `architect_context` (MCP) with the paths you will edit.");
  const c = input.coverage;
  const warnings =
    c !== undefined && isLowCoverage(c)
      ? [
          `Architect analyzes ${c.files_analyzed} of ${c.source_files} source files (${coveragePercent(c)}); not analyzed: ${notAnalyzedText(c)}. Rules are checked only on analyzed files; for the rest, follow the decisions and component contracts by reading them.`,
        ]
      : [];
  return assemble(headerWith(warnings), items, footer, budget, []);
}
