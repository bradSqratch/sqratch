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

test("Phase 4 schema uses an explicit disabled-by-default curation policy", () => {
  assert.match(schema, /commerceProductCurationEnabled\s+Boolean\s+@default\(false\)/);
  assert.match(migration, /ADD COLUMN "commerceProductCurationEnabled" BOOLEAN NOT NULL DEFAULT false/);
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
