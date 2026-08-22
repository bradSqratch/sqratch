-- Phase 15C3: provider identity is required from every reward writer.
-- This contracts only the temporary Phase 15C1 defaults; it does not rewrite rows.
ALTER TABLE "BrandRewardOffer" ALTER COLUMN "provider" DROP DEFAULT;

ALTER TABLE "ShopifyRewardRedemption" ALTER COLUMN "provider" DROP DEFAULT;
