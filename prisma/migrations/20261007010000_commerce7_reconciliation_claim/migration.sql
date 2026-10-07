-- Additive only. Apply separately before deploying the reconciliation worker.
ALTER TABLE "CommerceOrderReconciliationState"
  ADD COLUMN "activeRunId" TEXT,
  ADD COLUMN "activeRunStartedAt" TIMESTAMP(3);
