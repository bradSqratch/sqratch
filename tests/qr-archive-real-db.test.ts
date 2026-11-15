import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { realDbTest } from "./helpers/real-db";
import type { AuthResolvers } from "../src/lib/auth-session";

const { skipReason } = realDbTest("QR_ARCHIVE_REAL_DB");

async function world() {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID();
  const admin = await prisma.user.create({ data: { email: `${key}-admin@example.test`, role: "BRAND_ADMIN" } });
  const learner = await prisma.user.create({ data: { email: `${key}-learner@example.test` } });
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const otherBrand = await prisma.brand.create({ data: { name: `${key}-other`, slug: `${key}-other` } });
  const campaign = await prisma.campaign.create({ data: { name: key, slug: key, brandId: brand.id, createdById: admin.id } });
  const otherCampaign = await prisma.campaign.create({ data: { name: `${key}-o`, slug: `${key}-o`, brandId: otherBrand.id, createdById: admin.id } });
  const batch = await prisma.qRCodeBatch.create({ data: { name: `${key}-batch`, campaignId: campaign.id } });
  const otherBatch = await prisma.qRCodeBatch.create({ data: { name: `${key}-other-batch`, campaignId: otherCampaign.id } });
  const activeBatch = await prisma.qRCodeBatch.create({ data: { name: `${key}-active`, campaignId: campaign.id } });
  const code = await prisma.qRCode.create({ data: { qrCodeData: `${key}-a`, campaignId: campaign.id, createdById: admin.id, batchId: batch.id } });
  const activeCode = await prisma.qRCode.create({ data: { qrCodeData: `${key}-b`, campaignId: campaign.id, createdById: admin.id, batchId: activeBatch.id } });
  const loose = await prisma.qRCode.create({ data: { qrCodeData: `${key}-c`, campaignId: campaign.id, createdById: admin.id } });
  const brandDeps = (brandId: string, name = "Brand") =>
    ({
      resolveSession: async () => ({ user: { id: admin.id, role: "BRAND_ADMIN" } }),
      resolveBrandAdminContext: async () => ({ userId: admin.id, selectionRequired: false, brands: [], membership: { id: "m", role: "ADMIN", brand: { id: brandId, name, slug: name } } }),
    }) as unknown as AuthResolvers;
  return { prisma, key, admin, learner, brand, otherBrand, campaign, otherCampaign, batch, otherBatch, activeBatch, code, activeCode, loose, brandDeps };
}

async function cleanup(w: Awaited<ReturnType<typeof world>>) {
  const { prisma } = w;
  const campaignIds = [w.campaign.id, w.otherCampaign.id];
  await prisma.pointTransaction.deleteMany({ where: { userId: w.learner.id } });
  await prisma.analyticsEvent.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.campaignUnlock.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.userSession.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.qRCode.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.qRCodeBatch.deleteMany({ where: { campaignId: { in: campaignIds } } });
  await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
  await prisma.brand.deleteMany({ where: { id: { in: [w.brand.id, w.otherBrand.id] } } });
  await prisma.user.deleteMany({ where: { id: { in: [w.admin.id, w.learner.id] } } });
}

const post = (url: string, headers: Record<string, string> = {}) => new NextRequest(url, { method: "POST", headers });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

test("archiving hides a batch and its codes by default, is idempotent, and is brand-scoped", { skip: skipReason }, async () => {
  const { archiveBatchImpl } = await import("../src/app/api/brand/qr-batches/[id]/archive/route");
  const { unarchiveBatchImpl } = await import("../src/app/api/brand/qr-batches/[id]/unarchive/route");
  const { listQrBatchesImpl } = await import("../src/app/api/brand/qr-batches/route");
  const w = await world();
  const deps = w.brandDeps(w.brand.id);
  const list = async (query = "") => {
    const response = await listQrBatchesImpl(new NextRequest(`http://localhost/api/brand/qr-batches${query}`), deps);
    assert.equal(response.status, 200);
    return (await response.json()).data as { batches: Array<{ id: string; archivedAt: string | null }>; qrCodes: Array<{ id: string }>; pagination: { total: number }; archived: string };
  };
  try {
    let data = await list();
    assert.equal(data.archived, "exclude");
    assert.equal(data.batches.length, 2);
    assert.equal(data.pagination.total, 3);

    const first = await archiveBatchImpl(post("http://localhost/x"), ctx(w.batch.id), deps);
    assert.equal(first.status, 200);
    const archivedAt = (await first.json()).data.archivedAt as string;
    assert.ok(archivedAt);
    // Repeating is a no-op that keeps the original archive time.
    const again = await (await archiveBatchImpl(post("http://localhost/x"), ctx(w.batch.id), deps)).json();
    assert.equal(again.data.archivedAt, archivedAt);
    assert.equal((await prisma_archivedBy(w)).archivedById, w.admin.id);

    data = await list();
    assert.deepEqual(data.batches.map((b) => b.id), [w.activeBatch.id]);
    // The archived batch's code leaves the default list; the active batch's code and the batch-less code stay.
    assert.deepEqual(data.qrCodes.map((c) => c.id).sort(), [w.activeCode.id, w.loose.id].sort());
    assert.equal(data.pagination.total, 2);

    data = await list("?archived=only");
    assert.deepEqual(data.batches.map((b) => b.id), [w.batch.id]);
    assert.deepEqual(data.qrCodes.map((c) => c.id), [w.code.id]);
    assert.ok(data.batches[0].archivedAt);

    data = await list("?archived=include");
    assert.equal(data.batches.length, 2);
    assert.equal(data.pagination.total, 3);
    assert.equal((await listQrBatchesImpl(new NextRequest("http://localhost/api/brand/qr-batches?archived=bogus"), deps)).status, 400);

    // Another brand cannot see or archive this batch; a stale brand page is refused without writing.
    const foreign = await archiveBatchImpl(post("http://localhost/x"), ctx(w.otherBatch.id), deps);
    assert.equal(foreign.status, 404);
    assert.equal((await w.prisma.qRCodeBatch.findUniqueOrThrow({ where: { id: w.otherBatch.id } })).archivedAt, null);
    const stale = await archiveBatchImpl(post("http://localhost/x", { "x-sqratch-expected-brand": w.otherBrand.id }), ctx(w.activeBatch.id), deps);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).code, "BRAND_CONTEXT_MISMATCH");
    assert.equal((await w.prisma.qRCodeBatch.findUniqueOrThrow({ where: { id: w.activeBatch.id } })).archivedAt, null);
    assert.equal((await archiveBatchImpl(post("http://localhost/x"), ctx(w.batch.id), { ...deps, resolveSession: async () => null })).status, 401);

    const restored = await unarchiveBatchImpl(post("http://localhost/x"), ctx(w.batch.id), deps);
    assert.equal(restored.status, 200);
    assert.equal((await restored.json()).data.archivedAt, null);
    assert.equal((await w.prisma.qRCodeBatch.findUniqueOrThrow({ where: { id: w.batch.id } })).archivedById, null);
    data = await list();
    assert.equal(data.batches.length, 2);
    assert.equal(data.pagination.total, 3);
  } finally {
    await cleanup(w);
  }
});

