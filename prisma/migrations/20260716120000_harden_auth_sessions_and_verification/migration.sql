-- Existing verification records contain legacy plaintext or legacy-formatted
-- values and cannot be safely converted into keyed hashes. Invalidate them so
-- affected users request a fresh verification code.
DELETE FROM "EmailVerificationToken";

ALTER TABLE "User"
ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "EmailVerificationToken"
DROP CONSTRAINT IF EXISTS "EmailVerificationToken_emailVerifyToken_key";

ALTER TABLE "EmailVerificationToken"
DROP COLUMN IF EXISTS "emailVerifyToken",
ADD COLUMN "email" TEXT NOT NULL DEFAULT '',
ADD COLUMN "codeHash" TEXT NOT NULL DEFAULT '',
ADD COLUMN "failedAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "consumedAt" TIMESTAMP(3);

ALTER TABLE "EmailVerificationToken"
ALTER COLUMN "email" DROP DEFAULT,
ALTER COLUMN "codeHash" DROP DEFAULT;

CREATE INDEX "EmailVerificationToken_email_idx"
  ON "EmailVerificationToken"("email");

CREATE INDEX "EmailVerificationToken_userId_consumedAt_expires_idx"
  ON "EmailVerificationToken"("userId", "consumedAt", "expires");

CREATE INDEX "EmailVerificationToken_email_consumedAt_expires_idx"
  ON "EmailVerificationToken"("email", "consumedAt", "expires");
