-- Migration: 20260807160000_add_commerce_click_attribution
--
-- Phase 6's secure click-attribution foundation. This migration is additive and
-- forward-only: it adds one table, its unique index, its indexes, and its
-- foreign keys. It contains no UPDATE, DELETE, TRUNCATE, dropped object,
-- altered column, or type conversion. No existing table, column, or index is
-- modified, so there is nothing to back-fill and every pre-existing
-- LessonProductLink / ExperienceProductLink / CampaignLessonProduct row is
-- untouched and keeps behaving exactly as before.
--
-- WHY THIS TABLE EXISTS
-- ---------------------
-- Until Phase 6 there was no server hop on the commerce path at all: the shop
-- and lesson clients called window.open() directly on the raw, unmodified
-- merchant product URL and then fired a fire-and-forget analytics beacon. That
-- records that a click happened, but it produces no server-minted, unforgeable
-- artifact tying a specific visitor, in a specific validated campaign context,
-- to a specific destination at a specific time. This table is that artifact.
--
-- It records EVIDENCE OF A CLICK and nothing else. There are deliberately no
-- money, order, quantity, or conversion columns: whether a purchase followed is
-- not knowable here and must not be implied by this schema.
--
-- TOKEN HANDLING
-- --------------
-- The plaintext click token (32 random bytes, base64url) is generated per
-- request, travels to the browser in the redirect URL, and is NEVER persisted
-- — not in this table, not in any log. Only "tokenHash" is stored: HMAC-SHA-256
-- keyed by the COMMERCE_CLICK_TOKEN_PEPPER environment variable over a
-- versioned, domain-separated input ("sqratch-commerce-click:v1:<token>"). This
-- is the same construction and the same hash-only storage discipline already
-- used by EmailVerificationToken.codeHash (see
-- src/lib/auth/email-verification-crypto.ts), not a new crypto scheme.
--
-- "tokenHash" is UNIQUE because it is the only lookup key any future redemption
-- path may use. "tokenPrefix" is a short, non-secret leading slice retained for
-- operator triage only; it is far too short to reconstruct the token.
--
-- TRANSPORT REALITY (deliberately recorded here so no future reader overstates
-- what this table proves)
-- -------------------------------------------------------------------------
-- SQRATCH's Shopify app holds only read_products, read_discounts and
-- write_discounts. It has no read_orders scope, no orders webhook, and no
-- checkout/theme/admin extension of any kind. Appending the click token to a
-- merchant product URL therefore has NO guaranteed mechanism today to survive
-- into a merchant order. Phase 6 builds the foundation and a forward seam only.
-- This table must never be described as live order attribution.
--
-- CAMPAIGN SEMANTICS AND SAME-BRAND INTEGRITY
-- --------------------
-- A click has TWO deliberately independent campaign facts:
--
--   entryCampaignId     = trusted visitor acquisition/entry context
--   productCampaignId   = server-derived campaign that authorized the product
--
-- Entry context intentionally has a simple FK: a visitor acquired through
-- Campaign A may click intentionally-global content from Brand B, and that
-- must retain Campaign A acquisition evidence without claiming the product was
-- authorized by Campaign A. Product authorization uses the same-brand
-- composite FK used by CampaignCommerceProduct and CampaignLessonProduct:
--
--   (productCampaignId, brandId) -> Campaign(id, brandId)
--
-- PostgreSQL therefore rejects a cross-brand product authorization even if a
-- caller bypasses the application service. The target composite unique key
-- (Campaign_id_brandId_key) was created by 20260807120000, so this migration
-- adds no unique index to any pre-existing table.
--
-- All campaign columns are nullable. A direct Experience entry deliberately
-- records entryCampaignId NULL; it may still record a non-null
-- productCampaignId for a campaign-scoped product. A generic direct brand
-- storefront product correctly leaves both campaign columns null.
--
-- CASCADE REASONING
-- -----------------
-- Every optional foreign key is ON DELETE SET NULL, not CASCADE. A click record
-- is historical evidence: it must survive the deletion of the brand, campaign,
-- course, lesson, catalog product, product link, connection, user, session, QR
-- code, or unlock it happened to reference. Destroying the evidence because a
-- referenced entity was later removed would lose data that cannot be
-- re-derived. "destinationUrl"/"destinationHost"/"createdAt" are non-null and
-- unaffected by any such deletion, so a row always remains meaningful.
--
-- "experienceId" is the single exception: it is REQUIRED, so there is no valid
-- orphan state for it and Experience deletion cascades. An Experience is the
-- surface the click physically occurred on; a click with no surface is not a
-- record worth keeping.
--
-- KNOWN LIMITATION of the composite product-campaign foreign key: because SET
-- NULL on a multi-column foreign key nulls ALL of its columns, deleting that
-- Campaign nulls both "productCampaignId" AND "brandId" on affected rows. The
-- brand association is therefore lost alongside product authorization in that
-- specific case; entryCampaignId is unaffected.
-- This is an accepted trade: the alternative (ON DELETE CASCADE) would delete
-- the click rows outright, which is strictly worse. Anything that needs
-- brand-durable click history across campaign deletion must denormalize the
-- brand into a non-foreign-key column in a later, deliberately reviewed change.
--
-- PREFLIGHT (run manually immediately before deploying; do NOT run during
-- development against a production DATABASE_URL):
--
-- 1. Confirm all prerequisite migrations are applied and not rolled back. This
--    migration's foreign keys depend on all of them:
--
--    SELECT migration_name, finished_at, rolled_back_at
--    FROM _prisma_migrations
--    WHERE migration_name IN (
--      '20260806120000_add_commerce_connection_abstraction',
--      '20260806140000_add_commerce_product_catalog',
--      '20260807120000_add_campaign_commerce_product_curation',
--      '20260807140000_add_campaign_lesson_product_scoping'
--    )
--    ORDER BY migration_name;
--
--    All four rows must be present with a non-null finished_at and a null
--    rolled_back_at. Stop if any is missing.
--
-- 2. Confirm the tables those migrations created actually exist:
--
--    SELECT to_regclass('public."CommerceConnection"')       IS NOT NULL AS has_commerce_connection,
--           to_regclass('public."ConnectedCommerceProduct"') IS NOT NULL AS has_connected_product,
--           to_regclass('public."BrandCommerceProduct"')     IS NOT NULL AS has_brand_product,
--           to_regclass('public."CampaignCommerceProduct"')  IS NOT NULL AS has_campaign_product,
--           to_regclass('public."CampaignLessonProduct"')    IS NOT NULL AS has_campaign_lesson_product;
--
--    Every column must be true.
--
-- 3. Confirm the composite unique key this migration's composite foreign key
--    targets already exists. Without it, the ALTER TABLE ... ADD CONSTRAINT
--    statement below fails:
--
--        SELECT
--            indexname,
--            indexdef
--        FROM pg_indexes
--        WHERE schemaname = 'public'
--            AND tablename = 'Campaign'
--            AND indexname = 'Campaign_id_brandId_key';
--
--    The name must be returned. (It is created as a unique index by
--    20260807120000; PostgreSQL registers a matching unique constraint entry,
--    which is what a composite foreign key resolves against.)
--
-- 4. Confirm the new table does not already exist from a manual partial
--    application. Stop and investigate if this is true:
--
--    SELECT to_regclass('public."CommerceClickAttribution"') IS NOT NULL AS has_table;
--
-- 5. Confirm the application environment defines COMMERCE_CLICK_TOKEN_PEPPER
--    before deploying the code that writes to this table. The token module
--    fails closed (throws) when it is missing, which the click route degrades
--    into "redirect without minting an attribution row" — the redirect keeps
--    working, but no evidence is recorded. Do not verify this by printing the
--    value.
--
-- ROLLBACK LIMITATION
-- --------------------
-- There is intentionally no automatic rollback SQL. Once click rows are
-- written, dropping this table destroys click evidence that CANNOT be
-- re-derived from anything else. The AnalyticsEvent "shop_click" /
-- "lesson_product_click" beacons are NOT a substitute: they are client-fired,
-- forgeable, carry no server-minted token, and do not record the validated
-- campaign context or the destination host.
--
-- Nothing else depends on this table, so a rollback breaks no other feature:
-- the redirect route degrades to redirecting without minting (see the
-- fail-open behavior in src/lib/commerce/click-attribution.ts), and every
-- product link, catalog row, and campaign attachment is entirely unaffected
-- because no pre-existing table references this one.
--
-- Restore from a database backup or export CommerceClickAttribution before
-- manually dropping the additive objects.

