import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

export class QrDeletionBlocked extends Error {
  constructor() { super("QR codes have history or were distributed."); }
}

export const unusedQrWhere: Prisma.QRCodeWhereInput = {
  status: "NEW", redeemedById: null,
  unlocks: { none: {} }, pointTransactions: { none: {} },
  userSessions: { none: {} }, analyticsEvents: { none: {} },
  commerceClickAttributions: { none: {} },
};

export async function lockQrCodes(tx: Prisma.TransactionClient, codeIds: string[]) {
  if (codeIds.length) await tx.$queryRaw`SELECT id FROM "QRCode" WHERE id = ANY(${codeIds}::text[]) ORDER BY id FOR UPDATE`;
}

export async function lockQrBatch(tx: Prisma.TransactionClient, batchId: string) {
  await tx.$queryRaw`SELECT id FROM "QRCodeBatch" WHERE id = ${batchId} FOR UPDATE`;
}

export async function deleteUnusedQrCodes(tx: Prisma.TransactionClient, { codeIds, brandId }: { codeIds: string[]; brandId: string }) {
  const ids = [...new Set(codeIds)];
  await lockQrCodes(tx, ids);
  const result = await tx.qRCode.deleteMany({ where: {
    id: { in: ids }, campaign: { brandId }, ...unusedQrWhere,
    OR: [{ batchId: null }, { batch: { is: { csvExportedAt: null, printedAt: null } } }],
  } });
  if (result.count !== ids.length) throw new QrDeletionBlocked();
}

export async function describeQrDeletionBlockers(db: Db, codeIds: string[]) {
  const rows = await db.qRCode.findMany({ where: { id: { in: codeIds } }, select: {
    status: true, redeemedById: true, batch: { select: { csvExportedAt: true, printedAt: true } },
    _count: { select: { unlocks: true, pointTransactions: true, userSessions: true, analyticsEvents: true, commerceClickAttributions: true } },
  } });
  return rows.reduce((acc, row) => {
    if (row.status !== "NEW" || row.redeemedById) acc.redeemed++;
    if (row.batch?.csvExportedAt || row.batch?.printedAt) acc.distributed++;
    for (const key of ["unlocks", "pointTransactions", "userSessions", "analyticsEvents", "commerceClickAttributions"] as const) acc[key] += row._count[key];
    return acc;
  }, { redeemed: 0, distributed: 0, unlocks: 0, pointTransactions: 0, userSessions: 0, analyticsEvents: 0, commerceClickAttributions: 0 });
}

export function cloudinaryPublicId(imageUrl: string) {
  const path = new URL(imageUrl).pathname;
  const index = path.indexOf("/upload/");
  return index < 0 ? null : path.slice(index + 8).replace(/^v\d+\//, "").replace(/\.[^.]+$/, "");
}
