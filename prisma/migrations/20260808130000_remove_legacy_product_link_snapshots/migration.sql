-- Migration: 20260808130000_remove_legacy_product_link_snapshots
--
-- Phase 8, Step 6. THIS IS A DESTRUCTIVE, IRREVERSIBLE MIGRATION. It is the
-- only destructive migration in Phase 8 and the only one in the repository that
-- drops a table.
--
-- It removes the legacy, free-form product SNAPSHOT representation now that the
-- canonical provider-verified chain has fully replaced it:
--
--   Brand -> CommerceConnection -> ConnectedCommerceProduct
--         -> BrandCommerceProduct -> CampaignCommerceProduct
--         -> CampaignLessonProduct
--
-- WHAT IS DROPPED (exactly six objects, nothing else)
-- ---------------------------------------------------
--   1. "CommerceClickAttribution"."lessonProductLinkId"      (DROP COLUMN)
--   2. "CommerceClickAttribution"."experienceProductLinkId"  (DROP COLUMN)
--   3. "CampaignLessonProduct"."legacyLessonProductLinkId"   (DROP COLUMN)
--   4. "LessonProductLink"                                   (DROP TABLE)
--   5. "ExperienceProductLink"                               (DROP TABLE)
--   6. "Campaign"."commerceProductCurationEnabled"           (DROP COLUMN)
--
-- Six dropped objects across two statement forms: FOUR DROP COLUMN and TWO
-- DROP TABLE, i.e. six DROP statements in total. There is no other DROP, and
-- no CASCADE, anywhere in this file.
--
-- NO ROWS ARE DELETED FROM ANY SURVIVING TABLE
-- --------------------------------------------
-- This migration contains no DELETE, no TRUNCATE, and no UPDATE statement.
-- `ALTER TABLE ... DROP COLUMN` removes a COLUMN, never a tuple. Every row in
-- every one of the following tables survives this migration untouched, keeping
-- its id and every other column value:
--
--   Campaign, CampaignLessonProduct, CommerceClickAttribution, Brand,
--   Experience, Course, Lesson, User, QRCode, QRCodeBatch, CampaignUnlock,
--   PointTransaction, UserPointAccount, ShopifyRewardRedemption,
--   BrandRewardOffer, BrandRewardOfferProduct, CommerceConnection,
--   CommerceConnectionSecret, ConnectedCommerceProduct, BrandCommerceProduct,
--   CampaignCommerceProduct, CampaignExperience, CommerceProductSyncRun,
--   CommerceOrder, CommerceOrderLineItem, CommerceOrderEvent.
--
-- In particular the points/money path (PointTransaction, UserPointAccount,
-- ShopifyRewardRedemption, BrandRewardOffer, BrandRewardOfferProduct) and the
-- entire Phase 7 order-normalization set (CommerceOrder,
-- CommerceOrderLineItem, CommerceOrderEvent) are not referenced by any
-- statement below at all.
--
-- ****************************************************************************
-- **                                                                        **
-- **  MANDATORY POST-DEPLOY STEP: FULL PRODUCT RESYNC FOR EVERY BRAND       **
-- **                                                                        **
-- **  This is NOT an optional follow-up. Public commerce is DOWN until it    **
-- **  runs.                                                                 **
-- **                                                                        **
-- **  20260808120000_add_connected_product_storefront_availability added    **
-- **  "ConnectedCommerceProduct"."hasPublicStorefrontUrl" with              **
-- **  DEFAULT false, so EVERY already-synced product row currently reads    **
-- **  false. Phase 8 Steps 3 and 4 now gate BOTH the public lesson/shop     **
-- **  RENDER path and the outbound CLICK/REDIRECT path on that column       **
-- **  being true.                                                           **
-- **                                                                        **
-- **  Consequence, stated plainly: immediately after this deploy every       **
-- **  already-synced product is treated as having NO public storefront      **
-- **  destination. It will NOT render on any public lesson or shop surface  **
-- **  and will NOT be clickable, for every brand, until that brand re-runs  **
-- **  a product sync and the sync repopulates the column from the           **
-- **  provider's Product.onlineStoreUrl.                                    **
-- **                                                                        **
-- **  This is deliberate fail-closed behavior and is precisely the fix for  **
-- **  the confirmed storefront-404 bug (a fabricated                        **
-- **  https://<shop>/products/<handle> URL was persisted with               **
-- **  isAvailable = true for unpublished / password-protected products, and **
-- **  the click route's host-equality destination validator could not       **
-- **  detect it because the fabricated host was the correct host).          **
-- **                                                                        **
-- **  Deploy runbook order:                                                 **
-- **    1. Operator manually clears the legacy rows (see PREFLIGHT below).  **
-- **    2. Apply this migration.                                            **
-- **    3. Run a product sync for EVERY connected brand.                    **
-- **    4. Spot-check one public lesson product renders and redirects.      **
-- **                                                                        **
-- ****************************************************************************
--
-- IRREVERSIBLE — WHAT CANNOT BE RECOVERED
-- ---------------------------------------
-- There is deliberately no down migration. Re-adding the dropped objects does
-- NOT restore their data:
--
--  * "Campaign"."commerceProductCurationEnabled" was BOOLEAN NOT NULL DEFAULT
--    false. Re-adding the column re-defaults EVERY campaign to false. The
--    per-campaign operator choice is unrecoverable from this database once the
--    column is dropped. (Phase 8 Step 5 removed all five code readers of this
--    column first, so it is provably unread before it is dropped. Dropping it
--    also defuses a live landmine: the column was DEFAULT false and was never
--    backfilled, so any authorization site that read it would have denied every
--    pre-existing campaign.)
--  * "LessonProductLink" and "ExperienceProductLink" row data
--    (productUrl / title / imageUrl / priceText / currency / brandId /
--    sourceShopDomain / createdAt) is unrecoverable. It was creator-typed,
--    provider-unverified snapshot data with no canonical source to re-derive
--    it from. The operator is expected to have already emptied both tables (see
--    PREFLIGHT), so in the expected case there is no data to lose — and if
--    there IS data, the preflight below ABORTS the deploy rather than
--    destroying it.
--  * "CommerceClickAttribution"."lessonProductLinkId" /
--    ."experienceProductLinkId" values are unrecoverable. The affected rows are
--    NOT deleted and keep "destinationUrl" / "destinationHost", so the click
--    itself remains provable; what is lost is the structured pointer to a
--    product row that will no longer exist anyway. Accepted evidence
--    degradation — quantify it with informational query (5) before deploying.
--  * "CampaignLessonProduct"."legacyLessonProductLinkId" values are
--    unrecoverable, and are already meaningless: Step 2 stopped reading and
--    writing this column entirely.
--
--
-- ============================================================================
-- INFORMATIONAL PRE-DEPLOY QUERIES (READ-ONLY; NOT EXECUTED BY THIS MIGRATION)
-- ============================================================================
-- Run these MANUALLY against production, as a human, immediately before
-- deploying, to see exactly what is about to be lost. They are SELECTs only and
-- mutate nothing. Do NOT run them from application code or a dev shell pointed
-- at production.
--
-- (1) Rows in the two tables about to be dropped. BOTH must be 0, or the
--     preflight gates below will abort the deploy:
--
--     SELECT
--       (SELECT count(*) FROM "ExperienceProductLink") AS experience_product_links,
--       (SELECT count(*) FROM "LessonProductLink")     AS lesson_product_links;
--
-- (2) Canonical lesson-attachment inventory that must survive:
--
--     SELECT count(*) AS total,
--            count(*) FILTER (WHERE "isActive")     AS active,
--            count(*) FILTER (WHERE NOT "isActive") AS inactive
--     FROM "CampaignLessonProduct";
--
-- (3) Broken or cross-brand ACTIVE canonical chains. Must be 0 — gate 3 below
--     aborts otherwise. This is the query whose result the gate enforces:
--
--     SELECT clp."id", clp."brandId", clp."campaignId", clp."lessonId",
--            clp."brandCommerceProductId"
--     FROM "CampaignLessonProduct" clp
--     LEFT JOIN "BrandCommerceProduct" bcp
--            ON bcp."id" = clp."brandCommerceProductId"
--     LEFT JOIN "ConnectedCommerceProduct" ccp
--            ON ccp."id" = bcp."connectedProductId"
--     WHERE clp."isActive"
--       AND (bcp."id" IS NULL
--            OR ccp."id" IS NULL
--            OR bcp."brandId" <> clp."brandId"
--            OR ccp."brandId" <> clp."brandId");
--
-- (4) Per-campaign curation flag, if the operator wants a record of the
--     unrecoverable choice before it is dropped. Export this if you care about
--     it; after deploy it is gone:
--
--     SELECT "id", "slug", "commerceProductCurationEnabled"
--     FROM "Campaign"
--     ORDER BY "createdAt";
--
-- (5) EVIDENCE DEGRADATION — attribution rows whose ONLY structured product
--     identity is one of the two columns being dropped. These rows are NOT
--     deleted and keep "destinationUrl"/"destinationHost", but after this
--     migration they no longer resolve to any product row. Record this number
--     as a conscious, accepted decision rather than discovering it later:
--
--     SELECT count(*) AS attribution_rows_losing_all_product_identity
--     FROM "CommerceClickAttribution"
--     WHERE ("lessonProductLinkId" IS NOT NULL
--            OR "experienceProductLinkId" IS NOT NULL)
--       AND "campaignLessonProductId" IS NULL
--       AND "brandCommerceProductId"  IS NULL;
--
--     Same population, broken out for the report:
--
--     SELECT count(*) FILTER (WHERE "lessonProductLinkId"     IS NOT NULL) AS via_lesson_link,
--            count(*) FILTER (WHERE "experienceProductLinkId" IS NOT NULL) AS via_experience_link,
--            count(*) AS total_rows_referencing_either
--     FROM "CommerceClickAttribution"
--     WHERE "lessonProductLinkId" IS NOT NULL
--        OR "experienceProductLinkId" IS NOT NULL;
--
-- (6) Confirm the prerequisite migrations are applied and not rolled back:
--
--     SELECT migration_name, finished_at, rolled_back_at
--     FROM _prisma_migrations
--     WHERE migration_name IN (
--       '20260807140000_add_campaign_lesson_product_scoping',
--       '20260807160000_add_commerce_click_attribution',
--       '20260808120000_add_connected_product_storefront_availability'
--     );
--
--     Three rows, each with non-null finished_at and null rolled_back_at.
--
-- (7) Confirm the mandatory resync scope (how many product rows are currently
--     fail-closed and therefore invisible until resynced):
--
--     SELECT count(*) FILTER (WHERE NOT "hasPublicStorefrontUrl") AS needs_resync,
--            count(*) AS total
--     FROM "ConnectedCommerceProduct";
--
-- ============================================================================
--
--
-- WHY THE PREFLIGHT GATES ARE WHAT THEY ARE
-- -----------------------------------------
-- Gates 1 and 2 refuse to drop a non-empty table. The operator is expected to
-- have manually cleaned both. This migration deliberately does NOT delete those
-- rows itself: unexpected rows mean the operator's assumption about production
-- was wrong, and the correct response to that is a loud, non-destructive abort,
-- not silent data destruction inside a schema migration.
--
-- Gate 3 verifies that every ACTIVE "CampaignLessonProduct" can still be
-- resolved AFTER the bridge column is gone: its "brandCommerceProductId" must
-- resolve to a "BrandCommerceProduct", which must resolve to a
-- "ConnectedCommerceProduct", and BOTH must belong to the same brand as the
-- attachment row. That is the real, load-bearing meaning of "valid canonical
-- lifecycle data that does not require the bridge".
--
-- WHAT GATE 3 DELIBERATELY DOES *NOT* CHECK, AND WHY THAT MATTERS
-- --------------------------------------------------------------
-- It does NOT fail on `isActive = true AND "legacyLessonProductLinkId" IS
-- NULL`. That check would look reasonable — the PRE-Phase-8 invariant really
-- was "an active scoping row bridges to a snapshot" — but applying it now would
-- be BACKWARDS and would abort the deploy on legitimately correct data, for two
-- independent reasons:
--
--   (a) Phase 8 Step 2 made creator attach fully canonical and stopped writing
--       the bridge altogether. Every row created since then is active with a
--       NULL bridge. That is the new CORRECT state, not corruption.
--   (b) The operator's manual deletion of all "LessonProductLink" rows fires
--       the existing ON DELETE SET NULL foreign key, which nulls the bridge on
--       any surviving "CampaignLessonProduct" that pointed at them.
--
-- So a NULL bridge on an active row is EXPECTED and FINE. The column is
-- provably unread by code and is dropped, not validated.
--
-- STATEMENT ORDER
-- ---------------
-- Every preflight block runs before every destructive statement, so an abort
-- leaves the schema byte-for-byte unchanged. The two DROP COLUMNs on
-- "CommerceClickAttribution" and the one on "CampaignLessonProduct" must
-- precede the DROP TABLEs, because those columns carry foreign keys referencing
-- the tables being dropped; dropping the referencing column first is what makes
-- the DROP TABLEs succeed without CASCADE.
--
-- NO CASCADE, ON PURPOSE
-- ----------------------
-- Both DROP TABLE statements are plain DROP TABLE, never DROP TABLE ... CASCADE.
-- If some dependency on these tables still exists that this migration did not
-- anticipate (a view, another foreign key, a trigger), PostgreSQL must ABORT the
-- deploy and name it, rather than silently dropping it as collateral. A loud
-- failure here is the desired outcome: it is recoverable, and silent collateral
-- destruction of an unknown dependent object is not.


