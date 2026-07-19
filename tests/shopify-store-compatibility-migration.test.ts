import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const MIGRATION_PATH =
  "prisma/migrations/20260718120000_shopify_store_reward_compatibility/migration.sql";

function readMigration() {
  return readFileSync(MIGRATION_PATH, "utf8");
}

/** Strips `-- comment` lines so keyword checks only see executable SQL. */
function stripComments(sql: string) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

test("migration creates the connection-history enum and table", () => {
  const migration = readMigration();

  assert.match(
    migration,
    /CREATE TYPE "ShopifyConnectionEventType" AS ENUM \('CONNECTED', 'RECONNECTED', 'RELINKED', 'DISCONNECTED', 'UNINSTALLED', 'REQUIRES_RECONNECT'\)/,
  );
  assert.match(migration, /CREATE TABLE "ShopifyConnectionEvent"/);
  assert.match(migration, /"eventType" "ShopifyConnectionEventType" NOT NULL/);
  assert.match(
    migration,
    /ALTER TABLE "ShopifyConnectionEvent" ADD CONSTRAINT "ShopifyConnectionEvent_brandId_fkey"/,
  );
});

test("migration adds nullable sourceShopDomain to all three tables", () => {
  const migration = readMigration();

  assert.match(
    migration,
    /ALTER TABLE "BrandRewardOffer" ADD COLUMN\s+"sourceShopDomain" TEXT;/,
  );
  assert.match(
    migration,
    /ALTER TABLE "ExperienceProductLink" ADD COLUMN\s+"sourceShopDomain" TEXT;/,
  );
  assert.match(
    migration,
    /ALTER TABLE "LessonProductLink" ADD COLUMN\s+"sourceShopDomain" TEXT;/,
  );
  // Nullable — never NOT NULL, since existing rows have no known source.
  assert.doesNotMatch(
    migration,
    /"sourceShopDomain" TEXT NOT NULL/,
  );
});

test("migration deliberately deactivates every existing reward offer", () => {
  const migration = readMigration();

  assert.match(migration, /UPDATE "BrandRewardOffer" SET "isActive" = false;/);
});

test("migration never alters reward monetary values, points, or currency codes", () => {
  const migration = readMigration();

  assert.doesNotMatch(migration, /"discountAmountCents"\s*=/);
  assert.doesNotMatch(migration, /"discountPercentageBasisPoints"\s*=/);
  assert.doesNotMatch(migration, /"pointsCost"\s*=/);
  assert.doesNotMatch(migration, /"currencyCode"\s*=/);
  assert.doesNotMatch(migration, /"title"\s*=/);
  assert.doesNotMatch(migration, /"description"\s*=/);
});

test("migration's URL-host backfill is anchored to valid myshopify.com domains only", () => {
  const migration = readMigration();

  // Same pattern as src/lib/shopify.ts's isValidShopDomain: a full-string
  // match (anchored) against a syntactically valid shop label.
  assert.match(
    migration,
    /\^\[a-z0-9\]\(\[a-z0-9-\]\*\[a-z0-9\]\)\?\\\.myshopify\\\.com\$/,
  );
  // Hostname is extracted from a lowercased, trimmed URL — never inferred
  // from the Brand's current domain.
  assert.match(migration, /lower\(trim\("productUrl"\)\)/);
  assert.doesNotMatch(migration, /shopifyShopDomain/);
});

test("migration leaves BrandRewardOffer.sourceShopDomain null on ambiguous/multi-domain product sets", () => {
  const migration = readMigration();

  assert.match(migration, /s\.distinct_valid_domains = 1/);
  assert.match(migration, /s\.total_products = s\.valid_products/);
  assert.match(migration, /s\.total_products > 0/);
});

test("migration contains no destructive table/column deletion", () => {
  // Checked against executable SQL only — the migration's own header comment
  // names these keywords in prose to document their absence, which would
  // otherwise false-positive a naive full-text search.
  const executable = stripComments(readMigration());

  assert.doesNotMatch(executable, /\bDROP\s+TABLE\b/i);
  assert.doesNotMatch(executable, /\bDROP\s+COLUMN\b/i);
  assert.doesNotMatch(executable, /\bTRUNCATE\b/i);
  assert.doesNotMatch(executable, /\bDELETE\s+FROM\b/i);
  // The only UPDATE statements are the deliberate, explicitly-approved
  // isActive deactivation and the deterministic sourceShopDomain backfills —
  // never a DELETE/TRUNCATE/DROP.
});

test("migration's foreign key uses standard referential CASCADE, not a destructive bulk operation", () => {
  const migration = readMigration();

  // The spec's ShopifyConnectionEvent model itself declares
  // onDelete: Cascade for brandId -> Brand — a routine FK constraint clause,
  // not a data-mutating statement. It only affects FUTURE deletes of a
  // Brand, never existing rows at migration time (the table is brand new).
  assert.match(
    migration,
    /FOREIGN KEY \("brandId"\) REFERENCES "Brand"\("id"\) ON DELETE CASCADE/,
  );
});
