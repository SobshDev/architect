import { afterAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createArchitectServer } from "./index.ts";

const FIXTURE = join(import.meta.dir, "../../test/fixtures/repos/shop");
const TODAY = "2026-09-26";
const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): void {
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@e", ...args], { cwd: dir });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** A copy of the shop fixture, committed on main when committed is set. */
function shop(committed = false): string {
  const dir = mkdtempSync(join(tmpdir(), "architect-mcp-"));
  made.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  if (committed) {
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "base");
  }
  return dir;
}

/** A domain file that imports infra, breaking domain-is-pure and layering. */
function addViolation(dir: string, name: string): void {
  writeFileSync(join(dir, `src/domain/${name}.ts`), `import { saveOrder } from "../infra/db.ts";\nexport const ${name} = saveOrder;\n`);
}

async function connect(dir: string): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createArchitectServer({ cwd: dir, today: TODAY }).connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

type Result = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: Result): string {
  return result.content
    .filter((item) => item.type === "text")
    .map((item) => (item as { text: string }).text)
    .join("\n");
}

function links(result: Result): string[] {
  return result.content.filter((item) => item.type === "resource_link").map((item) => (item as { uri: string }).uri);
}

// Loose view of structuredContent for assertions.
const data = (result: Result): any => result.structuredContent;

describe("tools/list", () => {
  test("lists exactly the five tools, read-only except the proposal", async () => {
    const client = await connect(shop());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "architect_check",
      "architect_context",
      "architect_diff",
      "architect_explain",
      "architect_propose_decision",
    ]);
    for (const tool of tools) {
      expect(tool.outputSchema).toBeDefined();
      const writes = tool.name === "architect_propose_decision";
      expect(tool.annotations).toMatchObject({ readOnlyHint: !writes, destructiveHint: false, idempotentHint: !writes, openWorldHint: false });
    }
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    expect(byName.architect_diff!.inputSchema.required).toEqual(["base"]);
    expect(byName.architect_explain!.inputSchema.required).toEqual(["target"]);
    expect(Object.keys(byName.architect_check!.inputSchema.properties ?? {}).sort()).toEqual(["base", "cursor", "detail", "files", "scope"]);
    expect(byName.architect_propose_decision!.inputSchema.required).toEqual(expect.arrayContaining(["title", "context", "options", "outcome"]));
    await client.close();
  });
});

describe("architect_context", () => {
  test("names the decision governing the domain for src/domain/order.ts", async () => {
    const client = await connect(shop());
    const result = await client.callTool({ name: "architect_context", arguments: { paths: ["src/domain/order.ts"] } });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toContain("0002");
    expect(data(result).components).toContain("domain");
    expect(data(result).items.some((item: { kind: string; id: string }) => item.kind === "decision" && item.id === "0002")).toBe(true);
    expect(links(result)).toContain("architect://decisions/0002");
    await client.close();
  });
});

describe("architect_check", () => {
  test("pages new findings with cursors, errors before warnings", async () => {
    const dir = shop();
    for (let i = 0; i < 25; i++) addViolation(dir, `bulk${String(i).padStart(2, "0")}`);
    const client = await connect(dir);
    const seen: { level: string; key: string }[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await client.callTool({ name: "architect_check", arguments: { scope: "all", ...(cursor ? { cursor } : {}) } });
      expect(result.isError).toBeFalsy();
      const page = data(result);
      expect(page.findings.length).toBeLessThanOrEqual(20);
      for (const f of page.findings) seen.push({ level: f.level, key: `${f.rule} ${f.location?.file}` });
      cursor = page.next_cursor;
      pages++;
    } while (cursor !== undefined);

    // 26 violating domain files, two errors each, plus the fixture's warning; the baselined cycle is left out.
    expect(seen.length).toBe(53);
    expect(pages).toBe(3);
    expect(new Set(seen.map((f) => f.key)).size).toBe(53);
    const firstWarning = seen.findIndex((f) => f.level === "warn");
    expect(seen.slice(firstWarning).every((f) => f.level === "warn")).toBe(true);
    expect(seen.slice(0, firstWarning).every((f) => f.level === "error")).toBe(true);

    const full = await client.callTool({ name: "architect_check", arguments: { scope: "all", detail: "full" } });
    expect(data(full).findings.some((f: { status: string }) => f.status === "baselined")).toBe(true);
    expect(data(full).next_cursor).toBeUndefined();
    await client.close();
  });

  test("rejects a cursor once the findings change", async () => {
    const dir = shop();
    for (let i = 0; i < 12; i++) addViolation(dir, `bulk${i}`);
    const client = await connect(dir);
    const first = await client.callTool({ name: "architect_check", arguments: { scope: "all" } });
    const cursor = data(first).next_cursor as string;
    expect(cursor).toBeString();
    addViolation(dir, "late");
    const stale = await client.callTool({ name: "architect_check", arguments: { scope: "all", cursor } });
    expect(stale.isError).toBe(true);
    expect(textOf(stale)).toContain("without a cursor");
    await client.close();
  });

  test("links the rules and decisions that findings cite", async () => {
    const client = await connect(shop());
    const result = await client.callTool({ name: "architect_check", arguments: { scope: "all" } });
    expect(data(result).exit_code).toBe(1);
    expect(links(result)).toEqual(expect.arrayContaining(["architect://rules/domain-is-pure", "architect://decisions/0002"]));
    await client.close();
  });
});

