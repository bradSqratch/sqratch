import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CommerceProvider, type Prisma } from "@prisma/client";

const root = process.cwd();
const migration = readFileSync(
  join(root, "prisma/migrations/20260821130000_add_reward_provider_columns/migration.sql"),
  "utf8",
);
const contractMigration = readFileSync(
  join(root, "prisma/migrations/20260821140000_remove_reward_provider_defaults/migration.sql"),
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

function sourceFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(fullPath);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [fullPath] : [];
  });
}

type IsRequired<T, Key extends keyof T> = Pick<T, Key> extends Required<Pick<T, Key>>
  ? true
  : false;

test("Phase 15C1 adds provider fields and Phase 15C3 contracts their temporary defaults", () => {
  assert.match(model("BrandRewardOffer"), /^\s+provider\s+CommerceProvider$/m);
  assert.match(model("CommerceRewardRedemption"), /^\s+provider\s+CommerceProvider$/m);
  assert.doesNotMatch(model("BrandRewardOffer"), /provider\s+CommerceProvider\s+@default/m);
  assert.doesNotMatch(model("CommerceRewardRedemption"), /provider\s+CommerceProvider\s+@default/m);

  assert.match(migration, /ALTER TABLE "BrandRewardOffer"\s+ADD COLUMN "provider" "CommerceProvider" NOT NULL DEFAULT 'SHOPIFY';/);
  assert.match(migration, /ALTER TABLE "ShopifyRewardRedemption"\s+ADD COLUMN "provider" "CommerceProvider" NOT NULL DEFAULT 'SHOPIFY';/);

  const contractSql = executableSql(contractMigration).trim();
  assert.equal(
    contractSql,
    'ALTER TABLE "BrandRewardOffer" ALTER COLUMN "provider" DROP DEFAULT;\n\nALTER TABLE "ShopifyRewardRedemption" ALTER COLUMN "provider" DROP DEFAULT;',
  );

  assert.match(schema, /^model CommerceRewardRedemption \{/m);
  assert.match(schema, /^enum CommerceRewardRedemptionStatus \{/m);
  assert.match(model("CommerceRewardRedemption"), /@@map\("ShopifyRewardRedemption"\)/);
  assert.match(model("BrandRewardOffer"), /^\s+sourceExternalAccountId\s+String\?\s+@map\("sourceShopDomain"\)/m);
  assert.match(model("CommerceRewardRedemption"), /^\s+externalAccountId\s+String\s+@map\("shopifyShopDomain"\)/m);
  assert.match(model("BrandRewardOfferProduct"), /^\s+externalProductId\s+String\s+@map\("shopifyProductGid"\)/m);
  assert.match(model("PointTransaction"), /^\s+commerceRewardRedemptionId\s+String\?\s+@map\("shopifyRewardRedemptionId"\)/m);
});

test("Phase 15C1 keeps the ledger structurally untouched and adds only exact-identity indexes", () => {
  const pointTransaction = model("PointTransaction");
  const pointAccount = model("UserPointAccount");
  assert.match(pointTransaction, /^\s+commerceRewardRedemptionId\s+String\?/m);
  assert.match(pointTransaction, /@@unique\(\[commerceRewardRedemptionId, reason\]/);
  assert.match(pointAccount, /^\s+spendablePoints\s+Int\s+@default\(0\)/m);
  assert.match(pointAccount, /^\s+lifetimeEarnedPoints\s+Int\s+@default\(0\)/m);

  assert.match(migration, /CREATE INDEX "BrandRewardOffer_brandId_provider_sourceShopDomain_idx"\s+ON "BrandRewardOffer"\("brandId", "provider", "sourceShopDomain"\);/);
  assert.match(migration, /CREATE INDEX "ShopifyRewardRedemption_brandId_provider_shopifyShopDomain_idx"\s+ON "ShopifyRewardRedemption"\("brandId", "provider", "shopifyShopDomain"\);/);
  assert.match(model("BrandRewardOffer"), /@@index\(\[brandId, sourceExternalAccountId\], map:/);
  assert.match(model("CommerceRewardRedemption"), /@@index\(\[brandId, provider, externalAccountId\], map:/);
});

test("Phase 15C1 migration is additive and cannot mutate rewards or the points ledger", () => {
  const sql = executableSql(migration);
  assert.doesNotMatch(sql, /\bDROP\s+TABLE\b|\bDROP\s+COLUMN\b|\bRENAME\s+TABLE\b|\bRENAME\s+COLUMN\b|\bDELETE\b|\bTRUNCATE\b/i);
  assert.doesNotMatch(sql, /\bUPDATE\b|PointTransaction|UserPointAccount/i);
  assert.doesNotMatch(sql, /CREATE TABLE|ALTER TABLE "PointTransaction"|ALTER TABLE "UserPointAccount"/i);
});

test("Phase 15C2 reward writers explicitly preserve the provider identity", () => {
  const offerCreate = offerRoute.match(/prisma\.brandRewardOffer\.create\(\{[\s\S]*?\n\s*\}\);/)?.[0] ?? "";
  const redemptionCreate = redeemRoute.match(/tx\.commerceRewardRedemption\.create\(\{[\s\S]*?\n\s*\}\);/)?.[0] ?? "";
  assert.match(offerCreate, /sourceExternalAccountId/);
  assert.match(offerCreate, /\bprovider\s*:\s*CommerceProvider\.SHOPIFY/);
  assert.match(redemptionCreate, /externalAccountId/);
  assert.match(redemptionCreate, /\bprovider\s*:\s*CommerceProvider\.SHOPIFY/);
});

test("Phase 15C3 guards every known reward create path and requires explicit future-provider writes", () => {
  const writers = sourceFiles(join(root, "src"))
    .map((path) => ({ path, source: readFileSync(path, "utf8") }))
    .filter(({ source }) => /(?:brandRewardOffer|commerceRewardRedemption)\.create\(/.test(source));

  assert.deepEqual(
    writers.map(({ path }) => path.replace(`${root}/`, "")).sort(),
    [
      "src/app/api/brand/rewards/offers/route.ts",
      "src/app/api/rewards/shopify/redeem/route.ts",
    ],
  );
  for (const { source } of writers) {
    assert.match(source, /\bprovider\s*:\s*CommerceProvider\.SHOPIFY/);
  }

  const commerce7OfferWrite: Pick<Prisma.BrandRewardOfferCreateInput, "provider"> = {
    provider: CommerceProvider.COMMERCE7,
  };
  const commerce7RedemptionWrite: Pick<Prisma.CommerceRewardRedemptionCreateInput, "provider"> = {
    provider: CommerceProvider.COMMERCE7,
  };
  const offerProviderIsRequired: IsRequired<Prisma.BrandRewardOfferCreateInput, "provider"> = true;
  const redemptionProviderIsRequired: IsRequired<Prisma.CommerceRewardRedemptionCreateInput, "provider"> = true;
  assert.equal(commerce7OfferWrite.provider, CommerceProvider.COMMERCE7);
  assert.equal(commerce7RedemptionWrite.provider, CommerceProvider.COMMERCE7);
  assert.equal(offerProviderIsRequired, true);
  assert.equal(redemptionProviderIsRequired, true);

  const sql = executableSql(contractMigration);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE|TRUNCATE|RENAME|CREATE)\b/i);
  assert.doesNotMatch(sql, /PointTransaction|UserPointAccount/i);
});
