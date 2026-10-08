-- Commerce7 Exclusive Wine Access. Additive columns plus three constraint replacements; no data is rewritten.
-- Apply BEFORE deploying the application code that reads these columns (the shared redemption table also serves Shopify).
-- Operator notes and rollback: docs/commerce/commerce7-rewards.md ("Deployment").
CREATE TYPE "RewardMembershipOwnership" AS ENUM ('PRE_EXISTING', 'SQRATCH_GRANTED', 'UNVERIFIED');

ALTER TABLE "ShopifyRewardRedemption"
  ADD COLUMN "membershipWriteAttempted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "membershipOwnership" "RewardMembershipOwnership",
  ADD COLUMN "providerMembershipId" TEXT,
  ADD COLUMN "membershipVerifiedAt" TIMESTAMP(3);

-- Ownership is evidence-bound: a pre-existing membership was never written by SQRATCH, and SQRATCH ownership needs the
-- relation ID from its own HTTP 201. Ownership only exists for exclusive Commerce7 claims.
ALTER TABLE "ShopifyRewardRedemption" ADD CONSTRAINT "reward_c7_membership_owner" CHECK (
  "membershipOwnership" IS NULL OR (
    "provider" = 'COMMERCE7' AND "rewardMode" = 'EXCLUSIVE_PRODUCT_ACCESS' AND "providerTagId" IS NOT NULL AND "providerCustomerId" IS NOT NULL
    AND ("membershipOwnership" <> 'PRE_EXISTING' OR NOT "membershipWriteAttempted")
    AND ("membershipOwnership" <> 'SQRATCH_GRANTED' OR ("membershipWriteAttempted" AND "providerMembershipId" IS NOT NULL))
    AND ("membershipOwnership" <> 'UNVERIFIED' OR "membershipWriteAttempted")
  )
);
ALTER TABLE "ShopifyRewardRedemption" ADD CONSTRAINT "reward_c7_membership_write" CHECK (
  NOT "membershipWriteAttempted" OR ("provider" = 'COMMERCE7' AND "rewardMode" = 'EXCLUSIVE_PRODUCT_ACCESS')
);

-- Capacity may be released (points refunded) only when no membership write was ever attempted either.
ALTER TABLE "ShopifyRewardRedemption" DROP CONSTRAINT "reward_c7_release_safe";
ALTER TABLE "ShopifyRewardRedemption" ADD CONSTRAINT "reward_c7_release_safe" CHECK (
  "provider" <> 'COMMERCE7' OR NOT "slotReleased" OR
  (NOT "entitlementEverGranted" AND NOT "couponCreateAttempted" AND NOT "membershipWriteAttempted" AND "status" = 'REFUNDED')
);

-- Exclusive offers may now be active (the claim saga verifies native access); the 25-claim ceiling is unchanged.
ALTER TABLE "BrandRewardOffer" DROP CONSTRAINT "reward_c7_offer_limits";
ALTER TABLE "BrandRewardOffer" ADD CONSTRAINT "reward_c7_offer_limits" CHECK (
  "provider" <> 'COMMERCE7' OR
  ("maxTotalRedemptions" IS NOT NULL AND "maxRedemptionsPerUser" IS NOT NULL
    AND "maxTotalRedemptions" BETWEEN 1 AND 1000 AND "maxRedemptionsPerUser" BETWEEN 1 AND "maxTotalRedemptions"
    AND "pointsCost" > 0 AND "codeValidDays" BETWEEN 1 AND 365
    AND "reservedClaimCount" BETWEEN 0 AND "maxTotalRedemptions"
    AND "sourceShopDomain" IS NOT NULL AND "commerce7Config" IS NOT NULL
    AND ("rewardMode" <> 'EXCLUSIVE_PRODUCT_ACCESS' OR "maxTotalRedemptions" <= 25))
);

-- An access-only Commerce7 exclusive offer/claim carries no discount. Every other row keeps the original discount rule.
ALTER TABLE "BrandRewardOffer" DROP CONSTRAINT "brand_reward_offer_discount_check";
ALTER TABLE "BrandRewardOffer" ADD CONSTRAINT "brand_reward_offer_discount_check" CHECK (
  (
    "discountType" = 'FIXED_AMOUNT'
    AND "discountAmountCents" IS NOT NULL
    AND "discountAmountCents" > 0
    AND "discountPercentageBasisPoints" IS NULL
  ) OR (
    "discountType" = 'PERCENTAGE'
    AND "discountAmountCents" IS NULL
    AND "discountPercentageBasisPoints" IS NOT NULL
    AND "discountPercentageBasisPoints" >= 1
    AND "discountPercentageBasisPoints" <= 10000
  ) OR (
    "provider" = 'COMMERCE7'
    AND "rewardMode" = 'EXCLUSIVE_PRODUCT_ACCESS'
    AND "discountAmountCents" IS NULL
    AND "discountPercentageBasisPoints" IS NULL
  )
);
ALTER TABLE "ShopifyRewardRedemption" DROP CONSTRAINT "shopify_reward_redemption_discount_check";
ALTER TABLE "ShopifyRewardRedemption" ADD CONSTRAINT "shopify_reward_redemption_discount_check" CHECK (
  (
    "discountType" = 'FIXED_AMOUNT'
    AND "discountAmountCents" IS NOT NULL
    AND "discountAmountCents" > 0
    AND "discountPercentageBasisPoints" IS NULL
  ) OR (
    "discountType" = 'PERCENTAGE'
    AND "discountAmountCents" IS NULL
    AND "discountPercentageBasisPoints" IS NOT NULL
    AND "discountPercentageBasisPoints" >= 1
    AND "discountPercentageBasisPoints" <= 10000
  ) OR (
    "provider" = 'COMMERCE7'
    AND "rewardMode" = 'EXCLUSIVE_PRODUCT_ACCESS'
    AND "discountAmountCents" IS NULL
    AND "discountPercentageBasisPoints" IS NULL
  )
);

-- Bounded lookup for the one-in-flight-claim-per-customer-tag guard.
CREATE INDEX "reward_c7_membership_inflight" ON "ShopifyRewardRedemption" ("userId", "connectionId", "providerTagId", "status");
