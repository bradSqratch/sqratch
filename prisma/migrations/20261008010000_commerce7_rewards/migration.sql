-- Additive reward saga; operator preflight/rollback: docs/commerce/commerce7-rewards.md.
CREATE TYPE "RewardMode" AS ENUM ('DISCOUNT', 'EXCLUSIVE_PRODUCT_ACCESS');
CREATE TYPE "RewardProvisioningState" AS ENUM ('AWAITING_CUSTOMER', 'AWAITING_ELIGIBILITY', 'PROVISIONING', 'READY', 'FAILED_RETRYABLE', 'MANUAL_REVIEW', 'FAILED_FINAL', 'REVOKED');
ALTER TABLE "BrandRewardOffer"
  ADD COLUMN "connectionId" TEXT,
  ADD COLUMN "rewardMode" "RewardMode" NOT NULL DEFAULT 'DISCOUNT',
  ADD COLUMN "commerce7Config" JSONB,
  ADD COLUMN "reservedClaimCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "ShopifyRewardRedemption"
  ADD COLUMN "connectionId" TEXT,
  ADD COLUMN "rewardMode" "RewardMode" NOT NULL DEFAULT 'DISCOUNT',
  ADD COLUMN "provisioningState" "RewardProvisioningState",
  ADD COLUMN "provisioningOwner" TEXT,
  ADD COLUMN "provisioningStartedAt" TIMESTAMP(3),
  ADD COLUMN "providerCustomerId" TEXT,
  ADD COLUMN "verifiedEmailAt" TIMESTAMP(3),
  ADD COLUMN "providerTagId" TEXT,
  ADD COLUMN "tagCreateAttempted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "couponCreateAttempted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "entitlementEverGranted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "slotReleased" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rewardConfigSnapshot" JSONB,
  ADD COLUMN "canonicalOrderId" TEXT,
  ADD COLUMN "rewardOrderCursor" TEXT,
  ADD COLUMN "rewardOrderCheckedAt" TIMESTAMP(3);
UPDATE "BrandRewardOffer" AS offer
SET "reservedClaimCount" = (
  SELECT COUNT(*)::INTEGER FROM "ShopifyRewardRedemption" AS claim
  WHERE claim."offerId" = offer."id" AND claim."provider" = 'COMMERCE7' AND NOT claim."slotReleased"
)
WHERE offer."provider" = 'COMMERCE7';
CREATE INDEX "reward_c7_provisioning" ON "ShopifyRewardRedemption" ("provider", "provisioningState", "createdAt");
ALTER TABLE "BrandRewardOffer" ADD CONSTRAINT "reward_c7_offer_connection" CHECK ("provider" <> 'COMMERCE7' OR "connectionId" IS NOT NULL);
ALTER TABLE "ShopifyRewardRedemption" ADD CONSTRAINT "reward_c7_claim_connection" CHECK ("provider" <> 'COMMERCE7' OR ("connectionId" IS NOT NULL AND "rewardConfigSnapshot" IS NOT NULL));
ALTER TABLE "ShopifyRewardRedemption" ADD CONSTRAINT "reward_c7_release_safe" CHECK (
  "provider" <> 'COMMERCE7' OR NOT "slotReleased" OR
  (NOT "entitlementEverGranted" AND NOT "couponCreateAttempted" AND "status" = 'REFUNDED')
);
CREATE INDEX "reward_provider_pending" ON "ShopifyRewardRedemption" ("provider", "status", "shopifyLastCheckedAt");
CREATE INDEX "reward_offer_capacity" ON "ShopifyRewardRedemption" ("offerId", "slotReleased");
CREATE INDEX "reward_offer_user_capacity" ON "ShopifyRewardRedemption" ("offerId", "userId", "slotReleased");
ALTER TABLE "BrandRewardOffer" ADD CONSTRAINT "reward_c7_offer_limits" CHECK (
  "provider" <> 'COMMERCE7' OR
  ("maxTotalRedemptions" IS NOT NULL AND "maxRedemptionsPerUser" IS NOT NULL
    AND "maxTotalRedemptions" BETWEEN 1 AND 1000 AND "maxRedemptionsPerUser" BETWEEN 1 AND "maxTotalRedemptions"
    AND "pointsCost" > 0 AND "codeValidDays" BETWEEN 1 AND 365
    AND "reservedClaimCount" BETWEEN 0 AND "maxTotalRedemptions"
    AND "sourceShopDomain" IS NOT NULL AND "commerce7Config" IS NOT NULL
    AND ("rewardMode" <> 'EXCLUSIVE_PRODUCT_ACCESS' OR (NOT "isActive" AND "maxTotalRedemptions" <= 25)))
);
