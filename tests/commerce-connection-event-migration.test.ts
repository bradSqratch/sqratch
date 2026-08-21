import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const migration = readFileSync(
  join(
    root,
    "prisma/migrations/20260821120000_rename_shopify_connection_event_to_commerce_connection_event/migration.sql",
  ),
  "utf8",
);
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");

test("Phase 15B renames lifecycle history in place without deleting rows", () => {
  assert.match(migration, /ALTER TYPE "ShopifyConnectionEventType" RENAME TO "CommerceConnectionEventType"/);
  assert.match(migration, /ALTER TABLE "ShopifyConnectionEvent" RENAME TO "CommerceConnectionEvent"/);
  assert.match(migration, /RENAME COLUMN "shopDomain" TO "externalAccountId"/);
  assert.match(migration, /RENAME COLUMN "previousShopDomain" TO "previousExternalAccountId"/);
  assert.match(migration, /RENAME COLUMN "shopifyClientId" TO "providerClientId"/);
  assert.match(migration, /ADD COLUMN "provider" "CommerceProvider" NOT NULL DEFAULT 'SHOPIFY'/);
  assert.doesNotMatch(migration, /\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|\bTRUNCATE\b|\bDELETE\b|\bUPDATE\b/i);
});

test("Phase 15B schema keeps provider-neutral snapshots without a live connection FK", () => {
  const model = schema.match(/model CommerceConnectionEvent \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert.match(model, /^\s+brandId\s+String/m);
  assert.match(model, /^\s+provider\s+CommerceProvider/m);
  assert.match(model, /^\s+externalAccountId\s+String\?/m);
  assert.match(model, /^\s+previousExternalAccountId\s+String\?/m);
  assert.match(model, /^\s+providerClientId\s+String\?/m);
  assert.doesNotMatch(model, /connectionId/);
  assert.doesNotMatch(schema, /^model ShopifyConnectionEvent\b/m);
  assert.doesNotMatch(schema, /^enum ShopifyConnectionEventType\b/m);
});
