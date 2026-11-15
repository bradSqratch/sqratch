import type { Prisma } from "@prisma/client";

/**
 * QR batch archiving is operational list hygiene only. Nothing in scanning,
 * redemption, unlocks, the points ledger, attribution or CSV export may read
 * `QRCodeBatch.archivedAt`; those paths must behave identically for archived
 * and active batches so printed links keep working. Archiving is also separate
 * from stopping redemptions (P12) and from the unrelated `isActive` columns.
 */
export type ArchivedFilter = "exclude" | "include" | "only";

export function parseArchivedFilter(value: string | null): ArchivedFilter | null {
  if (value === null || value === "") return "exclude";
  return value === "exclude" || value === "include" || value === "only" ? value : null;
}

export function archivedBatchWhere(filter: ArchivedFilter): Prisma.QRCodeBatchWhereInput {
  if (filter === "include") return {};
  return filter === "only" ? { archivedAt: { not: null } } : { archivedAt: null };
}

/** Codes follow their batch; a code with no batch can never be archived. */
export function archivedCodeWhere(filter: ArchivedFilter): Prisma.QRCodeWhereInput {
  if (filter === "include") return {};
  return filter === "only"
    ? { batch: { is: { archivedAt: { not: null } } } }
    : { OR: [{ batchId: null }, { batch: { is: { archivedAt: null } } }] };
}
