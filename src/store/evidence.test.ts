import { describe, expect, test } from "bun:test";
import { checkEvidence, containsQuote, parseEvidenceSource, type EvidenceRef } from "./evidence.ts";

describe("parseEvidenceSource", () => {
  test("accepts repository paths, git references, and web URLs", () => {
    expect(parseEvidenceSource("src/domain/order.ts")).toEqual({ kind: "path", path: "src/domain/order.ts" });
    expect(parseEvidenceSource("./docs/adr/0001.md")).toEqual({ kind: "path", path: "docs/adr/0001.md" });
    expect(parseEvidenceSource("git:4f2a9c1:src/app.ts")).toEqual({ kind: "git", revision: "4f2a9c1", path: "src/app.ts" });
    expect(parseEvidenceSource("https://example.com/post#part")).toEqual({ kind: "url", url: "https://example.com/post#part" });
  });

  test("rejects paths that leave the repository and unknown schemes", () => {
    for (const source of ["/etc/passwd", "../other/file.ts", "src/../../x.ts", "C:\\repo\\a.ts", "ftp://host/file", "git:abc:/abs.ts", "mailto:a@b.c"]) {
      expect(parseEvidenceSource(source)).toBeNull();
    }
  });
});

describe("containsQuote", () => {
  const text = "export function placeOrder(order: Order): Order {\n  saveOrder(order);\n  return order;\n}\n";

  test("matches word for word, treating line breaks and indentation as one space", () => {
    expect(containsQuote(text, "saveOrder(order);")).toBe(true);
    expect(containsQuote(text, "saveOrder(order); return order;")).toBe(true);
    expect(containsQuote(text, "saveOrder(order);\n      return   order;")).toBe(true);
  });

  test("rejects paraphrases, changed words, and empty quotes", () => {
    expect(containsQuote(text, "saves the order")).toBe(false);
    expect(containsQuote(text, "saveOrder(orders);")).toBe(false);
    expect(containsQuote(text, "  \n ")).toBe(false);
  });
});

describe("checkEvidence", () => {
  const files: Record<string, string> = { "src/a.ts": "const answer = 42;\n", "git:abc123:src/a.ts": "const answer = 41;\n" };
  const reads: string[] = [];
  const read = async (ref: Exclude<EvidenceRef, { kind: "url" }>) => {
    const key = ref.kind === "git" ? `git:${ref.revision}:${ref.path}` : ref.path;
    reads.push(key);
    return files[key] ?? null;
  };

  test("classifies each quote and reads every source once", async () => {
    const checks = await checkEvidence(
      [
        { source: "src/a.ts", quote: "answer = 42" },
        { source: "src/a.ts", quote: "answer = 41" },
        { source: "git:abc123:src/a.ts", quote: "answer = 41" },
        { source: "src/missing.ts", quote: "anything" },
        { source: "https://example.com", quote: "anything" },
        { source: "/abs/path.ts", quote: "anything" },
      ],
      read,
    );
    expect(checks.map((check) => check.status)).toEqual(["verified", "not-found", "verified", "missing-source", "unverified-url", "invalid-source"]);
    expect(reads.sort()).toEqual(["git:abc123:src/a.ts", "src/a.ts", "src/missing.ts"]);
  });
});
