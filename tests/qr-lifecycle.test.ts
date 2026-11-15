import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";
import { deleteUnusedQrCodes, describeQrDeletionBlockers, QrDeletionBlocked } from "../src/lib/qr-lifecycle";

test("deletion locks before one conditional delete and blocks partial results", async () => {
  const events: string[] = [];
  let where: Prisma.QRCodeWhereInput | undefined;
  const tx = {
    $queryRaw: async () => { events.push("lock"); },
    qRCode: { deleteMany: async (args: { where: Prisma.QRCodeWhereInput }) => { events.push("delete"); where = args.where; return { count: 1 }; } },
  } as unknown as Prisma.TransactionClient;
  await assert.rejects(deleteUnusedQrCodes(tx, { codeIds: ["a", "b"], brandId: "brand" }), QrDeletionBlocked);
  assert.deepEqual(events, ["lock", "delete"]);
  assert.equal(where?.status, "NEW");
  assert.equal(where?.redeemedById, null);
  for (const relation of ["unlocks", "pointTransactions", "userSessions", "analyticsEvents", "commerceClickAttributions"] as const) assert.deepEqual(where?.[relation], { none: {} });
  assert.deepEqual(where?.campaign, { brandId: "brand" });
  assert.deepEqual(where?.OR, [{ batchId: null }, { batch: { is: { csvExportedAt: null, printedAt: null } } }]);
});

test("blocker descriptions count durable and supporting history", async () => {
  const db = { qRCode: { findMany: async () => [{ status: "USED", redeemedById: "u", batch: { csvExportedAt: new Date(), printedAt: null }, _count: { unlocks: 2, pointTransactions: 1, userSessions: 1, analyticsEvents: 3, commerceClickAttributions: 4 } }] } } as unknown as Prisma.TransactionClient;
  assert.deepEqual(await describeQrDeletionBlockers(db, ["a"]), { redeemed: 1, distributed: 1, unlocks: 2, pointTransactions: 1, userSessions: 1, analyticsEvents: 3, commerceClickAttributions: 4 });
});
