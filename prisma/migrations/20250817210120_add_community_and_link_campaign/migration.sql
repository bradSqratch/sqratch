-- CreateEnum
CREATE TYPE "public"."CommunityType" AS ENUM ('BETTERMODE', 'GENERIC');

-- AlterTable
ALTER TABLE "public"."Campaign" ADD COLUMN     "communityId" TEXT;

-- CreateTable
CREATE TABLE "public"."Community" (
    "id" TEXT NOT NULL,
    "type" "public"."CommunityType" NOT NULL DEFAULT 'GENERIC',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Community_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "public"."Campaign" ADD CONSTRAINT "Campaign_communityId_fkey" FOREIGN KEY ("communityId") REFERENCES "public"."Community"("id") ON DELETE SET NULL ON UPDATE CASCADE;
