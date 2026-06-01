-- CreateEnum
CREATE TYPE "RewardAppliesTo" AS ENUM ('ALL_PRODUCTS', 'SPECIFIC_PRODUCTS');

-- CreateEnum
CREATE TYPE "ShopifyRewardRedemptionStatus" AS ENUM ('PENDING', 'POINTS_DEBITED', 'ISSUED', 'USED', 'EXPIRED', 'FAILED', 'REFUNDED', 'CANCELLED');

-- AlterEnum
ALTER TYPE "PointReason" ADD VALUE 'SHOPIFY_REWARD_REDEMPTION';
ALTER TYPE "PointReason" ADD VALUE 'SHOPIFY_REWARD_REFUND';

-- AlterTable
ALTER TABLE "PointTransaction" ADD COLUMN "shopifyRewardRedemptionId" TEXT;

-- CreateTable
CREATE TABLE "BrandRewardOffer" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "pointsCost" INTEGER NOT NULL,
    "discountAmountCents" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'CAD',
    "claimStartsAt" TIMESTAMP(3),
    "claimEndsAt" TIMESTAMP(3),
    "codeValidDays" INTEGER NOT NULL DEFAULT 30,
    "appliesTo" "RewardAppliesTo" NOT NULL DEFAULT 'ALL_PRODUCTS',
    "minimumSubtotalCents" INTEGER,
    "codePrefix" TEXT,
    "maxTotalRedemptions" INTEGER,
    "maxRedemptionsPerUser" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrandRewardOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrandRewardOfferProduct" (
    "id" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "shopifyProductGid" TEXT NOT NULL,
    "title" TEXT,
    "imageUrl" TEXT,
    "productUrl" TEXT,

    CONSTRAINT "BrandRewardOfferProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyRewardRedemption" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "offerId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "ShopifyRewardRedemptionStatus" NOT NULL,
    "pointsCost" INTEGER NOT NULL,
    "discountAmountCents" INTEGER NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'CAD',
    "shopifyShopDomain" TEXT NOT NULL,
    "shopifyDiscountNodeId" TEXT,
    "shopifyDiscountStatus" TEXT,
    "shopifyAsyncUsageCount" INTEGER,
    "shopifyLastCheckedAt" TIMESTAMP(3),
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "shopifyUserErrors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyRewardRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BrandRewardOffer_brandId_idx" ON "BrandRewardOffer"("brandId");

-- CreateIndex
CREATE INDEX "BrandRewardOffer_brandId_isActive_claimStartsAt_claimEndsAt_idx" ON "BrandRewardOffer"("brandId", "isActive", "claimStartsAt", "claimEndsAt");

-- CreateIndex
CREATE UNIQUE INDEX "BrandRewardOfferProduct_offerId_shopifyProductGid_key" ON "BrandRewardOfferProduct"("offerId", "shopifyProductGid");

-- CreateIndex
CREATE INDEX "BrandRewardOfferProduct_offerId_idx" ON "BrandRewardOfferProduct"("offerId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyRewardRedemption_idempotencyKey_key" ON "ShopifyRewardRedemption"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyRewardRedemption_code_key" ON "ShopifyRewardRedemption"("code");

-- CreateIndex
CREATE INDEX "ShopifyRewardRedemption_userId_createdAt_idx" ON "ShopifyRewardRedemption"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifyRewardRedemption_brandId_createdAt_idx" ON "ShopifyRewardRedemption"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifyRewardRedemption_offerId_idx" ON "ShopifyRewardRedemption"("offerId");

-- CreateIndex
CREATE INDEX "ShopifyRewardRedemption_status_idx" ON "ShopifyRewardRedemption"("status");

-- CreateIndex
CREATE INDEX "PointTransaction_shopifyRewardRedemptionId_idx" ON "PointTransaction"("shopifyRewardRedemptionId");

-- AddForeignKey
ALTER TABLE "BrandRewardOffer" ADD CONSTRAINT "BrandRewardOffer_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrandRewardOfferProduct" ADD CONSTRAINT "BrandRewardOfferProduct_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "BrandRewardOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyRewardRedemption" ADD CONSTRAINT "ShopifyRewardRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyRewardRedemption" ADD CONSTRAINT "ShopifyRewardRedemption_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopifyRewardRedemption" ADD CONSTRAINT "ShopifyRewardRedemption_offerId_fkey" FOREIGN KEY ("offerId") REFERENCES "BrandRewardOffer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PointTransaction" ADD CONSTRAINT "PointTransaction_shopifyRewardRedemptionId_fkey" FOREIGN KEY ("shopifyRewardRedemptionId") REFERENCES "ShopifyRewardRedemption"("id") ON DELETE SET NULL ON UPDATE CASCADE;
