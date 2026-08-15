-- Phase 11.1 — canonical immutable Campaign ownership + redundant click Brand removal
--
-- PREFLIGHT
-- The operator must assign or remove every legacy unbranded Campaign before
-- this migration. This migration deliberately performs NO Campaign backfill,
-- deletion, or other data mutation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Campaign" WHERE "brandId" IS NULL) THEN
    RAISE EXCEPTION
      'Phase 11.1 blocked: Campaign.brandId is NULL. Complete manual Campaign ownership cleanup before migrating.';
  END IF;
END $$;

-- Canonical ownership is required after the preflight passes.
ALTER TABLE "Campaign" ALTER COLUMN "brandId" SET NOT NULL;

-- DEFENSE IN DEPTH
-- Campaign ownership is immutable after creation. Normal metadata updates are
-- unaffected; a no-op assignment to the same Brand is allowed.
CREATE OR REPLACE FUNCTION "prevent_campaign_brand_reassignment"()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."brandId" IS DISTINCT FROM NEW."brandId" THEN
    RAISE EXCEPTION 'Campaign brand ownership is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Campaign_brandId_immutable"
BEFORE UPDATE OF "brandId" ON "Campaign"
FOR EACH ROW
EXECUTE FUNCTION "prevent_campaign_brand_reassignment"();

-- CLICK EVIDENCE
-- `attributedBrandId` is the sole durable historical Brand attribution scalar.
-- It is intentionally not backfilled: pre-Phase-10 null values remain UNKNOWN.
-- No CommerceClickAttribution row is deleted by this migration.
ALTER TABLE "CommerceClickAttribution"
  DROP CONSTRAINT "CommerceClickAttribution_productCampaignId_brandId_fkey";

ALTER TABLE "CommerceClickAttribution"
  DROP CONSTRAINT "CommerceClickAttribution_brandId_fkey";

ALTER TABLE "CommerceClickAttribution"
  ADD CONSTRAINT "CommerceClickAttribution_productCampaignId_fkey"
  FOREIGN KEY ("productCampaignId") REFERENCES "Campaign"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

DROP INDEX "CommerceClickAttribution_brandId_createdAt_idx";

ALTER TABLE "CommerceClickAttribution" DROP COLUMN "brandId";

-- ROLLBACK LIMITATION
-- Restoring the deleted redundant click brandId would require inventing or
-- copying historical values, which this migration intentionally refuses to do.
