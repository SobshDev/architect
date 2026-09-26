import type { Report, Rule } from "../model/index.ts";
import { formatMarkdown } from "./markdown.ts";
import { formatJson } from "./report.ts";
import { formatSarif } from "./sarif.ts";
import { formatText } from "./text.ts";

export { createReport, emptyCoverage, formatJson } from "./report.ts";
export type { ReportInput } from "./report.ts";
export { formatText } from "./text.ts";
export { formatMarkdown } from "./markdown.ts";
export { formatSarif } from "./sarif.ts";
export { formatGraph } from "./graph.ts";
export type { GraphFormat } from "./graph.ts";

export type ReportFormat = "text" | "json" | "markdown" | "sarif";

export function formatReport(report: Report, format: ReportFormat, options: { verbose?: boolean; rules?: readonly Rule[] } = {}): string {
  switch (format) {
    case "text":
      return formatText(report, options);
    case "json":
      return formatJson(report);
    case "markdown":
      return formatMarkdown(report);
    case "sarif":
      return formatSarif(report, options);
  }
}
