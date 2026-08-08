import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(root, "prisma/migrations/20260807120000_add_campaign_commerce_product_curation/migration.sql"),
  "utf8",
);
const campaignProductsRoute = readFileSync(
  join(root, "src/app/api/brand/campaigns/[id]/commerce-products/route.ts"),
  "utf8",
);

// PHASE 8 INVERSION. This test used to assert that the current schema declares
// `commerceProductCurationEnabled Boolean @default(false)`. Phase 8 Step 5
// removed all five code readers of that column and Step 6 dropped it, so the
// assertion is inverted rather than deleted: it now fails loudly if a future
// change re-introduces the flag.
//
// WHY IT WENT: the column was BOOLEAN NOT NULL DEFAULT false and was never
// backfilled, so every pre-existing campaign read `false`. Any authorization
// site gating on it would therefore have denied every campaign that existed
// before the column was added — a live landmine, not a working feature switch.
// The LEGACY/CURATED mode concept is gone; curation is unconditional.
test("the commerceProductCurationEnabled flag is GONE from the current schema (inverted Phase 4 assertion)", () => {
  assert.doesNotMatch(schema, /commerceProductCurationEnabled/);
});

// Phase 4's migration is applied to production and therefore immutable; its SQL
// still (correctly) records that it added the column. That is history, not
// current shape.
test("Phase 4's immutable migration still records the column it added", () => {
  assert.match(migration, /ADD COLUMN "commerceProductCurationEnabled" BOOLEAN NOT NULL DEFAULT false/);
});

test("the Phase 8 removal migration drops the flag exactly once, as a DROP COLUMN", () => {
  const removal = readFileSync(
    join(root, "prisma/migrations/20260808130000_remove_legacy_product_link_snapshots/migration.sql"),
    "utf8",
  );
  const executable = removal
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  const matches = executable.match(
    /ALTER TABLE "Campaign" DROP COLUMN "commerceProductCurationEnabled";/g,
  );
  assert.equal(matches?.length, 1);
  // A column drop, never a row-affecting statement against Campaign.
  assert.doesNotMatch(executable, /DELETE\s+FROM\s+"Campaign"/i);
  assert.doesNotMatch(executable, /DROP\s+TABLE\s+"Campaign"/i);
});

test("Phase 4 schema has a provider-neutral reversible assignment identity", () => {
  assert.match(schema, /model CampaignCommerceProduct \{/);
  assert.match(schema, /brandCommerceProductId\s+String/);
  assert.match(schema, /isActive\s+Boolean\s+@default\(true\)/);
  assert.match(schema, /deactivatedAt\s+DateTime\?/);
  assert.match(schema, /@@unique\(\[campaignId, brandCommerceProductId\]\)/);
});

test("same-brand ownership is enforced by additive composite candidate keys and foreign keys", () => {
  assert.match(schema, /@@unique\(\[id, brandId\]\)/);
  assert.match(
    schema,
    /campaign\s+Campaign\s+@relation\(fields: \[campaignId, brandId\], references: \[id, brandId\]/,
  );
  assert.match(
    schema,
    /brandCommerceProduct\s+BrandCommerceProduct\s+@relation\(fields: \[brandCommerceProductId, brandId\], references: \[id, brandId\]/,
  );
  assert.match(migration, /FOREIGN KEY \("campaignId", "brandId"\) REFERENCES "Campaign"\("id", "brandId"\)/);
  assert.match(
    migration,
    /FOREIGN KEY \("brandCommerceProductId", "brandId"\) REFERENCES "BrandCommerceProduct"\("id", "brandId"\)/,
  );
});

test("Phase 4 migration is additive and documents preflight plus rollback safety", () => {
  assert.match(migration, /PREFLIGHT/);
  assert.match(migration, /ROLLBACK LIMITATION/);
  assert.equal(/^\s*(?:UPDATE|DELETE|TRUNCATE|DROP)\b/im.test(migration), false);
  assert.equal(/^\s*ALTER TABLE .*\s+DROP\b/im.test(migration), false);
  assert.match(migration, /CREATE TABLE "CampaignCommerceProduct"/);
  assert.match(migration, /CREATE INDEX "CampaignCommerceProduct_campaignId_isActive_displayOrder_idx"/);
});

test("brand campaign catalog boundary filters legacy wrong-brand product drift", () => {
  // The pre-Phase-4 BCP foreign key is single-column. This source-level
  // regression guard ensures its admin API never serializes or assigns a
  // connected product unless it also belongs to the server-resolved brand.
  assert.match(campaignProductsRoute, /connectedProduct: \{ brandId \}/);
  assert.match(campaignProductsRoute, /connectedProduct: \{ brandId, isAvailable: true \}/);
  assert.match(campaignProductsRoute, /brandCommerceProduct: \{ brandId, connectedProduct: \{ brandId \} \}/);
});
