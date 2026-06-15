-- AlterTable
ALTER TABLE "ShopifyRewardRedemption" ADD COLUMN     "lastReconcileReason" TEXT,
ADD COLUMN     "needsManualReview" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reconcileAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reconcileLockedUntil" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ShopifyRewardRedemption_status_needsManualReview_createdAt_idx" ON "ShopifyRewardRedemption"("status", "needsManualReview", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PointTransaction_shopifyRewardRedemptionId_reason_key" ON "PointTransaction"("shopifyRewardRedemptionId", "reason");
