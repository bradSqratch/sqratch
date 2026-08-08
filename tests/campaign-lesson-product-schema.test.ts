process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/campaign-lesson-product-schema.test.ts
 *
 * Migration-shape test for 20260807140000_add_campaign_lesson_product_scoping,
 * mirroring tests/campaign-commerce-product-schema.test.ts's style for Phase
 * 4's migration. Asserts the SQL is additive-only and that the composite FK
 * columns match what Phase 4's migration already created.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
const migration = readFileSync(
  join(root, "prisma/migrations/20260807140000_add_campaign_lesson_product_scoping/migration.sql"),
  "utf8",
);

test("Phase 5 schema has a reversible campaign-scoped lesson-product attachment identity", () => {
  assert.match(schema, /model CampaignLessonProduct \{/);
  assert.match(schema, /brandCommerceProductId\s+String/);
  assert.match(schema, /isActive\s+Boolean\s+@default\(true\)/);
  assert.match(schema, /deactivatedAt\s+DateTime\?/);
  assert.match(schema, /@@unique\(\[campaignId, lessonId, brandCommerceProductId\]\)/);
});

test("same-brand ownership is enforced by the SAME composite candidate keys Phase 4 already created (no new unique index on a pre-existing table)", () => {
  assert.match(
    schema,
    /campaign\s+Campaign\s+@relation\(fields: \[campaignId, brandId\], references: \[id, brandId\]/,
  );
  assert.match(
    schema,
    /brandCommerceProduct\s+BrandCommerceProduct\s+@relation\(fields: \[brandCommerceProductId, brandId\], references: \[id, brandId\]/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \("campaignId", "brandId"\) REFERENCES "Campaign"\("id", "brandId"\)/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \("brandCommerceProductId", "brandId"\) REFERENCES "BrandCommerceProduct"\("id", "brandId"\)/,
  );
  // These are the exact composite unique keys Phase 4's migration
  // (20260807120000_add_campaign_commerce_product_curation) created; this
  // migration must not re-declare them.
  assert.match(migration, /Campaign_id_brandId_key/);
  assert.match(migration, /BrandCommerceProduct_id_brandId_key/);
  assert.equal(/CREATE UNIQUE INDEX "Campaign_id_brandId_key"/.test(migration), false);
  assert.equal(/CREATE UNIQUE INDEX "BrandCommerceProduct_id_brandId_key"/.test(migration), false);
});

// PHASE 8 INVERSION. This assertion used to read "the legacyLessonProductLinkId
// bridge is a deliberate SET NULL, not CASCADE" and asserted the bridge EXISTS.
// Step 6 removed the bridge entirely (Step 2 had already stopped reading and
// writing it), so the assertion is inverted rather than deleted: it now fails
// loudly if a future change re-introduces the bridge, which would resurrect the
// dual-representation ambiguity Phase 8 exists to eliminate.
test("the legacyLessonProductLinkId bridge is GONE from the current schema (inverted Phase 5 assertion)", () => {
  assert.doesNotMatch(schema, /legacyLessonProductLinkId/);
  assert.doesNotMatch(schema, /legacyLink\s+LessonProductLink/);
  assert.doesNotMatch(schema, /model LessonProductLink \{/);
  assert.doesNotMatch(schema, /model ExperienceProductLink \{/);

  // The @@unique([campaignId, lessonId, brandCommerceProductId]) tuple is now
  // the ONLY reversible lifecycle key on this table.
  assert.match(schema, /@@unique\(\[campaignId, lessonId, brandCommerceProductId\]\)/);
});

// Phase 5's own migration is applied to production and therefore immutable; its
// SQL still (correctly) records that the bridge was created with SET NULL. That
// is history, not current shape — the test above governs current shape.
test("Phase 5's immutable migration still records the bridge it created with SET NULL", () => {
  assert.match(
    migration,
    /FOREIGN KEY \("legacyLessonProductLinkId"\) REFERENCES "LessonProductLink"\("id"\) ON DELETE SET NULL/,
  );
  assert.match(migration, /CREATE UNIQUE INDEX "CampaignLessonProduct_legacyLessonProductLinkId_key"/);
});

test("every other new FK cascades, matching CampaignCommerceProduct's lifecycle", () => {
  assert.match(
    migration,
    /FOREIGN KEY \("brandId"\) REFERENCES "Brand"\("id"\) ON DELETE CASCADE/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \("lessonId"\) REFERENCES "Lesson"\("id"\) ON DELETE CASCADE/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \("campaignId", "brandId"\) REFERENCES "Campaign"\("id", "brandId"\) ON DELETE CASCADE/,
  );
  assert.match(
    migration,
    /FOREIGN KEY \("brandCommerceProductId", "brandId"\) REFERENCES "BrandCommerceProduct"\("id", "brandId"\) ON DELETE CASCADE/,
  );
});

test("Phase 5 migration is additive-only: no UPDATE/DELETE/TRUNCATE/DROP, no ALTER ... DROP, outside comments", () => {
  assert.match(migration, /PREFLIGHT/);
  assert.match(migration, /ROLLBACK LIMITATION/);

  const codeOnly = migration
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  assert.equal(/^\s*(?:UPDATE|DELETE|TRUNCATE|DROP)\b/im.test(codeOnly), false);
  assert.equal(/^\s*ALTER TABLE .*\s+DROP\b/im.test(codeOnly), false);
  assert.match(codeOnly, /CREATE TABLE "CampaignLessonProduct"/);
});

test("the new table's own indexes exist for every documented access pattern", () => {
  assert.match(
    migration,
    /CREATE UNIQUE INDEX "CampaignLessonProduct_campaignId_lessonId_brandCommerceProd_key" ON "CampaignLessonProduct"\("campaignId", "lessonId", "brandCommerceProductId"\)/,
  );
  assert.match(
    migration,
    /CREATE INDEX "CampaignLessonProduct_lessonId_isActive_displayOrder_idx" ON "CampaignLessonProduct"\("lessonId", "isActive", "displayOrder"\)/,
  );
  assert.match(
    migration,
    /CREATE INDEX "CampaignLessonProduct_campaignId_isActive_displayOrder_idx" ON "CampaignLessonProduct"\("campaignId", "isActive", "displayOrder"\)/,
  );
});

test("preflight documents dependency on all three prerequisite migrations", () => {
  assert.match(migration, /20260806120000_add_commerce_connection_abstraction/);
  assert.match(migration, /20260806140000_add_commerce_product_catalog/);
  assert.match(migration, /20260807120000_add_campaign_commerce_product_curation/);
});