-- ============================================================================
-- PREFLIGHT GATE 1 of 3 — "ExperienceProductLink" must already be empty.
-- ============================================================================
DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining FROM "ExperienceProductLink";
  IF remaining > 0 THEN
    RAISE EXCEPTION
      'ABORT 20260808130000: table "ExperienceProductLink" still contains % row(s); this migration drops that table and refuses to destroy rows it did not expect. REQUIRED ACTION: inspect that table, then clear the rows deliberately as a separate, reviewed operation, then re-run this deploy. This migration will not remove them for you.',
      remaining;
  END IF;
END $$;

-- ============================================================================
-- PREFLIGHT GATE 2 of 3 — "LessonProductLink" must already be empty.
-- ============================================================================
DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining FROM "LessonProductLink";
  IF remaining > 0 THEN
    RAISE EXCEPTION
      'ABORT 20260808130000: table "LessonProductLink" still contains % row(s); this migration drops that table and refuses to destroy rows it did not expect. REQUIRED ACTION: inspect that table, then clear the rows deliberately as a separate, reviewed operation, then re-run this deploy. This migration will not remove them for you.',
      remaining;
  END IF;
END $$;

-- ============================================================================
-- PREFLIGHT GATE 3 of 3 — every ACTIVE "CampaignLessonProduct" must have an
-- intact, same-brand canonical chain that survives the bridge column's removal:
--   CampaignLessonProduct.brandCommerceProductId
--     -> BrandCommerceProduct (same brandId)
--       -> ConnectedCommerceProduct (same brandId)
--
-- This does NOT gate on "legacyLessonProductLinkId" being NULL. A NULL bridge
-- on an active row is the correct post-Step-2 state and is also produced by the
-- operator's cleanup firing ON DELETE SET NULL. See the header for why the
-- inverse check would be wrong.
-- ============================================================================
DO $$
DECLARE
  broken bigint;