function prisma_archivedBy(w: Awaited<ReturnType<typeof world>>) {
  return w.prisma.qRCodeBatch.findUniqueOrThrow({ where: { id: w.batch.id }, select: { archivedById: true } });
}

test("an archived batch's printed code still scans, redeems, awards, exports and keeps history", { skip: skipReason }, async () => {
  const { archiveBatchImpl } = await import("../src/app/api/brand/qr-batches/[id]/archive/route");
  const { scanImpl } = await import("../src/app/api/public/scan/route");
  const { exportBatchImpl } = await import("../src/app/api/brand/qr-batches/[id]/export/route");
  const w = await world();
  const deps = w.brandDeps(w.brand.id);
  const learnerDeps = { resolveSession: async () => ({ user: { id: w.learner.id, email: w.learner.email } }), resolveBrandAdminContext: async () => null } as unknown as AuthResolvers;
  const scan = (data: string) =>
    scanImpl(new NextRequest("http://localhost/api/public/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qrCodeData: data }) }), learnerDeps);
  try {
    assert.equal((await archiveBatchImpl(post("http://localhost/x"), ctx(w.batch.id), deps)).status, 200);

    // Redeem an unused code from the archived batch.
    assert.equal((await scan(w.code.qrCodeData)).status, 200);
    const redeemed = await w.prisma.qRCode.findUniqueOrThrow({ where: { id: w.code.id } });
    assert.equal(redeemed.status, "USED");
    assert.equal(redeemed.redeemedById, w.learner.id);
    assert.equal(await w.prisma.campaignUnlock.count({ where: { qrCodeId: w.code.id, userId: w.learner.id } }), 1);
    assert.equal(await w.prisma.pointTransaction.count({ where: { qrCodeId: w.code.id, userId: w.learner.id } }), 1);

    // Archiving after redemption changes nothing about that history.
    const before = await w.prisma.pointTransaction.count({ where: { userId: w.learner.id } });
    assert.equal((await archiveBatchImpl(post("http://localhost/x"), ctx(w.batch.id), deps)).status, 200);
    assert.equal(await w.prisma.pointTransaction.count({ where: { userId: w.learner.id } }), before);
    assert.equal(await w.prisma.campaignUnlock.count({ where: { qrCodeId: w.code.id } }), 1);
    assert.equal((await w.prisma.qRCode.findUniqueOrThrow({ where: { id: w.code.id } })).status, "USED");

    // CSV export is unaffected.
    const exported = await exportBatchImpl(new NextRequest(`http://localhost/api/brand/qr-batches/${w.batch.id}/export`), ctx(w.batch.id), deps);
    assert.equal(exported.status, 200);
    assert.match(await exported.text(), new RegExp(w.code.qrCodeData));

    // The batch remains archived and its used code is not deletable (history guard is independent of archiving).
    assert.ok((await w.prisma.qRCodeBatch.findUniqueOrThrow({ where: { id: w.batch.id } })).archivedAt);
  } finally {
    await cleanup(w);
  }
});

test("deleting the archiving user does not delete the batch", { skip: skipReason }, async () => {
  const w = await world();
  const archiver = await w.prisma.user.create({ data: { email: `${w.key}-archiver@example.test` } });
  try {
    await w.prisma.qRCodeBatch.update({ where: { id: w.batch.id }, data: { archivedAt: new Date(), archivedById: archiver.id } });
    await w.prisma.user.delete({ where: { id: archiver.id } });
    const batch = await w.prisma.qRCodeBatch.findUniqueOrThrow({ where: { id: w.batch.id } });
    assert.ok(batch.archivedAt);
    assert.equal(batch.archivedById, null);
  } finally {
    await cleanup(w);
  }
});
