#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  formatBaselineUpdate,
  formatInit,
  formatStatus,
  jsonSchemas,
  runBaselineUpdate,
  runCheck,
  runExplain,
  runGraph,
  runInit,
  runStatus,
  SCHEMA_NAMES,
  UsageError,
} from "../engine/index.ts";
import { VERSION } from "../model/index.ts";
import { formatGraph, formatReport } from "../report/index.ts";

const HELP = `architect ${VERSION}: design memory and structural checks for coding agents

Usage: architect <command> [options]

Commands:
  init [--new] [--force]            Map the current code into .architect/ (--new: empty files for a new design)
  check [--all | --changed] [--base <ref>] [files...]
                                    Check the code against the rules (default --all)
  graph [--format mermaid|dot|json] [--no-types]
                                    Print the component graph
  explain <rule:|decision:|component:><id>
                                    Explain a rule, decision, or component
  baseline update [--allow-grow]    Rewrite the baseline from current findings (shrinks only, unless --allow-grow)
  status                            Summarize the contract, baseline progress, and coverage
  schema [name] [--out <dir>]       Print JSON Schemas (${SCHEMA_NAMES.join(", ")})

Options:
  --format <format>   text, json, markdown, or sarif for check; text or json for explain and status
  --verbose           List baselined, waived, and informational findings too
  --cwd <dir>         Run as if started in <dir>
  -h, --help          Show this help
  --version           Show the version

Exit codes: 0 clean; 1 new errors or an unapproved weakening; 2 configuration or usage error.
`;

type Options = NonNullable<ParseArgsConfig["options"]>;

async function out(text: string): Promise<void> {
  await Bun.write(Bun.stdout, text.endsWith("\n") ? text : `${text}\n`);
}

function parse<T extends Options>(args: string[], options: T) {
  return parseArgs({ args, options, allowPositionals: true, strict: true });
}

function noPositionals(positionals: readonly string[], usage: string): void {
  if (positionals.length > 0) throw new UsageError(`Unexpected argument "${positionals[0]}". Usage: ${usage}`);
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T, flag = "--format"): T {
  if (value === undefined) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new UsageError(`${flag} must be one of: ${allowed.join(", ")}.`);
}

const commands: Record<string, (args: string[], cwd: string) => Promise<number>> = {
  async init(args, cwd) {
    const { values, positionals } = parse(args, { new: { type: "boolean" }, force: { type: "boolean" } });
    noPositionals(positionals, "architect init [--new] [--force]");
    await out(formatInit(await runInit(cwd, { blank: values.new, force: values.force })));
    return 0;
  },

  async check(args, cwd) {
    const { values, positionals } = parse(args, {
      all: { type: "boolean" },
      changed: { type: "boolean" },
      base: { type: "string" },
      format: { type: "string" },
      verbose: { type: "boolean" },
    });
    if (values.all && (values.changed || values.base !== undefined)) throw new UsageError("--all cannot be combined with --changed or --base.");
    const format = oneOf(values.format, ["text", "json", "markdown", "sarif"] as const, "text");
    const scope = values.changed || values.base !== undefined ? "changed" : "all";
    const { report, rules } = await runCheck(cwd, { scope, base: values.base, files: positionals.length > 0 ? positionals : undefined });
    await out(formatReport(report, format, { verbose: values.verbose, rules }));
    return report.exit_code;
  },

  async graph(args, cwd) {
    const { values, positionals } = parse(args, { format: { type: "string" }, "no-types": { type: "boolean" } });
    noPositionals(positionals, "architect graph [--format mermaid|dot|json] [--no-types]");
    const format = oneOf(values.format, ["mermaid", "dot", "json"] as const, "mermaid");
    const result = await runGraph(cwd, { includeTypeImports: !values["no-types"] });
    await out(formatGraph(result.graph, format, { cycles: result.cycles }));
    if (result.inferred) process.stderr.write("No .architect/architecture.yaml yet, so these components are inferred. Run `architect init` to save them.\n");
    return 0;
  },

  async explain(args, cwd) {
    const { values, positionals } = parse(args, { format: { type: "string" } });
    const [target] = positionals;
    if (target === undefined || positionals.length > 1) throw new UsageError("Usage: architect explain <rule:|decision:|component:><id>");
    const format = oneOf(values.format, ["text", "json"] as const, "text");
    const explanation = await runExplain(cwd, target);
    await out(format === "json" ? JSON.stringify(explanation, null, 2) : explanation.markdown);
    return 0;
  },

  async baseline(args, cwd) {
    const { values, positionals } = parse(args, { "allow-grow": { type: "boolean" } });
    if (positionals.length !== 1 || positionals[0] !== "update") throw new UsageError("Usage: architect baseline update [--allow-grow]");
    await out(formatBaselineUpdate(await runBaselineUpdate(cwd, { allowGrow: values["allow-grow"] ?? false })));
    return 0;
  },

  async status(args, cwd) {
    const { values, positionals } = parse(args, { format: { type: "string" } });
    noPositionals(positionals, "architect status [--format text|json]");
    const format = oneOf(values.format, ["text", "json"] as const, "text");
    const status = await runStatus(cwd);
    await out(format === "json" ? JSON.stringify(status, null, 2) : formatStatus(status));
    return status.issues.some((issue) => issue.level === "error") ? 2 : 0;
  },

  async schema(args, cwd) {
    const { values, positionals } = parse(args, { out: { type: "string" } });
    const schemas = jsonSchemas();
    if (values.out !== undefined) {
      const dir = resolve(cwd, values.out);
      await mkdir(dir, { recursive: true });
      for (const name of SCHEMA_NAMES) await Bun.write(join(dir, `${name}.schema.json`), `${JSON.stringify(schemas[name], null, 2)}\n`);
      await out(`Wrote ${SCHEMA_NAMES.length} schemas to ${values.out}`);
      return 0;
    }
    const [name] = positionals;
    if (name === undefined) {
      await out(JSON.stringify(schemas, null, 2));
      return 0;
    }
    const known = SCHEMA_NAMES.find((candidate) => candidate === name);
    if (known === undefined) throw new UsageError(`Unknown schema "${name}". Choose one of: ${SCHEMA_NAMES.join(", ")}.`);
    await out(JSON.stringify(schemas[known], null, 2));
    return 0;
  },
};

/** Removes a global --cwd option from anywhere in the arguments. */
function takeCwd(args: string[]): string {
  const at = args.findIndex((arg) => arg === "--cwd" || arg.startsWith("--cwd="));
  if (at === -1) return process.cwd();
  const arg = args[at] ?? "";
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[at + 1];
  if (value === undefined || value === "") throw new UsageError("--cwd needs a directory.");
  args.splice(at, arg.includes("=") ? 1 : 2);
  return resolve(value);
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const cwd = takeCwd(args);
  const command = args.shift();
  if (command === undefined) {
    process.stderr.write(HELP);
    return 2;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    await out(HELP);
    return 0;
  }
  if (command === "--version" || command === "version") {
    await out(VERSION);
    return 0;
  }
  const handler = commands[command];
  if (handler === undefined) throw new UsageError(`Unknown command "${command}". Run "architect --help".`);
  if (args.includes("--help") || args.includes("-h")) {
    await out(HELP);
    return 0;
  }
  return handler(args, cwd);
}

function isArgumentError(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  const code: unknown = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("ERR_PARSE_ARGS");
}

let code: number;
try {
  code = await main(Bun.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError || isArgumentError(error)) process.stderr.write(`architect: ${error.message}\n`);
  else process.stderr.write(`architect: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  code = 2;
}
process.exit(code);