BEGIN
  SELECT count(*) INTO broken
  FROM "CampaignLessonProduct" clp
  LEFT JOIN "BrandCommerceProduct" bcp
         ON bcp."id" = clp."brandCommerceProductId"
  LEFT JOIN "ConnectedCommerceProduct" ccp
         ON ccp."id" = bcp."connectedProductId"
  WHERE clp."isActive"
    AND (bcp."id" IS NULL
         OR ccp."id" IS NULL
         OR bcp."brandId" <> clp."brandId"
         OR ccp."brandId" <> clp."brandId");

  IF broken > 0 THEN
    RAISE EXCEPTION
      'ABORT 20260808130000: % active "CampaignLessonProduct" row(s) have a broken or cross-brand canonical chain (brandCommerceProductId does not resolve to a BrandCommerceProduct, or that row does not resolve to a ConnectedCommerceProduct, or either resolved row belongs to a different brandId than the attachment). After this migration the legacy bridge column is gone and the canonical chain is the ONLY way to resolve these rows, so they must be valid first. REQUIRED ACTION: run the LEFT JOIN diagnostic in this migration header (informational query 3) to list the offending ids, then either repair the chain or deactivate those attachments, and re-run this deploy.',
      broken;
  END IF;
END $$;


-- ============================================================================
-- DESTRUCTIVE SECTION. Nothing below this line runs if any gate above raised.
-- ============================================================================