describe("architect_diff", () => {
  test("reports a new error and an unapproved weakening after a rule is deleted", async () => {
    const dir = shop(true);
    const rulesPath = join(dir, ".architect/rules.yaml");
    const rules = readFileSync(rulesPath, "utf8");
    const start = rules.indexOf("  - id: domain-is-pure\n");
    const next = rules.indexOf("  - id: ", start + 1);
    writeFileSync(rulesPath, rules.slice(0, start) + rules.slice(next));
    addViolation(dir, "leak");
    const client = await connect(dir);

    const result = await client.callTool({ name: "architect_diff", arguments: { base: "main" } });
    expect(result.isError).toBeFalsy();
    const diff = data(result);
    expect(diff.exit_code).toBe(1);
    expect(diff.findings.some((f: { rule: string; level: string }) => f.rule === "layering" && f.level === "error")).toBe(true);
    expect(diff.weakenings).toContainEqual(expect.objectContaining({ rule: "domain-is-pure", type: "rule-removed" }));
    expect(diff.weakenings.every((w: { approved_by?: string }) => w.approved_by === undefined)).toBe(true);
    expect(textOf(result)).toContain("unapproved weakening domain-is-pure");

    const unknown = await client.callTool({ name: "architect_diff", arguments: { base: "no-such-branch" } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("no-such-branch");
    await client.close();
  });
});

describe("architect_explain", () => {
  test("explains a rule and a decision", async () => {
    const client = await connect(shop());
    const rule = await client.callTool({ name: "architect_explain", arguments: { target: "rule:domain-is-pure" } });
    expect(data(rule)).toMatchObject({ kind: "rule", id: "domain-is-pure" });
    expect(textOf(rule)).toContain("# Rule domain-is-pure");

    const decision = await client.callTool({ name: "architect_explain", arguments: { target: "0002" } });
    expect(data(decision)).toMatchObject({ kind: "decision", id: "0002" });
    expect(data(decision).title).toContain("Keep the domain pure");

    const missing = await client.callTool({ name: "architect_explain", arguments: { target: "rule:nope" } });
    expect(missing.isError).toBe(true);
    await client.close();
  });
});

describe("architect_propose_decision", () => {
  const proposal = {
    title: "Split orders from payments",
    context: "Payments change on a different schedule from orders.",
    options: ["Separate payments component", "Keep payments in the domain"],
    outcome: "Payments change without touching order rules.",
    governs: ["domain"],
  };

  test("writes a proposed decision when the quote is verbatim", async () => {
    const dir = shop();
    const client = await connect(dir);
    const result = await client.callTool({
      name: "architect_propose_decision",
      arguments: { ...proposal, evidence: [{ source: "src/domain/order.ts", quote: "export function placeOrder(order: Order): Order {" }] },
    });
    expect(result.isError).toBeFalsy();
    const written = data(result);
    expect(written).toMatchObject({ id: "0003", status: "proposed" });
    expect(textOf(result)).toContain("accept");
    const file = readFileSync(join(dir, written.path), "utf8");
    expect(file).toContain("status: proposed");
    expect(file).toContain("Split orders from payments");
    await client.close();
  });

  test("rejects a made-up quote and writes nothing", async () => {
    const dir = shop();
    const decisions = join(dir, ".architect/decisions");
    const before = readdirSync(decisions).sort();
    const client = await connect(dir);
    const result = await client.callTool({
      name: "architect_propose_decision",
      arguments: { ...proposal, evidence: [{ source: "src/domain/order.ts", quote: "orders are stored in a ledger" }] },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("rejected");
    expect(readdirSync(decisions).sort()).toEqual(before);
    await client.close();
  });
});

describe("resources", () => {
  test("lists and reads decisions, rules, components, and knowledge cards", async () => {
    const client = await connect(shop());
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual([
      "architect://cards/{id}",
      "architect://components/{id}",
      "architect://decisions/{id}",
      "architect://rules/{id}",
    ]);
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(["architect://decisions/0002", "architect://rules/domain-is-pure", "architect://components/domain"]));
    expect(uris).toContain("architect://cards/ports-and-adapters");

    const read = await client.readResource({ uri: "architect://decisions/0002" });
    const [content] = read.contents;
    expect(content?.mimeType).toBe("text/markdown");
    expect((content as { text: string }).text).toContain("Keep the domain pure");
    const card = await client.readResource({ uri: "architect://cards/ports-and-adapters" });
    expect((card.contents[0] as { text: string }).text).toContain("## Solution");
    await client.close();
  });
});

describe("stdio", () => {
  test("serves over stdio and closes cleanly", async () => {
    const dir = shop();
    const entry = join(import.meta.dir, "index.ts");
    const script = `import { serveMcp } from ${JSON.stringify(entry)}; await serveMcp({ cwd: ${JSON.stringify(dir)}, today: "${TODAY}" });`;
    const transport = new StdioClientTransport({ command: process.execPath, args: ["-e", script], cwd: dir, stderr: "pipe" });
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const client = new Client({ name: "smoke", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(5);
    const result = await client.callTool({ name: "architect_check", arguments: { scope: "all" } });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { exit_code: number }).exit_code).toBe(1);
    await client.close();
    expect(stderr).not.toContain("architect mcp:");
    expect(existsSync(dir)).toBe(true);
  }, 20000);
});
