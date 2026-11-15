-- P11: QR batch archive. Additive and nullable; no backfill, no data rewritten.
-- Archiving is operational list hygiene only. It must never be read by scan,
-- redemption or any public route, and it is separate from QRCodeBatch."isActive".
-- Rollback: stop reading and writing the two columns; they may remain unused.

ALTER TABLE "QRCodeBatch"
  ADD COLUMN "archivedAt" TIMESTAMP(3),
  ADD COLUMN "archivedById" TEXT;

ALTER TABLE "QRCodeBatch"
  ADD CONSTRAINT "QRCodeBatch_archivedById_fkey"
  FOREIGN KEY ("archivedById") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
