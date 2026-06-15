-- CreateEnum
CREATE TYPE "RewardDiscountType" AS ENUM ('FIXED_AMOUNT', 'PERCENTAGE');

-- AlterTable
ALTER TABLE "Brand" ADD COLUMN "shopifyCurrencyCode" TEXT;

-- AlterTable
ALTER TABLE "BrandRewardOffer" ALTER COLUMN "discountAmountCents" DROP NOT NULL;
ALTER TABLE "BrandRewardOffer" ADD COLUMN "discountType" "RewardDiscountType" NOT NULL DEFAULT 'FIXED_AMOUNT';
ALTER TABLE "BrandRewardOffer" ADD COLUMN "discountPercentageBasisPoints" INTEGER;

-- AlterTable
ALTER TABLE "ShopifyRewardRedemption" ALTER COLUMN "discountAmountCents" DROP NOT NULL;
ALTER TABLE "ShopifyRewardRedemption" ADD COLUMN "discountType" "RewardDiscountType" NOT NULL DEFAULT 'FIXED_AMOUNT';
ALTER TABLE "ShopifyRewardRedemption" ADD COLUMN "discountPercentageBasisPoints" INTEGER;

-- AddConstraints
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
  )
);

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
  )
);
