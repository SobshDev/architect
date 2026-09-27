// A repository written mostly in Rust and Swift, with a little TypeScript: the case where Architect used to report
// a clean result for code it could not read. Coverage, history, crate edges, and init must all say what they see.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { formatInit, runCheck, runContext, runGraph, runInit, runStatus, formatStatus } from "../src/engine/index.ts";
import { formatText } from "../src/report/index.ts";

const TODAY = "2026-09-26";
let repo: string;

function git(...args: string[]): void {
  const date = "2026-09-01T00:00:00Z";
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd: repo,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

function write(path: string, text: string): void {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
}

const rust = (tag: string, n: number) => Array.from({ length: n }, (_, i) => `pub fn ${tag}_${i}() {}`).join("\n") + "\n";

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "architect-polyglot-"));
  git("init", "-q");
  write("Cargo.toml", '[workspace]\nmembers = ["api/modules/*"]\n');
  write("api/modules/chats/Cargo.toml", '[package]\nname = "chats"\n\n[dependencies]\nproxy = { path = "../proxy" }\nserde = "1"\n\n[dev-dependencies]\nstore = { path = "../store" }\n');
  write("api/modules/proxy/Cargo.toml", '[package]\nname = "proxy"\n\n[dependencies]\ntokio = { version = "1" }\n');
  write("api/modules/store/Cargo.toml", '[package]\nname = "store"\n');
  for (const crate of ["chats", "proxy", "store"]) for (let i = 0; i < 6; i++) write(`api/modules/${crate}/src/f${i}.rs`, rust(crate, 40));
  for (const target of ["ChatCore", "ChatFeature", "SettingsCore"]) for (let i = 0; i < 8; i++) write(`ios/Sources/${target}/F${i}.swift`, "struct A {}\n");
  write("ios/Tests/ChatCoreTests/Fixtures/rfb.py", "x = 1\n");
  write("web/src/main.ts", 'import { util } from "./util.ts";\nutil();\n');
  write("web/src/util.ts", "export function util() {}\n");
  write("AGENTS.md", "# Rules\n\n- Swift feature targets must not import adapters directly.\n- Keep commits small.\n");
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  // chats and store change together without any dependency between them.
  for (let n = 0; n < 6; n++) {
    write("api/modules/chats/src/f0.rs", rust(`chats${n}`, 40 + n));
    write("api/modules/store/src/f0.rs", rust(`store${n}`, 40 + n));
    git("add", "-A");
    git("commit", "-q", "-m", `change ${n}`);
  }
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("a repository mostly in languages without a file analyzer", () => {
  test("init maps crates and Swift targets, warns about coverage, and only proposes decisions", async () => {
    const result = await runInit(repo, { today: TODAY });
    const ids = result.components.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["chats", "proxy", "store", "chatcore", "chatfeature", "settingscore", "web"]));
    expect(result.excluded).toContain("**/Tests/**");
    expect(result.coverage?.not_analyzed).toEqual({ rust: 18, swift: 24 });
    expect(result.layerNames?.layers).toEqual([["chatfeature"], ["chatcore", "settingscore"]]);
    expect(result.guardrails).toEqual([{ source: "AGENTS.md", quote: "- Swift feature targets must not import adapters directly." }]);

    const text = formatInit(result);
    expect(text.split("\n")[0]).toStartWith("WARNING: Architect analyzes 6 of 48 source files (12%); not analyzed: swift 24, rust 18.");
    const decisions = result.written.filter((path) => path.startsWith(".architect/decisions/")).map((path) => readFileSync(join(repo, path), "utf8"));
    expect(decisions).toHaveLength(3);
    for (const decision of decisions) expect(decision).toContain("status: proposed");
  });

  test("crate dependencies become component edges, without dev-dependencies", async () => {
    const { graph } = await runGraph(repo, { today: TODAY });
    expect(graph.edges.map((e) => [e.from, e.to])).toEqual([["chats", "proxy"]]);
  });

  test("check reports coverage by language, qualifies a clean result, and names rules that cannot fire", async () => {
    const { report } = await runCheck(repo, { today: TODAY });
    expect(report.config_issues.filter((i) => i.level === "error")).toEqual([]);
    expect(report.coverage.source_files).toBe(48);
    expect(report.coverage.languages).toEqual({ cargo: 4, typescript: 2 });
    expect(report.coverage.inert_rules).toEqual([
      { rule: "inferred-layer-names", reason: "it evaluated 0 edges; selectors chatcore, chatfeature, settingscore match no analyzed file" },
    ]);
    const text = formatText(report);
    expect(text).toContain("No new errors in the 12% of source files analyzed.");
    // The root workspace manifest belongs to no component.
    expect(text).toContain("Analyzed 6 of 48 source files (12%); not analyzed: swift 24, rust 18; 1 unmapped.");

    // History reads the Rust files the graph cannot parse.
    const coupling = report.findings.find((f) => f.rule === "hidden-change-coupling");
    // Six paired edits plus the initial commit, which is small enough to count.
    expect(coupling?.message).toContain("Components chats and store changed together in 7 commits");
    expect(coupling?.message).toContain("no analyzed import links them");
  });

  test("status and context say what Architect cannot see", async () => {
    const status = formatStatus(await runStatus(repo, { today: TODAY }));
    expect(status).toContain("6 of 48 source files analyzed (12%); not analyzed: swift 24, rust 18");
    expect(status).toContain("Rule inferred-layer-names cannot fire");
    const brief = await runContext(repo, { paths: ["api/modules/chats/src/f1.rs"], today: TODAY });
    expect(brief.markdown).toContain("Architect does not analyze `api/modules/chats/src/f1.rs`. No rule is checked on this file");
  });
});
