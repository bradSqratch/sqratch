import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { realDbTest } from "./helpers/real-db";
import type { AuthResolvers } from "../src/lib/auth-session";

const { skipReason } = realDbTest("QR_INVENTORY_REAL_DB");
const CODES = 320;
const BATCHES = 640;

async function world() {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID().slice(0, 8);
  const admin = await prisma.user.create({ data: { email: `${key}-admin@example.test`, role: "BRAND_ADMIN" } });
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const otherBrand = await prisma.brand.create({ data: { name: `${key}-o`, slug: `${key}-o` } });
  const campaign = await prisma.campaign.create({ data: { name: `Main ${key}`, slug: key, brandId: brand.id, createdById: admin.id } });
  const otherCampaign = await prisma.campaign.create({ data: { name: `Other ${key}`, slug: `${key}-oc`, brandId: otherBrand.id, createdById: admin.id } });
  // 700 campaigns beyond the old 500 cap, so the last one must still be reachable.
  await prisma.campaign.createMany({
    data: Array.from({ length: 700 }, (_, i) => ({ name: `Bulk ${String(i).padStart(4, "0")} ${key}`, slug: `${key}-bulk-${i}`, brandId: brand.id, createdById: admin.id })),
  });
  const big = await prisma.qRCodeBatch.create({ data: { name: `big-${key}`, campaignId: campaign.id } });
  await prisma.qRCode.createMany({
    data: Array.from({ length: CODES }, (_, i) => ({ qrCodeData: `${key}-c${String(i).padStart(4, "0")}`, campaignId: campaign.id, createdById: admin.id, batchId: big.id })),
  });
  await prisma.qRCodeBatch.createMany({
    data: Array.from({ length: BATCHES }, (_, i) => ({ name: `lot-${String(i + 1).padStart(4, "0")}-${key}`, campaignId: campaign.id })),
  });
  const foreignBatch = await prisma.qRCodeBatch.create({ data: { name: `foreign-${key}`, campaignId: otherCampaign.id } });
  await prisma.qRCode.create({ data: { qrCodeData: `${key}-foreign`, campaignId: otherCampaign.id, createdById: admin.id, batchId: foreignBatch.id } });
  const deps = {
    resolveSession: async () => ({ user: { id: admin.id, role: "BRAND_ADMIN" } }),
    resolveBrandAdminContext: async () => ({ userId: admin.id, selectionRequired: false, brands: [], membership: { id: "m", role: "ADMIN", brand: { id: brand.id, name: "Brand", slug: "brand" } } }),
  } as unknown as AuthResolvers;
  const cleanup = async () => {
    const campaignIds = (await prisma.campaign.findMany({ where: { brandId: { in: [brand.id, otherBrand.id] } }, select: { id: true } })).map((c) => c.id);
    await prisma.qRCode.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.qRCodeBatch.deleteMany({ where: { campaignId: { in: campaignIds } } });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await prisma.brand.deleteMany({ where: { id: { in: [brand.id, otherBrand.id] } } });
    await prisma.user.deleteMany({ where: { id: admin.id } });
  };
  return { prisma, key, deps, brand, campaign, otherCampaign, big, foreignBatch, cleanup };
}

const get = (path: string) => new NextRequest(`http://localhost${path}`);

