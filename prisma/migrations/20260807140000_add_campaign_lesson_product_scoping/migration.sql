-- Migration: 20260807140000_add_campaign_lesson_product_scoping
--
-- Phase 5's campaign-scoped lesson product attachment table. This migration is
-- additive and forward-only: it adds one table, its indexes, its unique
-- constraints, and its foreign keys. It contains no UPDATE, DELETE, TRUNCATE,
-- dropped object, altered column, or type conversion. No existing table,
-- column, or index is modified, so there is nothing to back-fill and every
-- pre-existing LessonProductLink / ExperienceProductLink row is untouched and
-- keeps rendering exactly as before.
--
-- WHY THIS TABLE EXISTS
-- ---------------------
-- An Experience can be co-sponsored by several campaigns belonging to several
-- brands. Phase 5E requires that a product attached under Campaign A never
-- renders under Campaign B's context on that shared Experience. Canonicalizing
-- the product alone cannot express that, so the campaign scoping lives on the
-- attachment row itself. The same product may consequently be attached under
-- two different campaigns as two independent rows; that is what lets a creator
-- attach Campaign A's product and Campaign B's product (or the same product
-- under both) without the two corrupting each other's attribution.
--
-- Like CampaignCommerceProduct, this is one reversible lifecycle row per
-- (campaign, lesson, brand product) tuple. Toggling "isActive" reuses the row,
-- so a duplicate active attachment is structurally impossible and reactivation
-- has a deterministic target.
--
-- The attachment speaks only in SQRATCH catalog ids, never a provider product
-- id: CampaignLessonProduct -> BrandCommerceProduct -> ConnectedCommerceProduct.
--
-- SAME-BRAND INTEGRITY
-- --------------------
-- Two of the new foreign keys are composite and require the referenced record
-- to carry the SAME "brandId" as the attachment:
--
--  * (campaignId, brandId) -> Campaign(id, brandId)
--  * (brandCommerceProductId, brandId) -> BrandCommerceProduct(id, brandId)
--
-- PostgreSQL therefore rejects a cross-brand attachment even when a caller
-- bypasses the application service. Both target composite unique keys
-- (Campaign_id_brandId_key, BrandCommerceProduct_id_brandId_key) were created
-- by 20260807120000_add_campaign_commerce_product_curation, so this migration
-- adds no unique index to any pre-existing table.
--
-- CASCADE REASONING
-- -----------------
-- brandId, lessonId, (campaignId, brandId), and (brandCommerceProductId,
-- brandId) are all ON DELETE CASCADE, matching CampaignCommerceProduct. GDPR
-- shop/redact already cascades CommerceConnection -> ConnectedCommerceProduct
-- -> BrandCommerceProduct, and brand/campaign/lesson deletion already cascades
-- their own subtrees. This table must not survive any of those as an orphaned
-- pointer to a brand, campaign, lesson, or catalog product that no longer
-- exists, so it participates in the same cascade.
--
-- legacyLessonProductLinkId is the deliberate exception: ON DELETE SET NULL.
-- A creator can already delete the underlying LessonProductLink snapshot
-- through the existing creator DELETE route. Destroying the campaign-scoped
-- attribution history because its display snapshot was removed would lose data
-- that cannot be re-derived, so removing the snapshot only DETACHES this row.
--
-- HAND-OFF (application layer, not this migration): SET NULL leaves an
-- orphaned-but-still-active row possible at the database level. The creator
-- product DELETE route
-- (src/app/api/creator/lessons/[lessonId]/products/[productLinkId]/route.ts)
-- is responsible for setting "isActive" = false and "deactivatedAt" = now() on
-- the matching CampaignLessonProduct in the SAME transaction as the snapshot
-- delete, so an active row never points at a null legacy link. Any future
-- writer of LessonProductLink deletions must do the same.
--
-- PREFLIGHT (run manually immediately before deploying; do NOT run during
-- development against a production DATABASE_URL):
--
-- 1. Confirm all three prerequisite migrations are applied and not rolled
--    back. This migration's foreign keys depend on all of them:
--
--    SELECT migration_name, finished_at, rolled_back_at
--    FROM _prisma_migrations
--    WHERE migration_name IN (
--      '20260806120000_add_commerce_connection_abstraction',
--      '20260806140000_add_commerce_product_catalog',
--      '20260807120000_add_campaign_commerce_product_curation'
--    )
--    ORDER BY migration_name;
--
--    All three rows must be present with a non-null finished_at and a null
--    rolled_back_at. Stop if any is missing.
--
-- 2. Confirm the tables those migrations created actually exist:
--
--    SELECT to_regclass('public."CommerceConnection"')     IS NOT NULL AS has_commerce_connection,
--           to_regclass('public."ConnectedCommerceProduct"') IS NOT NULL AS has_connected_product,
--           to_regclass('public."BrandCommerceProduct"')   IS NOT NULL AS has_brand_product,
--           to_regclass('public."CampaignCommerceProduct"') IS NOT NULL AS has_campaign_product;
--
--    Every column must be true.
--
-- 3. Confirm the specific composite unique keys this migration's composite
--    foreign keys target already exist. Without these, the ALTER TABLE ... ADD
--    CONSTRAINT statements below fail:
--
--    SELECT conname
--    FROM pg_constraint
--    WHERE conname IN (
--      'Campaign_id_brandId_key',
--      'BrandCommerceProduct_id_brandId_key'
--    );
--
--    Both names must be returned. (They are created as unique indexes by
--    20260807120000; PostgreSQL registers a matching unique constraint entry
--    for each, which is what a composite foreign key resolves against.)
--
-- 4. Confirm the new table does not already exist from a manual partial
--    application. Stop and investigate if this is true:
--
--    SELECT to_regclass('public."CampaignLessonProduct"') IS NOT NULL AS has_table;
--
-- ROLLBACK LIMITATION
-- --------------------
-- There is intentionally no automatic rollback SQL. Once attachment rows are
-- written, dropping this table destroys campaign-scoped lesson-product
-- attribution that CANNOT be re-derived from anything else: LessonProductLink
-- records which product was attached, but not which campaign authorized it, and
-- on a co-sponsored Experience that mapping is not recoverable from brandId
-- alone (two campaigns can share one brand).
--
-- Product DISPLAY is not lost by such a rollback: the LessonProductLink
-- snapshot rows survive independently, because legacyLessonProductLinkId is a
-- SET NULL reference from this table to them and never the other way round.
-- Only the campaign-scoping metadata is destroyed.
--
-- Restore from a database backup or export CampaignLessonProduct before
-- manually dropping the additive objects. Do not roll back by deleting
-- LessonProductLink or ExperienceProductLink rows; this migration never
-- touches either table.

