-- Structure-only migration. NO data backfill is performed here.
-- Historical rows are backfilled separately via prisma/manual-production-backfill.sql,
-- which must be reviewed and run manually by an operator (see that file for order).
--
-- Safety notes:
--   * All added columns are nullable or have safe defaults, so this is additive
--     and non-destructive.
--   * The new UNIQUE index (userId, idempotencyKey) is safe on existing data:
--     every existing row has idempotencyKey = NULL, and Postgres treats NULLs as
--     distinct, so no existing rows collide.
--   * "PointTransaction"."type" defaults to 'EARN' for existing rows; the manual
--     backfill corrects SPEND/REFUND rows afterward. No app logic depends on that
--     column for balance correctness (balances come from "UserPointAccount").

-- CreateEnum
CREATE TYPE "PointTransactionType" AS ENUM ('EARN', 'SPEND', 'REFUND', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PointSourceType" AS ENUM ('QR_SCAN', 'LESSON_COMPLETION', 'COURSE_COMPLETION', 'VIDEO_WATCH', 'BONUS', 'REFERRAL', 'SHOPIFY_REWARD_REDEMPTION', 'SHOPIFY_REWARD_REFUND', 'ADMIN_ADJUSTMENT');

-- AlterTable
ALTER TABLE "Course" ADD COLUMN     "completionPointsReward" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Lesson" ADD COLUMN     "completionPointsReward" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PointTransaction" ADD COLUMN     "balanceAfter" INTEGER,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "lifetimeEarnedAfter" INTEGER,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceType" "PointSourceType",
ADD COLUMN     "type" "PointTransactionType" NOT NULL DEFAULT 'EARN';

-- CreateTable
CREATE TABLE "UserPointAccount" (
    "userId" TEXT NOT NULL,
    "spendablePoints" INTEGER NOT NULL DEFAULT 0,
    "lifetimeEarnedPoints" INTEGER NOT NULL DEFAULT 0,
    "lifetimeSpentPoints" INTEGER NOT NULL DEFAULT 0,
    "lifetimeRefundedPoints" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserPointAccount_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "UserPointAccount_lifetimeEarnedPoints_idx" ON "UserPointAccount"("lifetimeEarnedPoints");

-- CreateIndex
CREATE INDEX "UserPointAccount_spendablePoints_idx" ON "UserPointAccount"("spendablePoints");

-- CreateIndex
CREATE INDEX "PointTransaction_userId_createdAt_idx" ON "PointTransaction"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "PointTransaction_sourceType_sourceId_idx" ON "PointTransaction"("sourceType", "sourceId");

-- CreateIndex
CREATE UNIQUE INDEX "uq_point_tx_user_idempotency_key" ON "PointTransaction"("userId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "UserPointAccount" ADD CONSTRAINT "UserPointAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
