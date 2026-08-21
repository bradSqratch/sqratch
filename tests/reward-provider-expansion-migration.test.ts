import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = process.cwd();
const migration = readFileSync(
  join(root, "prisma/migrations/20260821130000_add_reward_provider_columns/migration.sql"),
  "utf8",
);
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const offerRoute = readFileSync(
  join(root, "src/app/api/brand/rewards/offers/route.ts"),
  "utf8",
);
const redeemRoute = readFileSync(
  join(root, "src/app/api/rewards/shopify/redeem/route.ts"),
  "utf8",
);

function model(name: string) {
  return schema.match(new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`, "m"))?.[0] ?? "";
}

function executableSql(sql: string) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

test("Phase 15C1 adds non-null Shopify-default provider fields without renaming reward schema", () => {
  assert.match(model("BrandRewardOffer"), /^\s+provider\s+CommerceProvider\s+@default\(SHOPIFY\)/m);
  assert.match(model("ShopifyRewardRedemption"), /^\s+provider\s+CommerceProvider\s+@default\(SHOPIFY\)/m);

  assert.match(migration, /ALTER TABLE "BrandRewardOffer"\s+ADD COLUMN "provider" "CommerceProvider" NOT NULL DEFAULT 'SHOPIFY';/);
  assert.match(migration, /ALTER TABLE "ShopifyRewardRedemption"\s+ADD COLUMN "provider" "CommerceProvider" NOT NULL DEFAULT 'SHOPIFY';/);

  assert.match(schema, /^model ShopifyRewardRedemption \{/m);
  assert.match(schema, /^enum ShopifyRewardRedemptionStatus \{/m);
  assert.match(model("BrandRewardOffer"), /^\s+sourceShopDomain\s+String\?/m);
  assert.match(model("ShopifyRewardRedemption"), /^\s+shopifyShopDomain\s+String/m);
  assert.match(model("BrandRewardOfferProduct"), /^\s+shopifyProductGid\s+String/m);
  assert.match(model("PointTransaction"), /^\s+shopifyRewardRedemptionId\s+String\?/m);
});

test("Phase 15C1 keeps the ledger structurally untouched and adds only exact-identity indexes", () => {
  const pointTransaction = model("PointTransaction");
  const pointAccount = model("UserPointAccount");
  assert.match(pointTransaction, /^\s+shopifyRewardRedemptionId\s+String\?/m);
  assert.match(pointTransaction, /@@unique\(\[shopifyRewardRedemptionId, reason\]/);
  assert.match(pointAccount, /^\s+spendablePoints\s+Int\s+@default\(0\)/m);
  assert.match(pointAccount, /^\s+lifetimeEarnedPoints\s+Int\s+@default\(0\)/m);

  assert.match(migration, /CREATE INDEX "BrandRewardOffer_brandId_provider_sourceShopDomain_idx"\s+ON "BrandRewardOffer"\("brandId", "provider", "sourceShopDomain"\);/);
  assert.match(migration, /CREATE INDEX "ShopifyRewardRedemption_brandId_provider_shopifyShopDomain_idx"\s+ON "ShopifyRewardRedemption"\("brandId", "provider", "shopifyShopDomain"\);/);
  assert.match(model("BrandRewardOffer"), /@@index\(\[brandId, sourceShopDomain\]\)/);
  assert.match(model("ShopifyRewardRedemption"), /@@index\(\[brandId, provider, shopifyShopDomain\]\)/);
});

test("Phase 15C1 migration is additive and cannot mutate rewards or the points ledger", () => {
  const sql = executableSql(migration);
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|\bRENAME\s+TABLE\b|\bRENAME\s+COLUMN\b|\bDELETE\b|\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\b|PointTransaction|UserPointAccount/i);
  assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE "PointTransaction"|ALTER TABLE "UserPointAccount"/i);
});

test("pre-15C2 reward writers remain compatible by omitting provider and receiving the database default", () => {
  const offerCreate = offerRoute.match(/prisma\.brandRewardOffer\.create\(\{[\s\S]*?\n\s*\}\);/)?.[0] ?? "";
  const redemptionCreate = redeemRoute.match(/tx\.shopifyRewardRedemption\.create\(\{[\s\S]*?\n\s*\}\);/)?.[0] ?? "";
  assert.match(offerCreate, /sourceShopDomain/);
  assert.doesNotMatch(offerCreate, /\bprovider\s*:/);
  assert.match(redemptionCreate, /shopifyShopDomain/);
  assert.doesNotMatch(redemptionCreate, /\bprovider\s*:/);
});
