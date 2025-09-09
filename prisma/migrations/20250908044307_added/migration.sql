-- CreateEnum
CREATE TYPE "public"."PointReason" AS ENUM ('QR_SCAN', 'BONUS', 'REFERRAL');

-- AlterTable
ALTER TABLE "public"."User" ADD COLUMN     "points" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."PointTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "reason" "public"."PointReason" NOT NULL,
    "qrCodeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PointTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PointTransaction_userId_idx" ON "public"."PointTransaction"("userId");

-- CreateIndex
CREATE INDEX "PointTransaction_qrCodeId_idx" ON "public"."PointTransaction"("qrCodeId");

-- CreateIndex
CREATE UNIQUE INDEX "PointTransaction_userId_qrCodeId_key" ON "public"."PointTransaction"("userId", "qrCodeId");

-- AddForeignKey
ALTER TABLE "public"."PointTransaction" ADD CONSTRAINT "PointTransaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PointTransaction" ADD CONSTRAINT "PointTransaction_qrCodeId_fkey" FOREIGN KEY ("qrCodeId") REFERENCES "public"."QRCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;