-- CreateTable
CREATE TABLE "CommerceClickAttribution" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "brandId" TEXT,
    "entryCampaignId" TEXT,
    "productCampaignId" TEXT,
    "entryCampaignContextResolved" BOOLEAN NOT NULL DEFAULT false,
    "experienceId" TEXT NOT NULL,
    "courseId" TEXT,
    "lessonId" TEXT,
    "creatorProfileId" TEXT,
    "brandCommerceProductId" TEXT,
    "connectedProductId" TEXT,
    "lessonProductLinkId" TEXT,
    "experienceProductLinkId" TEXT,
    "campaignLessonProductId" TEXT,
    "commerceConnectionId" TEXT,
    "destinationUrl" TEXT NOT NULL,
    "destinationHost" TEXT NOT NULL,
    "provider" "CommerceProvider",
    "userId" TEXT,
    "sessionId" TEXT,
    "qrCodeId" TEXT,
    "campaignUnlockId" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "referrer" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redirectedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "consumedByOrderRef" TEXT,

    CONSTRAINT "CommerceClickAttribution_pkey" PRIMARY KEY ("id")
);

-- The hash of the click token is the ONLY key a redirect-time or future
-- redemption-time lookup may use, so it must be unique. The plaintext token is
-- never stored in any column of this table.
-- CreateIndex
CREATE UNIQUE INDEX "CommerceClickAttribution_tokenHash_key" ON "CommerceClickAttribution"("tokenHash");

