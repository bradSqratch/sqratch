DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User"
    WHERE "role"::text = 'EXTERNAL'
  ) THEN
    RAISE EXCEPTION
      'Cannot remove EXTERNAL role: one or more users still have role EXTERNAL';
  END IF;
END
$$;

ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;

CREATE TYPE "Role_new" AS ENUM (
  'USER',
  'ADMIN',
  'CREATOR',
  'BRAND_ADMIN'
);

ALTER TABLE "User"
  ALTER COLUMN "role" TYPE "Role_new"
  USING ("role"::text::"Role_new");

DROP TYPE "Role";
ALTER TYPE "Role_new" RENAME TO "Role";

ALTER TABLE "User"
  ALTER COLUMN "role" SET DEFAULT 'USER'::"Role";
