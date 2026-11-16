process.env.APP_ENCRYPTION_KEY ||= "dummy-encryption-key-at-least-32-chars-long";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { CommerceProvider } from "@prisma/client";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("COMMERCE_OVERVIEW_REAL_DB");
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

async function world() {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID().slice(0, 8);
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const shopify = await prisma.commerceConnection.create({
    data: { brandId: brand.id, provider: "SHOPIFY", status: "CONNECTED", displayName: "Shop", externalAccountId: `${key}.myshopify.com`, isPrimary: true },
  });
  const commerce7 = await prisma.commerceConnection.create({
    data: { brandId: brand.id, provider: "COMMERCE7", status: "REQUIRES_RECONNECT", displayName: "Winery", externalAccountId: `${key}-c7`, isPrimary: false },
  });
  const run = (connectionId: string, provider: CommerceProvider, status: "SUCCEEDED" | "FAILED" | "PARTIAL" | "RUNNING", startedAt: Date) =>
    prisma.commerceProductSyncRun.create({
      data: { connectionId, brandId: brand.id, provider, status, startedAt, finishedAt: status === "RUNNING" ? null : new Date(startedAt.getTime() + 60_000) },
    });
  const ctx = async () => ({ userId: "u", selectionRequired: false, brands: [], membership: { id: "m", role: "ADMIN", brand: { id: brand.id, name: "B", slug: key } } }) as never;
  const cleanup = async () => {
    await prisma.commerceProductSyncRun.deleteMany({ where: { brandId: brand.id } });
    await prisma.commerceConnection.deleteMany({ where: { brandId: brand.id } });
    await prisma.brand.deleteMany({ where: { id: brand.id } });
  };
  return { prisma, brand, shopify, commerce7, run, ctx, cleanup };
}

test("the connections list shows every connection with distinct states and honest sync facts", { skip: skipReason }, async () => {
  const { commerceConnectionsGetImpl } = await import("../src/app/api/brand/commerce/connections/route");
  const w = await world();
  try {
    await w.run(w.shopify.id, "SHOPIFY", "SUCCEEDED", hoursAgo(5));
    const older = await w.run(w.shopify.id, "SHOPIFY", "SUCCEEDED", hoursAgo(9));
    await w.run(w.shopify.id, "SHOPIFY", "FAILED", hoursAgo(1));
    await w.run(w.commerce7.id, "COMMERCE7", "PARTIAL", hoursAgo(2));
    // A stale preview-era stamp must not be displayed as a completed sync.
    await w.prisma.commerceConnection.update({ where: { id: w.shopify.id }, data: { lastProductSyncAt: new Date() } });

    const response = await commerceConnectionsGetImpl({ getContext: w.ctx });
    assert.equal(response.status, 200);
    const { connections, complete } = (await response.json()).data as {
      connections: Array<{ connectionId: string; provider: string; status: string; lastCompletedSyncAt: string | null; lastSyncAttempt: { status: string } | null; lastProductSyncAt: string | null }>;
      complete: boolean;
    };
    assert.equal(complete, true);
    assert.equal(connections.length, 2, "both providers are listed, not just a preferred one");
    const shopify = connections.find((c) => c.provider === "SHOPIFY")!;
    const c7 = connections.find((c) => c.provider === "COMMERCE7")!;
    assert.equal(shopify.status, "CONNECTED");
    assert.equal(c7.status, "REQUIRES_RECONNECT");

    assert.equal(shopify.lastSyncAttempt?.status, "FAILED", "the newest run is the attempt");
    const completed = new Date(shopify.lastCompletedSyncAt!).getTime();
    assert.ok(Math.abs(completed - (hoursAgo(5).getTime() + 60_000)) < 2_000, "completion is the newest SUCCEEDED run, not the failed one or the stamp");
    assert.notEqual(older.id, undefined);
    assert.ok(shopify.lastProductSyncAt, "the legacy field is still returned for old clients");

    assert.equal(c7.lastCompletedSyncAt, null, "a partial run is an attempt, not a completion");
    assert.equal(c7.lastSyncAttempt?.status, "PARTIAL");
  } finally {
    await w.cleanup();
  }
});

test("a brand with no sync history reads as never completed and a failing history lookup does not hide connections", { skip: skipReason }, async () => {
  const { commerceConnectionsGetImpl } = await import("../src/app/api/brand/commerce/connections/route");
  const w = await world();
  try {
    const empty = await (await commerceConnectionsGetImpl({ getContext: w.ctx })).json();
    for (const c of empty.data.connections) {
      assert.equal(c.lastCompletedSyncAt, null);
      assert.equal(c.lastSyncAttempt, null);
    }
    const failing = await commerceConnectionsGetImpl({ getContext: w.ctx, getSyncSummaries: async () => { throw new Error("history unavailable"); } });
    assert.equal(failing.status, 200);
    assert.equal((await failing.json()).data.connections.length, 2);
  } finally {
    await w.cleanup();
  }
});

test("opening product previews repeatedly leaves the connection's sync stamp alone; only a real sync moves it", { skip: skipReason }, async () => {
  const { ShopifyCommerceAdapter } = await import("../src/lib/commerce/providers/shopify-commerce-adapter");
  const w = await world();
  try {
    const adapter = new ShopifyCommerceAdapter({
      loadConnection: async (id: string) =>
        (await w.prisma.commerceConnection.findUnique({ where: { id } })) as never,
      fetchProducts: async () => ({ ok: true as const, items: [], hasNextPage: false, limit: 50, endCursor: null }),
      markProductSync: async (id: string, at: Date) => {
        await w.prisma.commerceConnection.updateMany({ where: { id }, data: { lastProductSyncAt: at } });
      },
    } as never);
    const before = await w.prisma.commerceConnection.findUniqueOrThrow({ where: { id: w.shopify.id } });
    for (let i = 0; i < 10; i++) await adapter.previewProducts(w.shopify.id);
    const after = await w.prisma.commerceConnection.findUniqueOrThrow({ where: { id: w.shopify.id } });
    assert.equal(after.lastProductSyncAt, null);
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), "the connection row is not touched at all");
    assert.equal(await w.prisma.commerceProductSyncRun.count({ where: { connectionId: w.shopify.id } }), 0);

    await adapter.completeProductSync(w.shopify.id, new Date());
    assert.ok((await w.prisma.commerceConnection.findUniqueOrThrow({ where: { id: w.shopify.id } })).lastProductSyncAt);
  } finally {
    await w.cleanup();
  }
});
