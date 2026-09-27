#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import {
  formatBaselineUpdate,
  formatDecisionLint,
  formatDecisionList,
  formatInit,
  formatInstall,
  formatStatus,
  jsonSchemas,
  runBaselineUpdate,
  runCheck,
  runCi,
  runContext,
  runDecisionLint,
  runDecisionList,
  runDecisionNew,
  runDiff,
  runExplain,
  runGraph,
  runHook,
  runInit,
  runInstall,
  runStatus,
  runSync,
  SCHEMA_NAMES,
  UsageError,
} from "../engine/index.ts";
import { HOOK_EVENTS, type HookAgent, type HookEvent, INSTALL_AGENTS } from "../integrations/index.ts";
import { VERSION } from "../model/index.ts";
import { formatGraph, formatReport } from "../report/index.ts";

const HELP = `architect ${VERSION}: design memory and structural checks for coding agents

Usage: architect <command> [options]

Commands:
  init [--new] [--force]            Map the current code into .architect/ (--new: empty files for a new design)
  check [--all | --changed] [--base <ref>] [files...]
                                    Check the code against the rules (default --all)
  diff --base <ref> [--head <ref>]  Compare head (default: the working tree) with its merge base with <ref>:
                                    new findings, weakened rules, API changes, fixed baseline entries
  ci [--base <ref>] [--head <ref>] [--sarif <path>] [--summary <path>]
                                    The diff as a CI gate: Markdown step summary and SARIF
                                    (base defaults to origin/$GITHUB_BASE_REF)
  graph [--format mermaid|dot|json] [--no-types]
                                    Print the component graph
  explain <rule:|decision:|component:><id>
                                    Explain a rule, decision, or component
  context [paths...] [--task "<text>"] [--budget <tokens>] [--detail concise|full]
                                    Brief for a task: governing decisions, rules, contracts, open violations
  decision new "<title>" [--governs <ids>] [--weakens <rule ids>] [--supersedes <ids>]
                                    Write a proposed decision skeleton to fill in
  decision lint [ids...]            Check decisions: references, assumptions, verbatim evidence quotes
  decision list [--status <status>] List decisions
  decision show <id>                Show one decision
  baseline update [--allow-grow]    Rewrite the baseline from current findings (shrinks only, unless --allow-grow)
  status                            Summarize the contract, baseline progress, and coverage
  install --agent codex|claude|cursor [--command <cmd>]
                                    Add hooks, the MCP server, instruction files, and the skill for an agent
  sync                              Regenerate the files of every installed agent after the contract changes
  mcp                               Serve the MCP tools over stdio (hosts start this themselves)
  schema [name] [--out <dir>]       Print JSON Schemas (${SCHEMA_NAMES.join(", ")})
  hook <event> --agent codex|claude Run a host hook with its JSON payload on stdin (${HOOK_EVENTS.join(", ")})

Options:
  --format <format>   text, json, markdown, or sarif for check and diff; text or json for the other commands
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

/** Values of a repeatable option, each of which may hold a comma-separated list. */
function list(values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap((value) => value.split(",")).map((value) => value.trim()).filter((value) => value !== "");
}

/** SessionStart, session-start, and session_start name the same event. */
function normalizeEvent(name: string): string {
  return name.replace(/[-_]/g, "").toLowerCase();
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

  async diff(args, cwd) {
    const { values, positionals } = parse(args, {
      base: { type: "string" },
      head: { type: "string" },
      format: { type: "string" },
      verbose: { type: "boolean" },
    });
    noPositionals(positionals, "architect diff --base <ref> [--head <ref>]");
    if (values.base === undefined) throw new UsageError("Usage: architect diff --base <ref> [--head <ref>]");
    const format = oneOf(values.format, ["text", "json", "markdown", "sarif"] as const, "text");
    const { report, rules } = await runDiff(cwd, { base: values.base, head: values.head });
    await out(formatReport(report, format, { verbose: values.verbose, rules }));
    return report.exit_code;
  },

  async ci(args, cwd) {
    const { values, positionals } = parse(args, {
      base: { type: "string" },
      head: { type: "string" },
      sarif: { type: "string" },
      summary: { type: "string" },
      verbose: { type: "boolean" },
    });
    noPositionals(positionals, "architect ci [--base <ref>] [--head <ref>] [--sarif <path>] [--summary <path>]");
    const outcome = await runCi(cwd, { base: values.base, head: values.head, sarif: values.sarif, summary: values.summary });
    await out(formatReport(outcome.report, "text", { verbose: values.verbose, rules: outcome.rules }));
    for (const path of outcome.written) process.stderr.write(`Wrote ${path}\n`);
    return outcome.report.exit_code;
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

  async context(args, cwd) {
    const { values, positionals } = parse(args, {
      paths: { type: "string", multiple: true },
      task: { type: "string" },
      budget: { type: "string" },
      detail: { type: "string" },
      format: { type: "string" },
    });
    const format = oneOf(values.format, ["text", "json"] as const, "text");
    const detail = oneOf(values.detail, ["concise", "full"] as const, "concise", "--detail");
    const paths = [...positionals, ...list(values.paths)];
    const budget = values.budget === undefined ? undefined : Number(values.budget);
    const brief = await runContext(cwd, { paths: paths.length > 0 ? paths : undefined, task: values.task, budget, detail });
    await out(format === "json" ? JSON.stringify(brief, null, 2) : brief.markdown);
    return 0;
  },

  async decision(args, cwd) {
    const [sub, ...rest] = args;
    const usage = 'Usage: architect decision new "<title>" | lint [ids...] | list [--status <status>] | show <id>';
    if (sub === "new") {
      const { values, positionals } = parse(rest, {
        governs: { type: "string", multiple: true },
        weakens: { type: "string", multiple: true },
        supersedes: { type: "string", multiple: true },
      });
      const title = positionals.join(" ").trim();
      if (title === "") throw new UsageError(usage);
      const created = await runDecisionNew(cwd, { title, governs: list(values.governs), weakens: list(values.weakens), supersedes: list(values.supersedes) });
      await out(`Created ${created.path} (decision ${created.id}, status proposed). Replace every TODO:, then run architect decision lint ${created.id}.`);
      return 0;
    }
    if (sub === "lint") {
      const { values, positionals } = parse(rest, { format: { type: "string" } });
      const format = oneOf(values.format, ["text", "json"] as const, "text");
      const result = await runDecisionLint(cwd, { ids: positionals });
      await out(format === "json" ? JSON.stringify(result, null, 2) : formatDecisionLint(result));
      return result.exit_code;
    }
    if (sub === "list") {
      const { values, positionals } = parse(rest, { status: { type: "string" }, format: { type: "string" } });
      noPositionals(positionals, "architect decision list [--status <status>]");
      const format = oneOf(values.format, ["text", "json"] as const, "text");
      const decisions = await runDecisionList(cwd, { status: values.status });
      await out(format === "json" ? JSON.stringify(decisions, null, 2) : formatDecisionList(decisions));
      return 0;
    }
    if (sub === "show") {
      const { values, positionals } = parse(rest, { format: { type: "string" } });
      const [id] = positionals;
      if (id === undefined || positionals.length > 1) throw new UsageError("Usage: architect decision show <id>");
      const format = oneOf(values.format, ["text", "json"] as const, "text");
      const explanation = await runExplain(cwd, `decision:${id}`);
      await out(format === "json" ? JSON.stringify(explanation, null, 2) : explanation.markdown);
      return 0;
    }
    throw new UsageError(usage);
  },

  async hook(args) {
    const { values, positionals } = parse(args, { agent: { type: "string" } });
    const [name] = positionals;
    const event = HOOK_EVENTS.find((candidate) => normalizeEvent(candidate) === normalizeEvent(name ?? ""));
    if (event === undefined || positionals.length > 1) throw new UsageError(`Usage: architect hook <${HOOK_EVENTS.join("|")}> --agent codex|claude`);
    const agents: readonly HookAgent[] = ["codex", "claude"];
    const agent = oneOf(values.agent, agents, "codex", "--agent");
    const run = await runHook(event satisfies HookEvent, agent, await Bun.stdin.text());
    if (run.stderr !== "") process.stderr.write(run.stderr);
    if (run.stdout !== "") await Bun.write(Bun.stdout, run.stdout);
    return run.exitCode;
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

  async install(args, cwd) {
    const usage = `architect install --agent ${INSTALL_AGENTS.join("|")} [--command <cmd>]`;
    const { values, positionals } = parse(args, { agent: { type: "string" }, command: { type: "string" }, format: { type: "string" } });
    noPositionals(positionals, usage);
    if (values.agent === undefined) throw new UsageError(`Usage: ${usage}`);
    const agent = oneOf(values.agent, INSTALL_AGENTS, "codex", "--agent");
    const format = oneOf(values.format, ["text", "json"] as const, "text");
    const result = await runInstall(cwd, { agent, command: values.command });
    await out(format === "json" ? JSON.stringify(result, null, 2) : formatInstall(result));
    return 0;
  },

  async sync(args, cwd) {
    const { values, positionals } = parse(args, { format: { type: "string" } });
    noPositionals(positionals, "architect sync");
    const format = oneOf(values.format, ["text", "json"] as const, "text");
    const result = await runSync(cwd);
    await out(format === "json" ? JSON.stringify(result, null, 2) : formatInstall(result));
    return 0;
  },

  async mcp(args, cwd) {
    const { positionals } = parse(args, {});
    noPositionals(positionals, "architect mcp");
    // Loaded on demand so other commands never pay for the MCP SDK.
    const { serveMcp } = await import("../mcp/index.ts");
    await serveMcp({ cwd });
    return 0;
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
