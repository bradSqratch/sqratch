-- CreateEnum
CREATE TYPE "CampaignVideoSource" AS ENUM ('YOUTUBE', 'UPLOAD');

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "whyVideoSource" "CampaignVideoSource",
ADD COLUMN     "whyVideoUploadUrl" TEXT,
ADD COLUMN     "whyYoutubeUrl" TEXT;