-- CreateIndex
CREATE INDEX "CommerceClickAttribution_brandId_createdAt_idx" ON "CommerceClickAttribution"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceClickAttribution_entryCampaignId_createdAt_idx" ON "CommerceClickAttribution"("entryCampaignId", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceClickAttribution_productCampaignId_createdAt_idx" ON "CommerceClickAttribution"("productCampaignId", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceClickAttribution_experienceId_createdAt_idx" ON "CommerceClickAttribution"("experienceId", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceClickAttribution_sessionId_createdAt_idx" ON "CommerceClickAttribution"("sessionId", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceClickAttribution_userId_createdAt_idx" ON "CommerceClickAttribution"("userId", "createdAt");

-- Abuse review groups clicks by where they were sent, not by which brand row
-- claimed them, so destinationHost is indexed independently.
-- CreateIndex
CREATE INDEX "CommerceClickAttribution_destinationHost_createdAt_idx" ON "CommerceClickAttribution"("destinationHost", "createdAt");

-- CreateIndex
CREATE INDEX "CommerceClickAttribution_expiresAt_idx" ON "CommerceClickAttribution"("expiresAt");

-- CreateIndex
CREATE INDEX "CommerceClickAttribution_consumedAt_idx" ON "CommerceClickAttribution"("consumedAt");

-- Every foreign key below except experienceId is SET NULL: see CASCADE
-- REASONING above.
-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Entry/acquisition context is independent from the clicked product's brand.
-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_entryCampaignId_fkey" FOREIGN KEY ("entryCampaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Product authorization remains same-brand at the database level.
-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_productCampaignId_brandId_fkey" FOREIGN KEY ("productCampaignId", "brandId") REFERENCES "Campaign"("id", "brandId") ON DELETE SET NULL ON UPDATE CASCADE;

-- The one CASCADE: experienceId is required, so no orphan state exists.
-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_experienceId_fkey" FOREIGN KEY ("experienceId") REFERENCES "Experience"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_creatorProfileId_fkey" FOREIGN KEY ("creatorProfileId") REFERENCES "CreatorProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_brandCommerceProductId_fkey" FOREIGN KEY ("brandCommerceProductId") REFERENCES "BrandCommerceProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_connectedProductId_fkey" FOREIGN KEY ("connectedProductId") REFERENCES "ConnectedCommerceProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_lessonProductLinkId_fkey" FOREIGN KEY ("lessonProductLinkId") REFERENCES "LessonProductLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_experienceProductLinkId_fkey" FOREIGN KEY ("experienceProductLinkId") REFERENCES "ExperienceProductLink"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_campaignLessonProductId_fkey" FOREIGN KEY ("campaignLessonProductId") REFERENCES "CampaignLessonProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_commerceConnectionId_fkey" FOREIGN KEY ("commerceConnectionId") REFERENCES "CommerceConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "UserSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_qrCodeId_fkey" FOREIGN KEY ("qrCodeId") REFERENCES "QRCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceClickAttribution" ADD CONSTRAINT "CommerceClickAttribution_campaignUnlockId_fkey" FOREIGN KEY ("campaignUnlockId") REFERENCES "CampaignUnlock"("id") ON DELETE SET NULL ON UPDATE CASCADE;
