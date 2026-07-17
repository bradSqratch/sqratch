ALTER TABLE "EmailVerificationToken"
  ADD COLUMN "welcomeEligible" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "EmailQueue"
  ADD COLUMN "verificationEligible" BOOLEAN NOT NULL DEFAULT false;

ALTER TYPE "EmailStatus" ADD VALUE IF NOT EXISTS 'SKIPPED';

DROP TRIGGER IF EXISTS "trg_enqueue_welcome_email" ON "User";
DROP FUNCTION IF EXISTS public.enqueue_welcome_email();

-- Any separate User INSERT trigger used for the external Make.com integration
-- is intentionally left unchanged.
