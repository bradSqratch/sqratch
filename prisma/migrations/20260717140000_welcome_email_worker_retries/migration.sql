ALTER TABLE "EmailQueue"
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "claimedAt" TIMESTAMP(3);

CREATE INDEX "idx_email_queue_ready"
  ON "EmailQueue"("template", "status", "nextAttemptAt", "createdAt");

CREATE INDEX "idx_email_queue_stale_claim"
  ON "EmailQueue"("template", "status", "claimedAt");
