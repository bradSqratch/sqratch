process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildCampaignMetadataUpdate,
  CAMPAIGN_BRAND_IMMUTABLE,
  isCampaignBrandMutationAllowed,
} from "../src/lib/campaign-ownership";

const root = process.cwd();
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(
    root,
    "prisma/migrations/20260815120000_harden_campaign_brand_ownership_and_click_attribution/migration.sql",
  ),
  "utf8",
);
const adminPatch = readFileSync(
  join(root, "src/app/api/admin/campaigns/[id]/route.ts"),
  "utf8",
);
const adminPage = readFileSync(
  join(root, "src/app/(withSidebar)/dashboard/admin/campaigns/page.tsx"),
  "utf8",
);
const brandCreate = readFileSync(
  join(root, "src/app/api/brand/campaigns/route.ts"),
  "utf8",
);
const adminCreate = readFileSync(
  join(root, "src/app/api/admin/campaigns/route.ts"),
  "utf8",
);

describe("Campaign ownership application enforcement", () => {
  test("metadata PATCH accepts omitted or echoed owner but rejects a different Brand", () => {
    assert.equal(isCampaignBrandMutationAllowed("brand-a", null), true);
    assert.equal(isCampaignBrandMutationAllowed("brand-a", "brand-a"), true);
    assert.equal(isCampaignBrandMutationAllowed("brand-a", "brand-b"), false);
    assert.equal(CAMPAIGN_BRAND_IMMUTABLE, "CAMPAIGN_BRAND_IMMUTABLE");
  });

  test("normal Campaign update data cannot reassign ownership", () => {
    const data = buildCampaignMetadataUpdate({
      name: "Updated",
      slug: "updated",
      description: null,
      isActive: true,
    });
    assert.equal("brandId" in data, false);
    assert.match(adminPatch, /code: CAMPAIGN_BRAND_IMMUTABLE/);
    assert.match(adminPatch, /data: buildCampaignMetadataUpdate\(/);
  });

  test("admin edit UI renders permanent owner text and no Brand select", () => {
    const existingCards = adminPage.slice(adminPage.indexOf("{data.campaigns.map"));
    assert.match(existingCards, /Owning brand/);
    assert.match(existingCards, /Permanent/);
    assert.doesNotMatch(existingCards, /<select[\s\S]{0,500}value=\{draft\.brandId\}/);
    assert.doesNotMatch(adminPage, /reassign ownership/i);
  });

  test("Brand-admin creation derives its owner from membership, while platform admin creation validates its selected Brand", () => {
    assert.match(brandCreate, /brandId: context\.membership\.brand\.id/);
    assert.doesNotMatch(brandCreate, /brandId:\s*String\(body\?\.brandId/);
    assert.match(adminCreate, /prisma\.brand\.findUnique/);
    assert.match(adminCreate, /if \(!brand\)/);
    assert.match(adminCreate, /brandId,/);
  });
});

describe("Campaign ownership database hardening", () => {
  test("Campaign brand is required while its same-brand composite key remains", () => {
    const campaign = schema.slice(schema.indexOf("model Campaign {"), schema.indexOf("model QRCodeBatch {"));
    assert.match(campaign, /brandId\s+String\b/);
    assert.doesNotMatch(campaign, /brandId\s+String\?/);
    assert.match(campaign, /brand\s+Brand\s+@relation/);
    assert.match(campaign, /@@unique\(\[id, brandId\]\)/);
  });

  test("migration fails closed for legacy unbranded Campaigns and prevents direct reassignment", () => {
    assert.match(migration, /WHERE "brandId" IS NULL/);
    assert.match(migration, /RAISE EXCEPTION/);
    assert.match(migration, /ALTER COLUMN "brandId" SET NOT NULL/);
    assert.match(migration, /CREATE OR REPLACE FUNCTION "prevent_campaign_brand_reassignment"/);
    assert.match(migration, /BEFORE UPDATE OF "brandId" ON "Campaign"/);
    assert.match(migration, /OLD\."brandId" IS DISTINCT FROM NEW\."brandId"/);
    assert.doesNotMatch(migration, /UPDATE "Campaign"/);
    assert.doesNotMatch(migration, /DELETE FROM "Campaign"/);
  });
});

describe("CommerceClickAttribution redundant Brand cleanup", () => {
  test("removes only the redundant click Brand relation and keeps durable attribution", () => {
    const click = schema.slice(schema.indexOf("model CommerceClickAttribution {"), schema.indexOf("model CommerceOrder {"));
    assert.doesNotMatch(click, /^\s*brandId\s+/m);
    assert.match(click, /attributedBrandId String\?/);
    assert.doesNotMatch(click, /brand\s+Brand.*CommerceClickAttribution/);
    assert.match(click, /fields: \[productCampaignId\], references: \[id\], onDelete: SetNull/);
    assert.match(migration, /DROP COLUMN "brandId"/);
    assert.match(migration, /FOREIGN KEY \("productCampaignId"\) REFERENCES "Campaign"\("id"\)\s+ON DELETE SET NULL/);
    assert.doesNotMatch(migration, /UPDATE "CommerceClickAttribution"/);
    assert.doesNotMatch(migration, /DELETE FROM "CommerceClickAttribution"/);
  });
});
