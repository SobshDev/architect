import { describe, expect, test } from "bun:test";
import type { Language, Resource, WritePreset } from "../../model/index.ts";
import { findWrites } from "./index.ts";

function resource(id: string, preset: WritePreset, name?: string): Resource {
  return { id, owner: "owner", writes: [{ preset, ...(name !== undefined && { name }) }] };
}

const hits = (line: string, r: Resource, language: Language = "typescript") => findWrites(line, language, [r]).length > 0;

const cases: { preset: WritePreset; name: string; language: Language; writes: string[]; misses: string[] }[] = [
  {
    preset: "convex",
    name: "messages",
    language: "typescript",
    writes: [
      'await ctx.db.insert("messages", { body });',
      'await ctx.db.patch("messages", id, { body });',
      "await ctx.db.patch(args.messageId, { body });",
      "await ctx.db.delete(message._id);",
      "await ctx.db.replace(messagesId, doc);",
    ],
    misses: [
      'await ctx.db.insert("users", { name });',
      'await ctx.db.patch("users", messageId, {});',
      "await ctx.db.delete(userId);",
      'await ctx.db.query("messages").collect();',
    ],
  },
  {
    preset: "prisma",
    name: "User",
    language: "typescript",
    writes: ["await prisma.user.create({ data });", "await tx.user.updateMany({ where });", "this.db.user.upsert({})"],
    misses: ["await prisma.user.findMany();", "await prisma.userProfile.create({});"],
  },
  {
    preset: "drizzle",
    name: "users",
    language: "typescript",
    writes: ["await db.insert(users).values(row);", "await db.update(schema.users).set({ a });", "db.delete( users ).where(x)"],
    misses: ["await db.insert(usersArchive).values(row);", "await db.select().from(users);"],
  },
  {
    preset: "sql",
    name: "orders",
    language: "python",
    writes: [
      'cur.execute("INSERT INTO orders (id) VALUES (%s)", [id])',
      "sql = 'update public.\"orders\" set paid = true'",
      "DELETE FROM `orders` WHERE id = 1",
      "MERGE INTO dbo.[orders] AS t USING src",
      "TRUNCATE TABLE orders",
      "TRUNCATE orders",
    ],
    misses: ["SELECT * FROM orders", "DELETE FROM orders_archive", "INSERT INTO line_orders VALUES (1)", "UPDATE orders"],
  },
  {
    preset: "sqlalchemy",
    name: "Order",
    language: "python",
    writes: [
      "session.execute(insert(Order).values(total=1))",
      "stmt = sa.delete(Order).where(Order.id == 1)",
      "db.session.add(Order(total=1))",
      "Order.__table__.update().values(x=1)",
    ],
    misses: ["session.execute(select(Order))", "session.add(order)", "insert(OrderLine)"],
  },
  {
    preset: "django",
    name: "Order",
    language: "python",
    writes: ["Order.objects.create(total=1)", "Order.objects.filter(paid=False).update(paid=True)", "Order.objects.get_or_create(id=1)"],
    misses: ["Order.objects.filter(created__gt=day)", "LineOrder.objects.create(x=1)", "order.save()"],
  },
];

describe("write presets", () => {
  for (const c of cases) {
    test(`${c.preset} matches writes and not near misses`, () => {
      const r = resource("res", c.preset, c.name);
      for (const line of c.writes) expect([line, hits(line, r, c.language)]).toEqual([line, true]);
      for (const line of c.misses) expect([line, hits(line, r, c.language)]).toEqual([line, false]);
    });
  }
});

describe("findWrites", () => {
  test("the matcher name defaults to the resource id", () => {
    expect(hits("await db.insert(users).values(row);", resource("users", "drizzle"))).toBe(true);
  });

  test("skips comment-only lines", () => {
    const r = resource("orders", "sql");
    expect(findWrites("// DELETE FROM orders\n * DELETE FROM orders", "typescript", [r])).toEqual([]);
    expect(findWrites("# DELETE FROM orders", "python", [r])).toEqual([]);
  });

  test("reports one site per line and resource with the trimmed, capped line", () => {
    const r: Resource = { id: "orders", owner: "o", writes: [{ preset: "sql" }, { pattern: "orders" }] };
    const long = `   DELETE FROM orders ${"x".repeat(300)}`;
    const sites = findWrites(`a\n${long}`, "typescript", [r]);
    expect(sites).toHaveLength(1);
    expect(sites[0]?.line).toBe(2);
    expect(sites[0]?.text).toBe(long.trim().slice(0, 200));
  });

  test("an invalid custom pattern names the resource", () => {
    const r: Resource = { id: "ledger", owner: "o", writes: [{ pattern: "(unclosed" }] };
    expect(() => findWrites("x", "typescript", [r])).toThrow(/ledger/);
  });
});
