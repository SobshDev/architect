import { describe, expect, test } from "bun:test";
import { upsertManagedBlock } from "./block.ts";
import { architectHookCommands, mergeHooks } from "./json.ts";
import { readTomlTable, upsertTomlTable } from "./toml.ts";

const BLOCK = "<!-- architect:begin -->\nnew guidance\n<!-- architect:end -->";

describe("upsertManagedBlock", () => {
  test("creates the file content when there is none", () => {
    expect(upsertManagedBlock(null, BLOCK)).toBe(`${BLOCK}\n`);
  });

  test("appends after existing text, which stays byte for byte", () => {
    const existing = "# Project\r\n\nKeep this.   \n\n\n";
    const out = upsertManagedBlock(existing, BLOCK);
    expect(out.startsWith("# Project\r\n\nKeep this.   ")).toBe(true);
    expect(out.endsWith(`\n\n${BLOCK}\n`)).toBe(true);
    expect(upsertManagedBlock(out, BLOCK)).toBe(out);
  });

  test("replaces only the block, keeping text before and after it", () => {
    const existing = "before\n<!-- architect:begin -->\nold\nlines\n<!-- architect:end -->\nafter\n<!-- not ours -->\n";
    expect(upsertManagedBlock(existing, BLOCK)).toBe(`before\n${BLOCK}\nafter\n<!-- not ours -->\n`);
  });

  test("refuses a begin marker without an end marker instead of deleting what follows", () => {
    expect(() => upsertManagedBlock("<!-- architect:begin -->\nuser notes\n", BLOCK)).toThrow("architect:end");
  });
});

const TABLE = '[mcp_servers.architect]\ncommand = "architect"\nargs = ["mcp"]';

describe("upsertTomlTable", () => {
  test("appends to a file with comments and other tables, keeping them byte for byte", () => {
    const existing = '# my settings\nmodel = "x"   # trailing comment\n\n[mcp_servers.other]\ncommand = "other"';
    const out = upsertTomlTable(existing, "mcp_servers.architect", TABLE);
    expect(out).toBe(`${existing}\n\n${TABLE}\n`);
    expect(upsertTomlTable(out, "mcp_servers.architect", TABLE)).toBe(out);
  });

  test("replaces a table in the middle, keeping the next table and the comment above it", () => {
    const existing = '[mcp_servers.architect]\ncommand = "old"\nenv = { A = "1" }\n\n# the next one\n[profiles.fast]\nmodel = "y"\n';
    expect(upsertTomlTable(existing, "mcp_servers.architect", TABLE)).toBe(`${TABLE}\n\n# the next one\n[profiles.fast]\nmodel = "y"\n`);
  });

  test("recognizes quoted and spaced headers and stops at subtables and arrays of tables", () => {
    const existing = '[ mcp_servers . "architect" ]  # ours\ncommand = "old"\n[mcp_servers.architect.env]\nA = "1"\n[[things]]\nx = 1\n';
    const out = upsertTomlTable(existing, "mcp_servers.architect", TABLE);
    expect(out).toBe(`${TABLE}\n[mcp_servers.architect.env]\nA = "1"\n[[things]]\nx = 1\n`);
    expect(readTomlTable(out, "mcp_servers.architect")).toBe(TABLE);
  });

  test("does not mistake a similarly named table for the target", () => {
    const existing = '[mcp_servers.architect-old]\ncommand = "keep"\n';
    expect(upsertTomlTable(existing, "mcp_servers.architect", TABLE)).toBe(`${existing}\n${TABLE}\n`);
  });
});

describe("mergeHooks", () => {
  const spec = (command: string) => [{ event: "PostToolUse", matcher: "apply_patch", command }];

  test("replaces Architect's hook in place and keeps a user hook sharing its group", () => {
    const settings = {
      other: true,
      hooks: {
        PostToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "lint" }] },
          { matcher: "apply_patch", hooks: [{ type: "command", command: "fmt" }, { type: "command", command: "architect hook PostToolUse --agent codex" }] },
        ],
      },
    };
    const merged = mergeHooks("x.json", settings, spec("bunx architect hook PostToolUse --agent codex"));
    expect(merged.other).toBe(true);
    expect(merged.hooks).toEqual({
      PostToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "lint" }] },
        { matcher: "apply_patch", hooks: [{ type: "command", command: "bunx architect hook PostToolUse --agent codex" }] },
        { matcher: "apply_patch", hooks: [{ type: "command", command: "fmt" }] },
      ],
    });
    const again = mergeHooks("x.json", merged, spec("bunx architect hook PostToolUse --agent codex"));
    expect(JSON.stringify(again)).toBe(JSON.stringify(merged));
  });

  test("removes Architect hooks from events it no longer generates", () => {
    const settings = { hooks: { Notification: [{ hooks: [{ type: "command", command: "architect hook Notification --agent claude" }] }] } };
    const merged = mergeHooks("x.json", settings, spec("architect hook PostToolUse --agent claude"));
    expect(Object.keys(merged.hooks as object)).toEqual(["PostToolUse"]);
    expect(architectHookCommands(merged)).toEqual(["architect hook PostToolUse --agent claude"]);
  });
});
