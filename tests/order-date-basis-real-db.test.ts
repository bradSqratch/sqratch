process.env.APP_ENCRYPTION_KEY ||= "dummy-encryption-key-at-least-32-chars-long";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { realDbTest } from "./helpers/real-db";

const { skipReason } = realDbTest("ORDER_DATE_BASIS_REAL_DB");
const at = (iso: string) => new Date(iso);

async function world() {
  const { default: prisma } = await import("../src/lib/prisma");
  const key = randomUUID().slice(0, 8);
  const user = await prisma.user.create({ data: { email: `${key}@example.test`, role: "CREATOR" } });
  const creator = await prisma.creatorProfile.create({ data: { userId: user.id, displayName: "C" } });
  const experience = await prisma.experience.create({ data: { title: key, slug: key, creatorId: creator.id } });
  const brand = await prisma.brand.create({ data: { name: key, slug: key } });
  const otherBrand = await prisma.brand.create({ data: { name: `${key}-o`, slug: `${key}-o` } });
  const connection = await prisma.commerceConnection.create({ data: { brandId: brand.id, provider: "SHOPIFY", status: "CONNECTED", displayName: "S", externalAccountId: `${key}.myshopify.com` } });
  const otherConnection = await prisma.commerceConnection.create({ data: { brandId: otherBrand.id, provider: "SHOPIFY", status: "CONNECTED", displayName: "S", externalAccountId: `${key}-o.myshopify.com` } });

  let n = 0;
  const attribution = async (brandId: string) =>
    prisma.commerceClickAttribution.create({
      data: { tokenHash: `${key}-h${n}`, tokenPrefix: `p${n++}`, attributedBrandId: brandId, experienceId: experience.id, creatorProfileId: creator.id, destinationUrl: "https://shop.example.test/p", destinationHost: "shop.example.test", expiresAt: new Date(Date.now() + 86_400_000) },
    });
  const order = async (spec: {
    brandId?: string; connectionId?: string; providerCreatedAt: Date | null; createdAt: Date; status: "PAID" | "REFUNDED" | "PENDING";
    currency: string; total: number; refunded?: number; attributed?: boolean;
  }) => {
    const brandId = spec.brandId ?? brand.id;
    const refunded = spec.refunded ?? 0;
    return prisma.commerceOrder.create({
      data: {
        connectionId: spec.connectionId ?? connection.id, brandId, provider: "SHOPIFY", externalOrderId: `${key}-${n++}`,
        currencyCode: spec.currency, totalMinor: BigInt(spec.total), totalRefundedMinor: BigInt(refunded), netRevenueMinor: BigInt(spec.total - refunded),
        financialStatus: spec.status, providerCreatedAt: spec.providerCreatedAt, createdAt: spec.createdAt,
        ...(spec.attributed === false ? {} : { attributionId: (await attribution(brandId)).id }),
      },
    });
  };
  // Delayed ingestion: placed Oct 30, received Nov 2.
  await order({ providerCreatedAt: at("2026-10-30T12:00:00Z"), createdAt: at("2026-11-02T08:00:00Z"), status: "PAID", currency: "USD", total: 10000 });
  // No provider date: dated by receipt, Oct 15.
  await order({ providerCreatedAt: null, createdAt: at("2026-10-15T09:00:00Z"), status: "PAID", currency: "USD", total: 5000 });
  // Fully refunded CAD order placed Oct 20.
  await order({ providerCreatedAt: at("2026-10-20T10:00:00Z"), createdAt: at("2026-10-21T10:00:00Z"), status: "REFUNDED", currency: "CAD", total: 3000, refunded: 3000 });
  // Placed in September, received in October.
  await order({ providerCreatedAt: at("2026-09-28T10:00:00Z"), createdAt: at("2026-10-03T10:00:00Z"), status: "PAID", currency: "USD", total: 700 });
  // Unattributed, placed Nov 5.
  await order({ providerCreatedAt: at("2026-11-05T10:00:00Z"), createdAt: at("2026-11-06T10:00:00Z"), status: "PENDING", currency: "USD", total: 2000, attributed: false });
  // Another brand's order in the window must never appear.
  await order({ brandId: otherBrand.id, connectionId: otherConnection.id, providerCreatedAt: at("2026-10-10T10:00:00Z"), createdAt: at("2026-10-10T10:00:00Z"), status: "PAID", currency: "USD", total: 99999 });

  const brandCtx = async () => ({ userId: user.id, selectionRequired: false, brands: [], membership: { id: "m", role: "ADMIN", brand: { id: brand.id, name: "B", slug: key } } }) as never;
  const creatorCtx = async () => ({ userId: user.id, creatorProfile: { id: creator.id } }) as never;
  const cleanup = async () => {
    await prisma.commerceOrder.deleteMany({ where: { brandId: { in: [brand.id, otherBrand.id] } } });
    await prisma.commerceClickAttribution.deleteMany({ where: { experienceId: experience.id } });
    await prisma.commerceConnection.deleteMany({ where: { brandId: { in: [brand.id, otherBrand.id] } } });
    await prisma.brand.deleteMany({ where: { id: { in: [brand.id, otherBrand.id] } } });
    await prisma.experience.deleteMany({ where: { id: experience.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  };
  return { brandCtx, creatorCtx, cleanup };
}

type Money = Array<{ currencyCode: string; minor: string }>;
type Report = {
  dateBasis: string; fallbackOrderCount: number; totalIngestedOrders: number; attributedOrders: number; fullyRefundedOrders: number;
  attributedOrderValueByCurrency: Money; refundedAttributedValueByCurrency: Money; currentNetAttributedOrderValueByCurrency: Money;
  dailyTrend: Array<{ date: string; attributedOrders: number; attributedOrderValueByCurrency: Money }>;
};
const money = (rows: Money) => Object.fromEntries(rows.map((row) => [row.currencyCode, row.minor]));
const sumTrend = (report: Report) => report.dailyTrend.reduce((total, day) => total + day.attributedOrders, 0);

test("brand report: provider date places a delayed order in the earlier period; ingestion date in the later one", { skip: skipReason }, async () => {
  const { brandConversionsGetImpl } = await import("../src/app/api/brand/analytics/conversions/route");
  const w = await world();
  try {
    const get = async (query: string) => {
      const response = await brandConversionsGetImpl(new NextRequest(`http://localhost/api/brand/analytics/conversions?${query}`), w.brandCtx);
      assert.equal(response.status, 200, query);
      return (await response.json()).data as Report;
    };
    const octProvider = await get("dateFrom=2026-10-01&dateTo=2026-10-31&dateBasis=provider");
    assert.equal(octProvider.dateBasis, "provider");
    assert.equal(octProvider.totalIngestedOrders, 3, "placed Oct 30, Oct 15 (receipt date, no store date) and Oct 20");
    assert.equal(octProvider.attributedOrders, 3);
    assert.equal(octProvider.fallbackOrderCount, 1);
    assert.deepEqual(money(octProvider.attributedOrderValueByCurrency), { USD: "15000", CAD: "3000" }, "currencies stay separate, other brand excluded");
    assert.deepEqual(money(octProvider.refundedAttributedValueByCurrency), { CAD: "3000", USD: "0" });
    assert.equal(octProvider.fullyRefundedOrders, 1);
    assert.equal(octProvider.dailyTrend.find((d) => d.date === "2026-10-30")?.attributedOrders, 1, "bucketed on the store's date");
    assert.equal(octProvider.dailyTrend.find((d) => d.date === "2026-11-02"), undefined);
    assert.equal(sumTrend(octProvider), octProvider.attributedOrders, "trend totals equal headline totals");

    const octIngested = await get("dateFrom=2026-10-01&dateTo=2026-10-31&dateBasis=ingested");
    assert.equal(octIngested.dateBasis, "ingested");
    assert.equal(octIngested.totalIngestedOrders, 3, "received Oct 3, Oct 15 and Oct 21");
    assert.equal(octIngested.fallbackOrderCount, 0);
    assert.deepEqual(money(octIngested.attributedOrderValueByCurrency), { USD: "5700", CAD: "3000" });
    assert.equal(sumTrend(octIngested), octIngested.attributedOrders);

    const novProvider = await get("dateFrom=2026-11-01&dateTo=2026-11-15&dateBasis=provider");
    assert.equal(novProvider.totalIngestedOrders, 1, "only the Nov 5 order was placed in November");
    assert.equal(novProvider.attributedOrders, 0);
    const novIngested = await get("dateFrom=2026-11-01&dateTo=2026-11-15&dateBasis=ingested");
    assert.equal(novIngested.totalIngestedOrders, 2, "the Oct 30 order was received on Nov 2");
    assert.equal(novIngested.attributedOrders, 1);
    assert.equal(sumTrend(novIngested), 1);

    const defaulted = await get("dateFrom=2026-10-01&dateTo=2026-10-31");
    assert.equal(defaulted.dateBasis, "provider", "the store's order date is the default basis");
    assert.equal(defaulted.totalIngestedOrders, octProvider.totalIngestedOrders);

    const bad = await brandConversionsGetImpl(new NextRequest("http://localhost/api/brand/analytics/conversions?dateBasis=payment"), w.brandCtx);
    assert.equal(bad.status, 400);
  } finally {
    await w.cleanup();
  }
});

test("creator report uses the same basis and fallback accounting, scoped to the creator's attribution", { skip: skipReason }, async () => {
  const { creatorConversionsGetImpl } = await import("../src/app/api/creator/analytics/conversions/route");
  const w = await world();
  try {
    const get = async (query: string) => {
      const response = await creatorConversionsGetImpl(new NextRequest(`http://localhost/api/creator/analytics/conversions?${query}`), w.creatorCtx);
      assert.equal(response.status, 200, query);
      return (await response.json()).data as Report;
    };
    const provider = await get("dateFrom=2026-10-01&dateTo=2026-10-31&dateBasis=provider");
    assert.equal(provider.dateBasis, "provider");
    // A creator's orders span brands, so the other brand's attributed order is included.
    assert.equal(provider.attributedOrders, 4);
    assert.equal(provider.fallbackOrderCount, 1);
    assert.equal(sumTrend(provider), 4);
    const ingested = await get("dateFrom=2026-10-01&dateTo=2026-10-31&dateBasis=ingested");
    assert.equal(ingested.attributedOrders, 4);
    assert.equal(ingested.fallbackOrderCount, 0);
    assert.deepEqual(money(ingested.attributedOrderValueByCurrency), { USD: "105699", CAD: "3000" });
    assert.equal((await creatorConversionsGetImpl(new NextRequest("http://localhost/x?dateBasis=nope"), w.creatorCtx)).status, 400);
  } finally {
    await w.cleanup();
  }
});