-- DropForeignKey / DropColumn: remove the referencing columns BEFORE the
-- referenced tables. Each DROP COLUMN takes its own foreign-key constraint and
-- its index with it. No CommerceClickAttribution row is deleted; the rows keep
-- destinationUrl/destinationHost (see informational query 5).
ALTER TABLE "CommerceClickAttribution" DROP COLUMN "lessonProductLinkId";

ALTER TABLE "CommerceClickAttribution" DROP COLUMN "experienceProductLinkId";

-- DropColumn: the legacy bridge. Takes the unique index
-- "CampaignLessonProduct_legacyLessonProductLinkId_key" and the ON DELETE SET
-- NULL foreign key to "LessonProductLink" with it. No CampaignLessonProduct row
-- is deleted; the @@unique([campaignId, lessonId, brandCommerceProductId])
-- lifecycle key is untouched and remains the row identity.
ALTER TABLE "CampaignLessonProduct" DROP COLUMN "legacyLessonProductLinkId";

-- DropTable: plain DROP TABLE, deliberately NOT CASCADE (see header). Verified
-- empty by preflight gates 2 and 1 respectively.
DROP TABLE "LessonProductLink";

DROP TABLE "ExperienceProductLink";

-- DropColumn: the LEGACY/CURATED mode flag. Phase 8 Step 5 removed all five
-- code readers, so this column is provably unread. Dropping it is irreversible:
-- re-adding it re-defaults every campaign to false (see header).
ALTER TABLE "Campaign" DROP COLUMN "commerceProductCurationEnabled";
