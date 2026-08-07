-- Migration: 20260807120000_add_campaign_commerce_product_curation
--
-- Phase 4's provider-neutral campaign product curation policy and assignment
-- table. This migration is additive and forward-only: it adds one Boolean
-- policy column, one table, indexes, unique constraints, and foreign keys.
-- It contains no UPDATE, DELETE, TRUNCATE, dropped object, or type conversion.
-- Existing campaigns therefore remain in legacy compatibility mode without a
-- backfill: "commerceProductCurationEnabled" defaults to false.
--
-- The campaign assignment uses SQRATCH ids, never a provider product id:
-- CampaignCommerceProduct -> BrandCommerceProduct -> ConnectedCommerceProduct.
-- It deliberately has one physical row per (campaign, brand product), with an
-- isActive lifecycle. Deactivation is reversible and a second active row is
-- structurally impossible; historical LessonProductLink rows are untouched.
--
-- SAME-BRAND INTEGRITY
-- --------------------
-- The new composite foreign keys require both referenced records to carry the
-- SAME `brandId` as the assignment:
--
--  * (campaignId, brandId) -> Campaign(id, brandId)
--  * (brandCommerceProductId, brandId) -> BrandCommerceProduct(id, brandId)
--
-- PostgreSQL consequently rejects cross-brand assignments even when a caller
-- bypasses the application service. The older BrandCommerceProduct ->
-- ConnectedCommerceProduct relationship predates this migration and is a
-- single-column FK, so a selection whose connected product is wrong-brand is
-- not retroactively converted into a destructive FK replacement here. Phase 4
-- assignment/authorization code must validate current product ownership and
-- reconciliation reports those legacy inconsistencies. This avoids dropping or
-- replacing an existing production constraint in a supposedly additive change.
--
-- PREFLIGHT (run manually immediately before deploying; do NOT run during
-- development against a production DATABASE_URL):
--
-- 1. Confirm the product-catalog migration is fully applied and its tables
--    exist. This migration depends on BrandCommerceProduct:
--
--    SELECT migration_name, finished_at, rolled_back_at
--    FROM _prisma_migrations
--    WHERE migration_name = '20260806140000_add_commerce_product_catalog';
--
--    SELECT to_regclass('public."BrandCommerceProduct"') IS NOT NULL
--      AS has_brand_commerce_product;
--
-- 2. Confirm no historical brand selection already points at a connected
--    product owned by another brand. Do not auto-delete any result:
--
--    SELECT bcp."id", bcp."brandId", ccp."brandId" AS connected_product_brand_id
--    FROM "BrandCommerceProduct" bcp
--    JOIN "ConnectedCommerceProduct" ccp ON ccp."id" = bcp."connectedProductId"
--    WHERE bcp."brandId" <> ccp."brandId";
--
-- 3. Confirm the new relation/table names do not already exist from a manual
--    partial application. Stop and investigate if any check is true:
--
--    SELECT to_regclass('public."CampaignCommerceProduct"') IS NOT NULL AS has_table,
--           EXISTS (
--             SELECT 1 FROM information_schema.columns
--             WHERE table_schema = 'public' AND table_name = 'Campaign'
--               AND column_name = 'commerceProductCurationEnabled'
--           ) AS has_policy_column;
--
-- ROLLBACK LIMITATION
-- --------------------
-- Once assignment rows are written, a rollback that drops this new table would
-- discard curation/audit state. There is intentionally no automatic rollback
-- SQL. Restore a database backup or export those rows before manually dropping
-- the additive objects. Do not roll back by deleting LessonProductLink or
-- ExperienceProductLink rows; this migration never touches either table.

-- AlterTable
ALTER TABLE "Campaign"
ADD COLUMN "commerceProductCurationEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "CampaignCommerceProduct" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "brandCommerceProductId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignCommerceProduct_pkey" PRIMARY KEY ("id")
);

-- Composite target identities needed by the same-brand FKs below. The id-only
-- primary keys remain intact; these are additive candidate keys.
CREATE UNIQUE INDEX "Campaign_id_brandId_key" ON "Campaign"("id", "brandId");
CREATE UNIQUE INDEX "BrandCommerceProduct_id_brandId_key" ON "BrandCommerceProduct"("id", "brandId");

-- One lifecycle row per campaign/product makes duplicate active assignments
-- impossible and gives reactivation a deterministic target.
CREATE UNIQUE INDEX "CampaignCommerceProduct_campaignId_brandCommerceProductId_key"
  ON "CampaignCommerceProduct"("campaignId", "brandCommerceProductId");

CREATE INDEX "CampaignCommerceProduct_brandId_campaignId_isActive_displayOrder_idx"
  ON "CampaignCommerceProduct"("brandId", "campaignId", "isActive", "displayOrder");
CREATE INDEX "CampaignCommerceProduct_campaignId_isActive_displayOrder_idx"
  ON "CampaignCommerceProduct"("campaignId", "isActive", "displayOrder");
CREATE INDEX "CampaignCommerceProduct_brandCommerceProductId_isActive_idx"
  ON "CampaignCommerceProduct"("brandCommerceProductId", "isActive");

-- AddForeignKey
ALTER TABLE "CampaignCommerceProduct"
  ADD CONSTRAINT "CampaignCommerceProduct_brandId_fkey"
  FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CampaignCommerceProduct"
  ADD CONSTRAINT "CampaignCommerceProduct_campaignId_brandId_fkey"
  FOREIGN KEY ("campaignId", "brandId") REFERENCES "Campaign"("id", "brandId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CampaignCommerceProduct"
  ADD CONSTRAINT "CampaignCommerceProduct_brandCommerceProductId_brandId_fkey"
  FOREIGN KEY ("brandCommerceProductId", "brandId") REFERENCES "BrandCommerceProduct"("id", "brandId")
  ON DELETE CASCADE ON UPDATE CASCADE;
