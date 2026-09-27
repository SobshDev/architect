import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runCheck } from "../src/engine/index.ts";

const TODAY = "2026-09-26";
const made: string[] = [];

afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

const lines = (...l: string[]) => `${l.join("\n")}\n`;

const SHOP = {
  ".architect/architecture.yaml": lines(
    "version: 1",
    "name: shop",
    "components:",
    "  - id: domain",
    "    paths: [src/shop/domain]",
    "  - id: infra",
    "    paths: [src/shop/infra]",
    "  - id: app",
    "    paths: [src/shop]",
  ),
  ".architect/rules.yaml": lines(
    "version: 1",
    "rules:",
    "  - id: domain-is-pure",
    "    kind: forbid",
    "    from: [domain]",
    "    to: [infra]",
    '    because: ["0001"]',
    "  - id: domain-no-packages",
    "    kind: external-imports",
    "    from: [domain]",
    "    allow: []",
    '    because: ["0001"]',
  ),
  ".architect/decisions/0001-keep-the-domain-pure.md": lines(
    "---",
    "status: accepted",
    "date: 2026-09-01",
    "---",
    "",
    "# Keep the domain pure",
    "",
    "## Context and Problem Statement",
    "",
    "Business rules changed whenever storage changed.",
  ),
  "pyproject.toml": lines("[project]", 'name = "shop"'),
  "src/shop/__init__.py": "",
  "src/shop/domain/__init__.py": lines("from .order import Order"),
  "src/shop/infra/__init__.py": "",
  "src/shop/infra/db.py": lines("import sqlite3", "", "def save(order):", "    pass"),
};

test("Python imports that break a forbid rule are found through src-layout, relative, and TYPE_CHECKING imports, and pass once fixed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "architect-py-"));
  made.push(dir);
  write(dir, {
    ...SHOP,
    "src/shop/domain/order.py": lines(
      "from __future__ import annotations",
      "from dataclasses import dataclass",
      "from typing import TYPE_CHECKING",
      "from shop.infra.db import save",
      "from ..infra import db",
      "import attrs",
      "if TYPE_CHECKING:",
      "    from shop.infra.db import Session",
      "",
      "@dataclass",
      "class Order:",
      "    id: str",
    ),
  });
  const before = (await runCheck(dir, { today: TODAY })).report;
  const errors = before.findings.filter((f) => f.status === "new" && f.level === "error").map((f) => `${f.rule} ${f.location?.file}:${f.location?.line}`);
  expect(errors.sort()).toEqual([
    "domain-is-pure src/shop/domain/order.py:4",
    "domain-is-pure src/shop/domain/order.py:5",
    "domain-is-pure src/shop/domain/order.py:8",
    "domain-no-packages src/shop/domain/order.py:6",
  ]);
  expect(before.exit_code).toBe(1);

  write(dir, { "src/shop/domain/order.py": lines("from dataclasses import dataclass", "", "@dataclass", "class Order:", "    id: str") });
  const after = (await runCheck(dir, { today: TODAY })).report;
  expect(after.findings.filter((f) => f.status === "new" && f.level === "error")).toEqual([]);
  expect(after.exit_code).toBe(0);
});

