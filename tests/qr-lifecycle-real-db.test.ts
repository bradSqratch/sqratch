import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("QR_LIFECYCLE_REAL_DB");

test("a committed concurrent scan blocks QR deletion without orphaning history", { skip: skipReason }, async () => {
  const { default: prisma } = await import("../src/lib/prisma");
  const { deleteUnusedQrCodes, lockQrCodes, QrDeletionBlocked } = await import("../src/lib/qr-lifecycle");
  const key = randomUUID();
  const user = await prisma.user.create({ data: { email: `${key}@example.test` } });
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const campaign = await prisma.campaign.create({ data: { name: key, slug: key, brandId: brand.id, createdById: user.id } });
  const target = await prisma.campaign.create({ data: { name: `${key}-target`, slug: `${key}-target`, brandId: brand.id, createdById: user.id } });
  const qr = await prisma.qRCode.create({ data: { qrCodeData: key, campaignId: campaign.id, createdById: user.id } });
  let release!: () => void;
  let inserted!: () => void;
  const insertedPromise = new Promise<void>(resolve => { inserted = resolve; });
  const releasePromise = new Promise<void>(resolve => { release = resolve; });
  try {
    const scan = prisma.$transaction(async tx => {
      await tx.campaignUnlock.create({ data: { campaignId: campaign.id, qrCodeId: qr.id, anonKey: key } });
      inserted();
      await releasePromise;
    });
    await insertedPromise;
    const deletion = prisma.$transaction(tx => deleteUnusedQrCodes(tx, { codeIds: [qr.id], brandId: brand.id }));
    release();
    await scan;
    await assert.rejects(deletion, QrDeletionBlocked);
    const unlock = await prisma.campaignUnlock.findFirstOrThrow({ where: { anonKey: key } });
    assert.equal(unlock.qrCodeId, qr.id);
    assert.ok(await prisma.qRCode.findUnique({ where: { id: qr.id } }));
    await prisma.campaignUnlock.deleteMany({ where: { campaignId: campaign.id } });

    // The scan's initial lookup can be stale; after waiting for the row lock
    // its second lookup must see the committed destination campaign.
    const stale = await prisma.qRCode.findUniqueOrThrow({ where: { id: qr.id } });
    let updated!: () => void;
    let finish!: () => void;
    const updatedPromise = new Promise<void>(resolve => { updated = resolve; });
    const finishPromise = new Promise<void>(resolve => { finish = resolve; });
    const move = prisma.$transaction(async tx => {
      await lockQrCodes(tx, [qr.id]);
      await tx.qRCode.update({ where: { id: qr.id }, data: { campaignId: target.id } });
      updated();
      await finishPromise;
    });
    await updatedPromise;
    const scanRead = prisma.$transaction(async tx => {
      await lockQrCodes(tx, [stale.id]);
      return tx.qRCode.findUniqueOrThrow({ where: { id: stale.id } });
    });
    finish();
    await move;
    assert.equal((await scanRead).campaignId, target.id);
  } finally {
    await prisma.campaignUnlock.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.qRCode.deleteMany({ where: { id: qr.id } });
    await prisma.campaign.delete({ where: { id: target.id } });
    await prisma.campaign.delete({ where: { id: campaign.id } });
    await prisma.brand.delete({ where: { id: brand.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("real scan handler serializes redemption and deletion", { skip: skipReason }, async () => {
  const { default: prisma } = await import("../src/lib/prisma");
  const { scanImpl } = await import("../src/app/api/public/scan/route");
  const { deleteUnusedQrCodes, QrDeletionBlocked } = await import("../src/lib/qr-lifecycle");
  const { NextRequest } = await import("next/server");
  const key = randomUUID();
  const user = await prisma.user.create({ data: { email: `${key}@example.test` } });
  const otherUser = await prisma.user.create({ data: { email: `${key}-other@example.test` } });
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const campaign = await prisma.campaign.create({ data: { name: key, slug: key, brandId: brand.id, createdById: user.id } });
  const codes = await Promise.all([0, 1, 2].map(i => prisma.qRCode.create({ data: { qrCodeData: `${key}-${i}`, campaignId: campaign.id, createdById: user.id } })));
  const deps = { resolveSession: async () => ({ user: { id: user.id, email: user.email } }), resolveBrandAdminContext: async () => null } as unknown as import("../src/lib/auth-session").AuthResolvers;
  const scan = (data: string) => scanImpl(new NextRequest("http://localhost/api/public/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qrCodeData: data }) }), deps);
  try {
    const results = await Promise.all([scan(codes[0].qrCodeData), scan(codes[0].qrCodeData)]);
    assert.deepEqual(results.map(r => r.status), [200, 200]);
    assert.equal((await prisma.qRCode.findUniqueOrThrow({ where: { id: codes[0].id } })).status, "USED");
    assert.equal(await prisma.campaignUnlock.count({ where: { qrCodeId: codes[0].id } }), 1);
    assert.equal(await prisma.pointTransaction.count({ where: { qrCodeId: codes[0].id } }), 1);
    const secondUserDeps = { ...deps, resolveSession: async () => ({ user: { id: otherUser.id, email: otherUser.email } }) } as typeof deps;
    const rescan = await scanImpl(new NextRequest("http://localhost/api/public/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ qrCodeData: codes[0].qrCodeData }) }), secondUserDeps);
    assert.equal(rescan.status, 200);
    assert.equal(await prisma.pointTransaction.count({ where: { userId: otherUser.id, qrCodeId: codes[0].id } }), 0);
    assert.equal(await prisma.campaignUnlock.count({ where: { userId: otherUser.id, qrCodeId: codes[0].id } }), 0);
    await assert.rejects(prisma.$transaction(tx => deleteUnusedQrCodes(tx, { codeIds: [codes[0].id], brandId: brand.id })), QrDeletionBlocked);

    let deleted!: () => void;
    let finish!: () => void;
    const deletedPromise = new Promise<void>(resolve => { deleted = resolve; });
    const finishPromise = new Promise<void>(resolve => { finish = resolve; });
    const deleteFirst = prisma.$transaction(async tx => {
      await deleteUnusedQrCodes(tx, { codeIds: [codes[1].id], brandId: brand.id });
      deleted();
      await finishPromise;
    });
    await deletedPromise;
    const losingScan = scan(codes[1].qrCodeData);
    finish();
    await deleteFirst;
    assert.equal((await losingScan).status, 404);

    // An actual race may resolve in either order, but must preserve every
    // history row and make the losing operation fail.
    const [racingScan, racingDelete] = await Promise.allSettled([
      scan(codes[2].qrCodeData),
      prisma.$transaction(tx => deleteUnusedQrCodes(tx, { codeIds: [codes[2].id], brandId: brand.id })),
    ]);
    assert.equal(racingScan.status, "fulfilled");
    if (racingScan.status === "fulfilled" && racingScan.value.status === 200) {
      assert.equal(racingDelete.status, "rejected");
      assert.ok(racingDelete.status === "rejected" && racingDelete.reason instanceof QrDeletionBlocked);
    } else {
      assert.equal(racingScan.status === "fulfilled" && racingScan.value.status, 404);
      assert.equal(racingDelete.status, "fulfilled");
    }
    assert.equal(await prisma.analyticsEvent.count({ where: { campaignId: campaign.id, qrCodeId: null } }), 0);
    assert.equal(await prisma.campaignUnlock.count({ where: { campaignId: campaign.id, qrCodeId: null } }), 0);
    assert.equal(await prisma.pointTransaction.count({ where: { userId: user.id, qrCodeId: null } }), 0);
  } finally {
    await prisma.analyticsEvent.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.campaignUnlock.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.pointTransaction.deleteMany({ where: { userId: user.id } });
    await prisma.userPointAccount.deleteMany({ where: { userId: user.id } });
    await prisma.qRCode.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.campaign.delete({ where: { id: campaign.id } });
    await prisma.brand.delete({ where: { id: brand.id } });
    await prisma.user.delete({ where: { id: otherUser.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("Postgres protects distributed, redeemed and historical QR records across individual deletion", { skip: skipReason }, async (t) => {
  const { default: prisma } = await import("../src/lib/prisma");
  const { deleteUnusedQrCodes, QrDeletionBlocked, unusedQrWhere } = await import("../src/lib/qr-lifecycle");
  const { deleteQrCodeImpl } = await import("../src/app/api/brand/qr-codes/[id]/route");
  const { NextRequest } = await import("next/server");
  const { v2: cloudinary } = await import("cloudinary");
  const key = randomUUID();
  const user = await prisma.user.create({ data: { email: `${key}@example.test` } });
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const campaign = await prisma.campaign.create({ data: { name: key, slug: key, brandId: brand.id, createdById: user.id } });
  const batchNames = ["clean", "exported", "printed", "redeemed", "anonymous", "ledger", "event"] as const;
  const batches = await Promise.all(batchNames.map(name => prisma.qRCodeBatch.create({ data: {
    name, campaignId: campaign.id, csvExportedAt: name === "exported" ? new Date() : null,
    printedAt: name === "printed" ? new Date() : null,
  } })));
  const codes = await Promise.all(batchNames.map((name, i) => prisma.qRCode.create({ data: {
    qrCodeData: `${key}-${name}`, qrCodeUrl: "https://res.cloudinary.com/test/image/upload/test.png",
    batchId: batches[i].id, campaignId: campaign.id, createdById: user.id,
    status: name === "redeemed" ? "USED" : "NEW", redeemedById: name === "redeemed" ? user.id : null,
  } })));
  const id = (name: typeof batchNames[number]) => codes[batchNames.indexOf(name)].id;
  const deps = { resolveSession: async () => ({ user: { id: user.id } }), resolveBrandAdminContext: async () => ({ membership: { brand: { id: brand.id, name: brand.name } } }) } as unknown as import("../src/lib/auth-session").AuthResolvers;
  let destroys = 0;
  t.mock.method(cloudinary.uploader, "destroy", async () => { destroys++; return {} as never; });
  try {
    await prisma.campaignUnlock.create({ data: { campaignId: campaign.id, qrCodeId: id("anonymous"), anonKey: key } });
    await prisma.pointTransaction.create({ data: { userId: user.id, qrCodeId: id("ledger"), reason: "QR_SCAN", points: 1 } });
    await prisma.userPointAccount.create({ data: { userId: user.id, spendablePoints: 1, lifetimeEarnedPoints: 1 } });
    await prisma.analyticsEvent.create({ data: { name: "qr_scan", campaignId: campaign.id, qrCodeId: id("event") } });
    const listed = await prisma.qRCodeBatch.findMany({ where: { id: { in: batches.map((batch) => batch.id) } }, select: { id: true, csvExportedAt: true, printedAt: true, qrCodes: { where: { NOT: { ...unusedQrWhere, campaign: { brandId: brand.id } } }, select: { id: true }, take: 1 } } });
    for (let index = 0; index < batchNames.length; index++) {
      const row = listed.find((item) => item.id === batches[index].id)!;
      assert.equal(!row.csvExportedAt && !row.printedAt && row.qrCodes.length === 0, batchNames[index] === "clean", batchNames[index]);
    }
    for (const name of batchNames.slice(1)) {
      const qrId = id(name);
      await assert.rejects(prisma.$transaction(tx => deleteUnusedQrCodes(tx, { codeIds: [qrId], brandId: brand.id })), QrDeletionBlocked, name);
      const response = await deleteQrCodeImpl(new NextRequest("http://localhost/qr", { method: "DELETE" }), { params: Promise.resolve({ id: qrId }) }, deps);
      assert.equal(response.status, 409, name);
      assert.equal((await response.json()).code, "QR_HAS_HISTORY", name);
      assert.ok(await prisma.qRCode.findUnique({ where: { id: qrId } }), name);
    }
    assert.equal(destroys, 0);
    assert.equal(await prisma.campaignUnlock.count({ where: { qrCodeId: id("anonymous") } }), 1);
    assert.equal(await prisma.pointTransaction.count({ where: { qrCodeId: id("ledger") } }), 1);
    assert.equal((await prisma.userPointAccount.findUniqueOrThrow({ where: { userId: user.id } })).spendablePoints, 1);
    assert.equal(await prisma.analyticsEvent.count({ where: { qrCodeId: id("event") } }), 1);
    await prisma.$transaction(tx => deleteUnusedQrCodes(tx, { codeIds: [id("clean")], brandId: brand.id }));
    assert.equal(await prisma.qRCode.findUnique({ where: { id: id("clean") } }), null);
  } finally {
    await prisma.analyticsEvent.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.campaignUnlock.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.pointTransaction.deleteMany({ where: { userId: user.id } });
    await prisma.userPointAccount.deleteMany({ where: { userId: user.id } });
    await prisma.qRCode.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.qRCodeBatch.deleteMany({ where: { campaignId: campaign.id } });
    await prisma.campaign.delete({ where: { id: campaign.id } });
    await prisma.brand.delete({ where: { id: brand.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});