-- CreateTable
CREATE TABLE "CampaignLessonProduct" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "brandCommerceProductId" TEXT NOT NULL,
    "legacyLessonProductLinkId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CampaignLessonProduct_pkey" PRIMARY KEY ("id")
);

-- At most one campaign-scoped attachment may claim a given LessonProductLink
-- snapshot, so the snapshot always has an unambiguous scoping row (or none).
-- CreateIndex
CREATE UNIQUE INDEX "CampaignLessonProduct_legacyLessonProductLinkId_key" ON "CampaignLessonProduct"("legacyLessonProductLinkId");

-- One lifecycle row per (campaign, lesson, brand product) makes duplicate
-- active attachments impossible and gives reactivation a deterministic target.
-- CreateIndex
CREATE UNIQUE INDEX "CampaignLessonProduct_campaignId_lessonId_brandCommerceProd_key" ON "CampaignLessonProduct"("campaignId", "lessonId", "brandCommerceProductId");

-- CreateIndex
CREATE INDEX "CampaignLessonProduct_lessonId_isActive_displayOrder_idx" ON "CampaignLessonProduct"("lessonId", "isActive", "displayOrder");

-- CreateIndex
CREATE INDEX "CampaignLessonProduct_campaignId_isActive_displayOrder_idx" ON "CampaignLessonProduct"("campaignId", "isActive", "displayOrder");

-- CreateIndex
CREATE INDEX "CampaignLessonProduct_brandId_campaignId_isActive_idx" ON "CampaignLessonProduct"("brandId", "campaignId", "isActive");

-- CreateIndex
CREATE INDEX "CampaignLessonProduct_brandCommerceProductId_isActive_idx" ON "CampaignLessonProduct"("brandCommerceProductId", "isActive");

-- AddForeignKey
ALTER TABLE "CampaignLessonProduct" ADD CONSTRAINT "CampaignLessonProduct_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLessonProduct" ADD CONSTRAINT "CampaignLessonProduct_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLessonProduct" ADD CONSTRAINT "CampaignLessonProduct_campaignId_brandId_fkey" FOREIGN KEY ("campaignId", "brandId") REFERENCES "Campaign"("id", "brandId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLessonProduct" ADD CONSTRAINT "CampaignLessonProduct_brandCommerceProductId_brandId_fkey" FOREIGN KEY ("brandCommerceProductId", "brandId") REFERENCES "BrandCommerceProduct"("id", "brandId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deliberately SET NULL, not CASCADE: see CASCADE REASONING above.
-- AddForeignKey
ALTER TABLE "CampaignLessonProduct" ADD CONSTRAINT "CampaignLessonProduct_legacyLessonProductLinkId_fkey" FOREIGN KEY ("legacyLessonProductLinkId") REFERENCES "LessonProductLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;
