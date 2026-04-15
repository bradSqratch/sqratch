ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'CREATOR';
ALTER TYPE "Role" ADD VALUE IF NOT EXISTS 'BRAND_ADMIN';

ALTER TABLE "User"
ADD COLUMN IF NOT EXISTS "imageUrl" text;

ALTER TABLE "User"
ALTER COLUMN role SET DEFAULT 'USER';

UPDATE "User"
SET role = 'USER'
WHERE role = 'EXTERNAL';

ALTER TABLE "Campaign"
ADD COLUMN IF NOT EXISTS slug text;

WITH generated AS (
  SELECT
    id,
    lower(trim(both '-' from regexp_replace(name, '[^a-zA-Z0-9]+', '-', 'g'))) AS base_slug
  FROM "Campaign"
)
UPDATE "Campaign" c
SET slug =
  CASE
    WHEN generated.base_slug IS NULL OR generated.base_slug = ''
      THEN 'campaign-' || substring(c.id from 1 for 8)
    ELSE generated.base_slug || '-' || substring(c.id from 1 for 8)
  END
FROM generated
WHERE c.id = generated.id
AND c.slug IS NULL;

ALTER TABLE "Campaign"
ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "Campaign_slug_key"
ON "Campaign"(slug);
