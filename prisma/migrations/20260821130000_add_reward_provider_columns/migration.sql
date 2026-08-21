-- Phase 15C1 EXPAND only: keep existing Shopify reward writers compatible
-- while recording the provider required for future exact-account resolution.
-- The temporary SHOPIFY defaults are intentional. Phase 15C2 must write
-- provider explicitly, and a later contract phase must remove these defaults.

ALTER TABLE "BrandRewardOffer"
  ADD COLUMN "provider" "CommerceProvider" NOT NULL DEFAULT 'SHOPIFY';

ALTER TABLE "ShopifyRewardRedemption"
  ADD COLUMN "provider" "CommerceProvider" NOT NULL DEFAULT 'SHOPIFY';

-- Preserve existing [brandId, sourceShopDomain] and add the provider-aware
-- identity that Phase 15C2 will use to bind historical reward state safely.
CREATE INDEX "BrandRewardOffer_brandId_provider_sourceShopDomain_idx"
  ON "BrandRewardOffer"("brandId", "provider", "sourceShopDomain");

CREATE INDEX "ShopifyRewardRedemption_brandId_provider_shopifyShopDomain_idx"
  ON "ShopifyRewardRedemption"("brandId", "provider", "shopifyShopDomain");
