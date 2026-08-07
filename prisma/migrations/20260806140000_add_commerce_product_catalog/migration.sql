-- Migration: 20260806140000_add_commerce_product_catalog
--
-- Adds the provider-neutral commerce product catalog on top of the
-- CommerceConnection abstraction created by
-- 20260806120000_add_commerce_connection_abstraction. It creates one new enum
-- (CommerceProductSyncRunStatus) and three new tables:
--
--   * ConnectedCommerceProduct -- the mirrored merchant catalog. One row per
--     product per connection.
--   * CommerceProductSyncRun   -- one row per catalog sync attempt, for
--     observability and partial-failure diagnosis.
--   * BrandCommerceProduct     -- brand-side curation (shop visibility,
--     campaign eligibility, ordering, display overrides) layered on top of a
--     mirrored product.
--
-- This migration is purely additive and forward-only: only CREATE TYPE,
-- CREATE TABLE, CREATE INDEX, CREATE UNIQUE INDEX and ALTER TABLE ... ADD
-- CONSTRAINT (foreign keys). It contains no DROP, no ALTER COLUMN, and no
-- UPDATE/DELETE/TRUNCATE. It does not touch any existing table, column, row,
-- index or enum -- in particular it does not read, modify or backfill from the
-- 16 Brand.shopify* columns, ExperienceProductLink, LessonProductLink,
-- BrandRewardOffer(Product), ShopifyRewardRedemption, CommerceConnection or
-- CommerceConnectionSecret.
--
-- ─── UNIQUENESS ──────────────────────────────────────────────────────────────
-- The core constraint is ConnectedCommerceProduct_connectionId_externalKey_key
-- -- UNIQUE ("connectionId", "externalKey"), i.e. connection-scoped, NOT
-- global. "externalKey" is a stable provider-scoped key (for Shopify, the
-- product gid). Provider product ids are only unique WITHIN a store, so two
-- different stores (two CommerceConnection rows) can legitimately surface the
-- same gid for two entirely unrelated products. A global unique on
-- "externalKey" or "externalId" would make the second store's sync collide
-- with the first store's catalog and silently cross-link merchants' products.
-- Do NOT add a global unique to either column.
--
-- ─── MONEY ───────────────────────────────────────────────────────────────────
-- Prices are stored exclusively as INTEGER minor units ("priceMinMinor",
-- "priceMaxMinor", with "priceMinorUnitExponent" recording the currency's
-- minor-unit exponent). No FLOAT/DOUBLE/DECIMAL/NUMERIC price column exists in
-- this migration and none may be added later. "currencyCode" is deliberately
-- NULLABLE with no DEFAULT: the current product pipeline has a real currency
-- defaulting bug, and persisting a wrong currency is strictly worse than
-- persisting none -- a null means "currency unknown, do not render a price",
-- which is recoverable; a wrong currency is not.
--
-- "failureSummary" on CommerceProductSyncRun holds SANITIZED text only. Never
-- write a raw error object, request URL, access token, or provider response
-- body into it.
--
-- ─── CASCADE REASONING ───────────────────────────────────────────────────────
-- Every foreign key here is ON DELETE CASCADE, which is deliberate:
--
--   * Shopify's `shop/redact` GDPR webhook HARD-DELETES the CommerceConnection
--     row. Cascading the catalog away on that deletion is the CORRECT
--     behaviour: ConnectedCommerceProduct is a mirror of merchant product
--     data, and a GDPR erasure must not leave a full product mirror of the
--     erased shop behind.
--   * BrandCommerceProduct cascades too, which loses brand curation. That loss
--     is ACCEPTED: the curation is unrenderable without the products it points
--     at, and its override fields (title/description/image overrides) are
--     themselves derived from merchant data that is being erased.
--   * `app/uninstalled` does NOT delete the connection -- it sets
--     status = 'UNINSTALLED' and preserves the row. So the catalog correctly
--     SURVIVES an uninstall/relink cycle and is erased only on a genuine
--     redaction.
--
-- ─── PREFLIGHT ───────────────────────────────────────────────────────────────
-- This migration adds foreign keys referencing "CommerceConnection"("id"), so
-- it FAILS OUTRIGHT (Postgres error 42P01, relation does not exist) if
-- 20260806120000_add_commerce_connection_abstraction has not been applied to
-- the target database. Confirm it is applied BEFORE running this migration.
--
-- 1. Confirm the migration is recorded as applied -- expect exactly one row
--    with a non-null finished_at and rolled_back_at IS NULL:
--
--    SELECT migration_name, finished_at, rolled_back_at
--    FROM _prisma_migrations
--    WHERE migration_name = '20260806120000_add_commerce_connection_abstraction';
--
-- 2. Do not trust the tracking table alone (see docs/prisma-migrations.md on
--    this repository's historical local-vs-production divergence). Also
--    confirm the objects this migration depends on actually exist -- expect
--    exactly one row, and both boolean columns true:
--
--    SELECT to_regclass('public."CommerceConnection"') IS NOT NULL AS has_table,
--           EXISTS (
--             SELECT 1 FROM pg_type WHERE typname = 'CommerceProvider'
--           ) AS has_provider_enum;
--
-- 3. Confirm the enum type this migration creates does not already exist
--    (expect zero rows; a row means a partial/manual application happened and
--    must be understood before proceeding):
--
--    SELECT typname FROM pg_type WHERE typname = 'CommerceProductSyncRunStatus';
--
-- If step 1 or 2 fails, STOP. Apply
-- 20260806120000_add_commerce_connection_abstraction first; do not hand-create
-- the missing table.
--
-- ─── EXPECTED DRIFT ──────────────────────────────────────────────────────────
-- `prisma migrate diff` / `prisma migrate status` will continue to report the
-- two pre-existing DB-ONLY partial unique indexes as drift:
--   * CommerceConnection_brandId_provider_primary_key
--     (20260806130000_commerce_connection_single_primary)
--   * CampaignUnlock_campaignId_anonKey_key
--     (20260615113320_campaign_unlock_anon_unique)
-- Prisma cannot express partial unique indexes, so that drift is intentional
-- and permanent. It must NOT be "cleaned up" (do not drop either index, do not
-- add a non-partial @@unique to schema.prisma), and it must NOT be read as
-- evidence that this migration is missing or was not applied.
--
-- No CONCURRENTLY is used anywhere below: `prisma migrate deploy` wraps each
-- migration file in a transaction and CREATE INDEX CONCURRENTLY cannot run
-- inside one (same reasoning documented in
-- 20260806130000_commerce_connection_single_primary). These are all brand-new,
-- empty tables, so plain index creation is instant and locks nothing real.
-- ─────────────────────────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "CommerceProductSyncRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "ConnectedCommerceProduct" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "provider" "CommerceProvider" NOT NULL,
    "externalKey" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "productUrl" TEXT NOT NULL,
    "imageUrl" TEXT,
    "images" TEXT[],
    "externalVariantIds" TEXT[],
    "descriptionText" TEXT,
    "sku" TEXT,
    "currencyCode" TEXT,
    "priceMinMinor" INTEGER,
    "priceMaxMinor" INTEGER,
    "priceMinorUnitExponent" INTEGER,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unavailableSince" TIMESTAMP(3),
    "providerCreatedAt" TIMESTAMP(3),
    "providerUpdatedAt" TIMESTAMP(3),
    "providerMetadata" JSONB,
    "lastSyncRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedCommerceProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceProductSyncRun" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "provider" "CommerceProvider" NOT NULL,
    "status" "CommerceProductSyncRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "fetchedCount" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "updatedCount" INTEGER NOT NULL DEFAULT 0,
    "unchangedCount" INTEGER NOT NULL DEFAULT 0,
    "markedUnavailableCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "hasNextPage" BOOLEAN NOT NULL DEFAULT false,
    "requestedLimit" INTEGER,
    "failureSummary" TEXT,
    "triggeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceProductSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandCommerceProduct" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "connectedProductId" TEXT NOT NULL,
    "isVisibleInShop" BOOLEAN NOT NULL DEFAULT false,
    "isCampaignEligible" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "titleOverride" TEXT,
    "shortDescriptionOverride" TEXT,
    "imageUrlOverride" TEXT,
    "approvedByUserId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandCommerceProduct_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConnectedCommerceProduct_connectionId_idx" ON "ConnectedCommerceProduct"("connectionId");

-- CreateIndex
CREATE INDEX "ConnectedCommerceProduct_connectionId_isAvailable_idx" ON "ConnectedCommerceProduct"("connectionId", "isAvailable");

-- CreateIndex
-- "brandId" is denormalized onto ConnectedCommerceProduct deliberately (it is
-- derivable via "connectionId" -> CommerceConnection."brandId") so that the
-- brand authorization filter is a single indexed predicate with no join.
CREATE INDEX "ConnectedCommerceProduct_brandId_idx" ON "ConnectedCommerceProduct"("brandId");

-- CreateIndex
CREATE INDEX "ConnectedCommerceProduct_brandId_isAvailable_idx" ON "ConnectedCommerceProduct"("brandId", "isAvailable");

-- CreateIndex
CREATE INDEX "ConnectedCommerceProduct_connectionId_lastSeenAt_idx" ON "ConnectedCommerceProduct"("connectionId", "lastSeenAt");

-- CreateIndex
-- Connection-scoped, NOT global -- see the UNIQUENESS note in the header.
CREATE UNIQUE INDEX "ConnectedCommerceProduct_connectionId_externalKey_key" ON "ConnectedCommerceProduct"("connectionId", "externalKey");

-- CreateIndex
CREATE INDEX "CommerceProductSyncRun_connectionId_startedAt_idx" ON "CommerceProductSyncRun"("connectionId", "startedAt");

-- CreateIndex
CREATE INDEX "CommerceProductSyncRun_brandId_startedAt_idx" ON "CommerceProductSyncRun"("brandId", "startedAt");

-- CreateIndex
CREATE INDEX "CommerceProductSyncRun_status_idx" ON "CommerceProductSyncRun"("status");

-- CreateIndex
CREATE INDEX "BrandCommerceProduct_brandId_isVisibleInShop_displayOrder_idx" ON "BrandCommerceProduct"("brandId", "isVisibleInShop", "displayOrder");

-- CreateIndex
CREATE INDEX "BrandCommerceProduct_brandId_isCampaignEligible_idx" ON "BrandCommerceProduct"("brandId", "isCampaignEligible");

-- CreateIndex
CREATE INDEX "BrandCommerceProduct_connectedProductId_idx" ON "BrandCommerceProduct"("connectedProductId");

-- CreateIndex
CREATE UNIQUE INDEX "BrandCommerceProduct_brandId_connectedProductId_key" ON "BrandCommerceProduct"("brandId", "connectedProductId");

-- AddForeignKey
ALTER TABLE "ConnectedCommerceProduct" ADD CONSTRAINT "ConnectedCommerceProduct_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CommerceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedCommerceProduct" ADD CONSTRAINT "ConnectedCommerceProduct_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceProductSyncRun" ADD CONSTRAINT "CommerceProductSyncRun_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CommerceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceProductSyncRun" ADD CONSTRAINT "CommerceProductSyncRun_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandCommerceProduct" ADD CONSTRAINT "BrandCommerceProduct_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandCommerceProduct" ADD CONSTRAINT "BrandCommerceProduct_connectedProductId_fkey" FOREIGN KEY ("connectedProductId") REFERENCES "ConnectedCommerceProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── ROLLBACK ─────────────────────────────────────────────────────────────────
-- Drop in this order (children before parents; each table is referenced by the
-- one above it, so any other order fails on a dependent foreign key):
--
-- DROP TABLE "BrandCommerceProduct";
-- DROP TABLE "CommerceProductSyncRun";
-- DROP TABLE "ConnectedCommerceProduct";
-- DROP TYPE "CommerceProductSyncRunStatus";
--
-- Rollback limitations -- read before doing this:
--
-- (a) Dropping "BrandCommerceProduct" DESTROYS brand curation that CANNOT be
--     re-derived from any provider. Visibility flags, campaign eligibility,
--     display ordering, the title/description/image overrides and the approval
--     record are all first-party data entered by brand staff; no Shopify or
--     Commerce7 re-sync can reconstruct them. "ConnectedCommerceProduct" and
--     "CommerceProductSyncRun", by contrast, are re-derivable (a mirror and a
--     log). If any curation rows exist, export them before dropping.
--
-- (b) The new Postgres enum type "CommerceProductSyncRunStatus" cannot be
--     dropped while ANY column of that type still exists -- including a column
--     that merely has a DEFAULT of that type, as
--     "CommerceProductSyncRun"."status" does. DROP TYPE must therefore come
--     strictly after the DROP TABLE above. Relatedly, once this enum ships, an
--     individual enum VALUE cannot be removed in place; retiring a value
--     requires creating a replacement type and rewriting every dependent
--     column.
--
-- (c) This rollback does not restore anything the forward migration removed,
--     because the forward migration removes nothing. Rolling back is purely a
--     matter of discarding new tables and the data accumulated in them.
