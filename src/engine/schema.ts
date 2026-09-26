import { z } from "zod";
import { ArchitectureSchema, BaselineSchema, DecisionFrontMatterSchema, ReportSchema, RulesFileSchema } from "../model/index.ts";

export const SCHEMA_NAMES = ["architecture", "rules", "decision", "baseline", "report"] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

/** JSON Schemas of the files Architect reads and writes, for editor validation. */
export function jsonSchemas(): Record<SchemaName, unknown> {
  const schema = (value: z.ZodType, title: string, io: "input" | "output") => ({ title, ...z.toJSONSchema(value, { io, unrepresentable: "any" }) });
  return {
    architecture: schema(ArchitectureSchema, "Architect architecture.yaml", "input"),
    rules: schema(RulesFileSchema, "Architect rules.yaml", "input"),
    decision: schema(DecisionFrontMatterSchema, "Architect decision front matter", "input"),
    baseline: schema(BaselineSchema, "Architect baseline.json", "input"),
    report: schema(ReportSchema, "Architect JSON report", "output"),
  };
}
