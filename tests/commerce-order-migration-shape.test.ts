process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/commerce-order-migration-shape.test.ts
 *
 * Migration-shape test for
 * 20260807180000_add_commerce_order_normalization, mirroring
 * tests/campaign-lesson-product-schema.test.ts's style for Phase 5's
 * migration. Asserts the SQL is additive-only, the two idempotency/identity
 * unique keys exist, every money column is BIGINT (not INTEGER/REAL/FLOAT),
 * and no customer-PII-shaped column exists on any of the three new tables.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(
    root,
    "prisma/migrations/20260807180000_add_commerce_order_normalization/migration.sql",
  ),
  "utf8",
);

/**
 * The migration file's own header comment intentionally NAMES the destructive
 * statements, table/column identifiers, and design alternatives it does NOT
 * use, to document the decision (e.g. "It contains no UPDATE, DELETE,
 * TRUNCATE..."). Checks that assert a pattern's ABSENCE are therefore scoped
 * to this comment-stripped view of the actual SQL, never the raw file —
 * otherwise the prose explaining an exclusion would trip the very check
 * proving the exclusion.
 */
const sqlOnly = migration
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

// ---------------------------------------------------------------------------
// Additive-only
// ---------------------------------------------------------------------------

describe("the migration is additive-only", () => {
  test("contains no ALTER, DROP, TRUNCATE, RENAME, or UPDATE/DELETE DML against any pre-existing object", () => {
    // CREATE TYPE / CREATE TABLE / CREATE INDEX / ALTER TABLE ... ADD CONSTRAINT
    // (adding a NEW foreign key on a NEW table) are all expected and fine;
    // what must never appear is a destructive or column-altering statement.
    assert.doesNotMatch(sqlOnly, /\bALTER TABLE\s+"?\w+"?\s+ALTER COLUMN/i);
    assert.doesNotMatch(sqlOnly, /\bALTER TABLE\s+"?\w+"?\s+DROP COLUMN/i);
    assert.doesNotMatch(sqlOnly, /\bDROP TABLE/i);
    assert.doesNotMatch(sqlOnly, /\bDROP TYPE/i);
    assert.doesNotMatch(sqlOnly, /\bTRUNCATE/i);
    assert.doesNotMatch(sqlOnly, /\bRENAME\b/i);
    assert.doesNotMatch(sqlOnly, /^\s*UPDATE\s+"?\w+"?\s+SET/im);
    assert.doesNotMatch(sqlOnly, /^\s*DELETE FROM/im);
  });

  test("only CREATE TABLE statements create CommerceOrder, CommerceOrderLineItem, and CommerceOrderEvent — no pre-existing table is touched by a CREATE TABLE", () => {
    const createTableMatches = [...migration.matchAll(/CREATE TABLE "(\w+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      createTableMatches.sort(),
      ["CommerceOrder", "CommerceOrderEvent", "CommerceOrderLineItem"].sort(),
    );
  });

  test("three new enum types are created, with names not previously used", () => {
    const createTypeMatches = [...migration.matchAll(/CREATE TYPE "(\w+)" AS ENUM/g)].map((m) => m[1]);
    assert.deepEqual(
      createTypeMatches.sort(),
      ["CommerceOrderEventStatus", "CommerceOrderFinancialStatus", "CommerceOrderFulfillmentStatus"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Identity / idempotency unique keys
// ---------------------------------------------------------------------------

describe("the two load-bearing unique keys exist", () => {
  test("CommerceOrderEvent_provider_providerEventId_key — the idempotency dedup key", () => {
    assert.match(
      migration,
      /CREATE UNIQUE INDEX "CommerceOrderEvent_provider_providerEventId_key" ON "CommerceOrderEvent"\("provider", "providerEventId"\)/,
    );
    assert.match(schema, /@@unique\(\[provider, providerEventId\]\)/);
  });

  test("CommerceOrder_connectionId_externalOrderId_key — identity is scoped to the connection, never bare on externalOrderId", () => {
    assert.match(
      migration,
      /CREATE UNIQUE INDEX "CommerceOrder_connectionId_externalOrderId_key" ON "CommerceOrder"\("connectionId", "externalOrderId"\)/,
    );
    assert.match(schema, /@@unique\(\[connectionId, externalOrderId\]\)/);
    // And explicitly NOT a bare unique on externalOrderId alone.
    assert.doesNotMatch(migration, /CREATE UNIQUE INDEX "CommerceOrder_externalOrderId_key"/);
  });

  test("CommerceOrder.attributionId is a unique optional 1:1 to CommerceClickAttribution", () => {
    assert.match(
      migration,
      /CREATE UNIQUE INDEX "CommerceOrder_attributionId_key" ON "CommerceOrder"\("attributionId"\)/,
    );
    assert.match(schema, /attributionId String\? @unique/);
  });
});

// ---------------------------------------------------------------------------
// Money columns are BIGINT
// ---------------------------------------------------------------------------

describe("every money column is BIGINT, never INTEGER/REAL/FLOAT/DOUBLE", () => {
  const MONEY_COLUMNS = [
    "subtotalMinor",
    "discountsMinor",
    "shippingMinor",
    "taxMinor",
    "totalMinor",
    "totalRefundedMinor",
    "netRevenueMinor",
  ];

  test("CommerceOrder money columns", () => {
    const tableMatch = /CREATE TABLE "CommerceOrder" \(([\s\S]*?)\);/.exec(migration);
    assert.ok(tableMatch, "expected to find the CommerceOrder CREATE TABLE block");
    const body = tableMatch![1];
    for (const column of MONEY_COLUMNS) {
      const columnMatch = new RegExp(`"${column}"\\s+(\\w+)`).exec(body);
      assert.ok(columnMatch, `expected column "${column}" on CommerceOrder`);
      assert.equal(columnMatch![1], "BIGINT", `${column} must be BIGINT`);
    }
  });

  test("CommerceOrderLineItem money columns", () => {
    const tableMatch = /CREATE TABLE "CommerceOrderLineItem" \(([\s\S]*?)\);/.exec(migration);
    assert.ok(tableMatch, "expected to find the CommerceOrderLineItem CREATE TABLE block");
    const body = tableMatch![1];
    for (const column of ["unitPriceMinor", "discountMinor", "taxMinor", "totalMinor"]) {
      const columnMatch = new RegExp(`"${column}"\\s+(\\w+)`).exec(body);
      assert.ok(columnMatch, `expected column "${column}" on CommerceOrderLineItem`);
      assert.equal(columnMatch![1], "BIGINT", `${column} must be BIGINT`);
    }
  });

  test("no money column anywhere in the migration is declared INTEGER, REAL, FLOAT, or DOUBLE PRECISION", () => {
    for (const column of [...MONEY_COLUMNS, "unitPriceMinor", "discountMinor"]) {
      const wrongType = new RegExp(`"${column}"\\s+(INTEGER|REAL|FLOAT|DOUBLE PRECISION)`, "i");
      assert.doesNotMatch(migration, wrongType, `${column} must never be a floating-point or int4 type`);
    }
  });

  test("quantity remains INTEGER — a per-line unit count, not money", () => {
    assert.match(migration, /"quantity"\s+INTEGER NOT NULL/);
  });
});

// ---------------------------------------------------------------------------
// No customer PII columns
// ---------------------------------------------------------------------------

describe("no customer-PII-shaped column exists on any of the three new tables", () => {
  const PII_COLUMN_PATTERN = /email|phone|address|customer_name/i;

  for (const table of ["CommerceOrder", "CommerceOrderLineItem", "CommerceOrderEvent"]) {
    test(`${table}: every declared column name is scanned against /email|phone|address|customer_name/i`, () => {
      const tableMatch = new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\);`).exec(migration);
      assert.ok(tableMatch, `expected to find the ${table} CREATE TABLE block`);
      const body = tableMatch![1];
      const columnNames = [...body.matchAll(/^\s*"(\w+)"/gm)].map((m) => m[1]);
      assert.ok(columnNames.length > 0, `expected at least one column on ${table}`);
      for (const column of columnNames) {
        assert.doesNotMatch(
          column,
          PII_COLUMN_PATTERN,
          `${table}."${column}" looks PII-shaped and must not exist`,
        );
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Cascade / SetNull design, per the migration's own documented reasoning
// ---------------------------------------------------------------------------

describe("foreign key cascade behavior matches the documented design", () => {
  test("CommerceOrder.connectionId and .brandId cascade (required columns, no valid orphan state)", () => {
    assert.match(
      migration,
      /FOREIGN KEY \("connectionId"\) REFERENCES "CommerceConnection"\("id"\) ON DELETE CASCADE/,
    );
    assert.match(migration, /"CommerceOrder" ADD CONSTRAINT "CommerceOrder_brandId_fkey" FOREIGN KEY \("brandId"\) REFERENCES "Brand"\("id"\) ON DELETE CASCADE/);
  });

  test("CommerceOrder.attributionId is SET NULL — deleting click evidence must not delete the order", () => {
    assert.match(
      migration,
      /FOREIGN KEY \("attributionId"\) REFERENCES "CommerceClickAttribution"\("id"\) ON DELETE SET NULL/,
    );
  });

  test("CommerceOrderLineItem.orderId cascades (a line has no meaning without its order)", () => {
    assert.match(
      migration,
      /"CommerceOrderLineItem" ADD CONSTRAINT "CommerceOrderLineItem_orderId_fkey" FOREIGN KEY \("orderId"\) REFERENCES "CommerceOrder"\("id"\) ON DELETE CASCADE/,
    );
  });

  test("CommerceOrderLineItem.connectedProductId is SET NULL — a catalog deletion must never destroy historical revenue", () => {
    assert.match(
      migration,
      /FOREIGN KEY \("connectedProductId"\) REFERENCES "ConnectedCommerceProduct"\("id"\) ON DELETE SET NULL/,
    );
  });

  test("CommerceOrderEvent.orderId is SET NULL — the event ledger survives order deletion", () => {
    assert.match(
      migration,
      /"CommerceOrderEvent" ADD CONSTRAINT "CommerceOrderEvent_orderId_fkey" FOREIGN KEY \("orderId"\) REFERENCES "CommerceOrder"\("id"\) ON DELETE SET NULL/,
    );
  });

  test("no composite (connectionId, brandId) -> CommerceConnection(id, brandId) foreign key is added to the pre-existing CommerceConnection table", () => {
    assert.doesNotMatch(sqlOnly, /CommerceConnection_id_brandId_key/);
    assert.doesNotMatch(sqlOnly, /REFERENCES "CommerceConnection"\("id", "brandId"\)/);
  });
});

// ---------------------------------------------------------------------------
// 31 (mechanical): every Phase 7 test file pins DATABASE_URL on line 1
// ---------------------------------------------------------------------------

test("31. every Phase 7 test file pins DATABASE_URL to the blocked host on line 1, before any import", () => {
  const phase7TestFiles = [
    "tests/order-ingestion.test.ts",
    "tests/shopify-order-normalizer.test.ts",
    "tests/shopify-order-webhook.test.ts",
    "tests/commerce-order-migration-shape.test.ts",
  ];
  const expected = 'process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";';
  for (const file of phase7TestFiles) {
    const source = readFileSync(join(root, file), "utf8");
    assert.equal(source.split("\n")[0], expected, `${file} must pin DATABASE_URL as its literal first line`);
  }
});