test("every code is reachable by paging and filtering, with accurate server totals", { skip: skipReason }, async () => {
  const { listQrBatchesImpl } = await import("../src/app/api/brand/qr-batches/route");
  const w = await world();
  try {
    const list = async (query: string) => {
      const response = await listQrBatchesImpl(get(`/api/brand/qr-batches?${query}`), w.deps);
      assert.equal(response.status, 200, query);
      return (await response.json()).data as {
        qrCodes: Array<{ id: string; code: string; status: string }>;
        batches: Array<{ id: string; name: string; canDelete: boolean; quantity: number }>;
        pagination: { total: number; totalPages: number; page: number };
        batchPagination: { total: number; totalPages: number };
      };
    };

    const seen = new Set<string>();
    for (let page = 1; page <= 4; page++) {
      const data = await list(`pageSize=100&page=${page}`);
      assert.equal(data.pagination.total, CODES);
      assert.equal(data.pagination.totalPages, 4);
      assert.equal(data.qrCodes.length, page === 4 ? CODES - 300 : 100);
      data.qrCodes.forEach((code) => seen.add(code.id));
    }
    assert.equal(seen.size, CODES, "every code appears exactly once across pages, including the 201st and beyond");
    assert.ok(![...(await list("page=1")).qrCodes].some((c) => c.code.endsWith("foreign")), "another brand's code never appears");

    const exact = await list(`q=${w.key}-c0299&pageSize=50`);
    assert.deepEqual(exact.qrCodes.map((c) => c.code), [`${w.key}-c0299`]);
    assert.equal((await list(`q=${encodeURIComponent(`https://example.test/q/${w.key}-c0299?x=1`)}`)).pagination.total, 1, "a pasted scan link finds the code");
    assert.equal((await list(`q=${w.key}-c03`)).pagination.total, 20);
    assert.equal((await list(`q=${w.key}-c0299x`)).pagination.total, 0);

    await w.prisma.qRCode.updateMany({ where: { qrCodeData: { in: [`${w.key}-c0001`, `${w.key}-c0300`] } }, data: { status: "USED", usedAt: new Date() } });
    const redeemed = await list("status=REDEEMED");
    assert.equal(redeemed.pagination.total, 2);
    assert.ok(redeemed.qrCodes.every((c) => c.status === "REDEEMED"));
    assert.equal((await list("status=NEW")).pagination.total, CODES - 2);

    assert.equal((await list(`batchId=${w.big.id}`)).pagination.total, CODES);
    assert.equal((await list(`batchId=${w.foreignBatch.id}`)).pagination.total, 0, "a foreign batch id matches nothing");
    assert.equal((await list(`campaignId=${w.otherCampaign.id}`)).pagination.total, 0, "a foreign campaign id matches nothing");
    assert.equal((await list(`campaignId=${w.campaign.id}&status=REDEEMED&q=${w.key}-c03`)).pagination.total, 1);

    const bad = await listQrBatchesImpl(get("/api/brand/qr-batches?status=PENDING"), w.deps);
    assert.equal(bad.status, 400);
    assert.equal((await listQrBatchesImpl(get("/api/brand/qr-batches?archived=nope"), w.deps)).status, 400);

    // Batch list: paginated with accurate totals; the 600th+ batch is findable; eligibility is still per batch.
    const firstBatches = await list("batchPageSize=25");
    assert.equal(firstBatches.batchPagination.total, BATCHES + 1);
    assert.equal(firstBatches.batches.length, 25);
    const found = await list(`batchQ=lot-0${BATCHES}-${w.key}`);
    assert.equal(found.batches.length, 1);
    assert.equal(found.batches[0].canDelete, true);
    const bigRow = (await list(`batchQ=big-${w.key}`)).batches[0];
    assert.equal(bigRow.quantity, CODES);
    assert.equal(bigRow.canDelete, false, "a batch holding a redeemed code can never be deleted");
  } finally {
    await w.cleanup();
  }
});

test("batch and campaign options search and page past the old 500 caps, scoped to the brand", { skip: skipReason }, async () => {
  const { listQrOptionsImpl } = await import("../src/app/api/brand/qr-batches/options/route");
  const w = await world();
  try {
    const page = async (query: string) => {
      const response = await listQrOptionsImpl(get(`/api/brand/qr-batches/options?${query}`), w.deps);
      assert.equal(response.status, 200, query);
      return (await response.json()).data as { items: Array<{ id: string; name: string }>; nextCursor: string | null };
    };

    const all = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const data: { items: Array<{ id: string; name: string }>; nextCursor: string | null } = await page(`type=batches&limit=50${cursor ? `&cursor=${cursor}` : ""}`);
      data.items.forEach((item) => all.add(item.id));
      cursor = data.nextCursor;
      pages += 1;
    } while (cursor && pages < 50);
    assert.equal(all.size, BATCHES + 1, "cursor paging reaches every batch");
    assert.ok(!all.has(w.foreignBatch.id));

    const search = await page(`type=batches&q=lot-0${BATCHES}-${w.key}`);
    assert.equal(search.items.length, 1);
    const campaigns = await page(`type=campaigns&q=Bulk 0699 ${w.key}`);
    assert.equal(campaigns.items.length, 1, "the 700th campaign is searchable");
    assert.equal((await page(`type=campaigns&q=Other ${w.key}`)).items.length, 0, "another brand's campaign is not offered");

    const foreignBatchCursor = await page(`type=batches&cursor=${w.foreignBatch.id}`);
    assert.deepEqual(foreignBatchCursor.items, [], "a cursor outside the brand scope yields nothing");
    const foreignCampaignCursor = await page(`type=campaigns&cursor=${w.otherCampaign.id}`);
    assert.deepEqual(foreignCampaignCursor.items, []);
    assert.equal((await listQrOptionsImpl(get("/api/brand/qr-batches/options?type=nope"), w.deps)).status, 400);
    const noSession = await listQrOptionsImpl(get("/api/brand/qr-batches/options?type=batches"), { ...w.deps, resolveSession: async () => null } as AuthResolvers);
    assert.equal(noSession.status, 401);
  } finally {
    await w.cleanup();
  }
});

test("archived and deleted batches behave in search, and CSV export still covers every code", { skip: skipReason }, async () => {
  const { listQrBatchesImpl } = await import("../src/app/api/brand/qr-batches/route");
  const { listQrOptionsImpl } = await import("../src/app/api/brand/qr-batches/options/route");
  const { exportBatchImpl } = await import("../src/app/api/brand/qr-batches/[id]/export/route");
  const w = await world();
  try {
    const target = await w.prisma.qRCodeBatch.findFirstOrThrow({ where: { name: `lot-0007-${w.key}` } });
    await w.prisma.qRCodeBatch.update({ where: { id: target.id }, data: { archivedAt: new Date() } });
    const names = async (query: string) => ((await (await listQrBatchesImpl(get(`/api/brand/qr-batches?${query}`), w.deps)).json()).data.batches as Array<{ name: string }>).map((b) => b.name);
    assert.deepEqual(await names(`batchQ=lot-0007-${w.key}`), []);
    assert.deepEqual(await names(`batchQ=lot-0007-${w.key}&archived=only`), [target.name]);
    assert.deepEqual(await names(`batchQ=lot-0007-${w.key}&archived=include`), [target.name]);
    const options = await (await listQrOptionsImpl(get(`/api/brand/qr-batches/options?type=batches&q=lot-0007-${w.key}&archived=exclude`), w.deps)).json();
    assert.equal(options.data.items.length, 0);

    await w.prisma.qRCodeBatch.delete({ where: { id: target.id } });
    assert.deepEqual(await names(`batchQ=lot-0007-${w.key}&archived=include`), []);

    const csv = await exportBatchImpl(get(`/api/brand/qr-batches/${w.big.id}/export`), { params: Promise.resolve({ id: w.big.id }) }, w.deps);
    assert.equal(csv.status, 200);
    const rows = (await csv.text()).trim().split("\n");
    assert.equal(rows.length, CODES + 1, "header plus every code, not a page of them");
  } finally {
    await w.cleanup();
  }
});
