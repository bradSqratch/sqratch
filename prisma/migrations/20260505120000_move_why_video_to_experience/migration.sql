ALTER TABLE "Experience"
ADD COLUMN IF NOT EXISTS "whyVideoSource" "CampaignVideoSource",
ADD COLUMN IF NOT EXISTS "whyYoutubeUrl" TEXT,
ADD COLUMN IF NOT EXISTS "whyVideoUploadUrl" TEXT;

UPDATE "Experience" e
SET
  "whyVideoSource" = c."whyVideoSource",
  "whyYoutubeUrl" = c."whyYoutubeUrl",
  "whyVideoUploadUrl" = c."whyVideoUploadUrl"
FROM (
  SELECT DISTINCT ON (ce."experienceId")
    ce."experienceId",
    c."whyVideoSource",
    c."whyYoutubeUrl",
    c."whyVideoUploadUrl",
    ce."sortOrder",
    ce."createdAt"
  FROM "CampaignExperience" ce
  JOIN "Campaign" c ON c."id" = ce."campaignId"
  WHERE
    (c."whyVideoSource" = 'YOUTUBE' AND c."whyYoutubeUrl" IS NOT NULL AND c."whyYoutubeUrl" <> '')
    OR
    (c."whyVideoSource" = 'UPLOAD' AND c."whyVideoUploadUrl" IS NOT NULL AND c."whyVideoUploadUrl" <> '')
  ORDER BY ce."experienceId", ce."sortOrder" ASC, ce."createdAt" ASC
) c
WHERE e."id" = c."experienceId";

ALTER TABLE "Campaign"
DROP COLUMN IF EXISTS "whyVideoSource",
DROP COLUMN IF EXISTS "whyYoutubeUrl",
DROP COLUMN IF EXISTS "whyVideoUploadUrl";
