/**
 * PHASE 18 — PART 6: per-connection order operations summary.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import {
  getBrandOrderOperationsSummary,
  type OrderOperationsSummaryDeps,
} from "../src/lib/commerce/order-operations-summary";
import { brandCommerceOrdersSummaryGetImpl } from "../src/app/api/brand/commerce/orders/summary/route";
import type { BrandAdminContext } from "../src/lib/brand-auth";
import type { CommerceConnectionSummary } from "../src/lib/commerce/types";

function makeContext(): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired: false,
    brands: [{ id: "brand-a", name: "Acme", slug: "acme", membershipRole: "ADMIN" }],
    membership: {
      id: "member-1",
      role: "ADMIN",
      brand: { id: "brand-a", name: "Acme", slug: "acme", bio: null, websiteUrl: null, logoUrl: null, coverImageUrl: null },
    },
  };
}

function connectionSummary(overrides: Partial<CommerceConnectionSummary> = {}): CommerceConnectionSummary {
  return {
    id: "conn-1",
    brandId: "brand-a",
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    displayName: "Acme Winery",
    externalAccountId: "tenant-1",
    storefrontUrl: "https://shop.example.com",
    isPrimary: true,
    grantedScopes: [],
    installedAt: null,
    uninstalledAt: null,
    lastProductSyncAt: null,
    currencyCode: "USD",
    productRoute: "/product",
    ...overrides,
  };
}

describe("getBrandOrderOperationsSummary", () => {
  test("orderReceiverConfigured reflects Commerce7 webhook env readiness, and is null for a non-COMMERCE7 connection", async () => {
    const originalU = process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME;
    const originalP = process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD;
    delete process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME;
    delete process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD;
    try {
      const shopify = connectionSummary({ id: "conn-shopify", provider: CommerceProvider.SHOPIFY });
      const commerce7 = connectionSummary({ id: "conn-c7" });
      const stubDeps: Partial<OrderOperationsSummaryDeps> = {
        countOrdersByFinancialStatus: async () => [],
        countAttributedOrders: async () => 0,
        countUnattributedOrders: async () => 0,
        findLatestOrderIngestedAt: async () => null,
        findLatestWebhookProcessedAt: async () => null,
      };
      const notConfigured = await getBrandOrderOperationsSummary("brand-a", {
        ...stubDeps,
        getConnections: async () => ({ connections: [shopify, commerce7], complete: true }),
      });
      const byId = new Map(notConfigured.connections.map((c) => [c.connectionId, c]));
      assert.equal(byId.get("conn-shopify")?.orderReceiverConfigured, null);
      assert.equal(byId.get("conn-c7")?.orderReceiverConfigured, false);

      process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME = "hookuser";
      process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD = "hookpass";
      const configured = await getBrandOrderOperationsSummary("brand-a", {
        ...stubDeps,
        getConnections: async () => ({ connections: [commerce7], complete: true }),
      });
      assert.equal(configured.connections[0]?.orderReceiverConfigured, true);
    } finally {
      if (originalU === undefined) delete process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME;
      else process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME = originalU;
      if (originalP === undefined) delete process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD;
      else process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD = originalP;
    }
  });

  test("aggregates per-connection counts without exposing any customer field", async () => {
    const result = await getBrandOrderOperationsSummary("brand-a", {
      getConnections: async () => ({ connections: [connectionSummary()], complete: true }),
      countOrdersByFinancialStatus: async () => [
        { financialStatus: "PAID", count: 3 },
        { financialStatus: "REFUNDED", count: 1 },
        { financialStatus: null, count: 2 },
      ],
      countAttributedOrders: async () => 4,
      countUnattributedOrders: async () => 2,
      findLatestOrderIngestedAt: async () => new Date("2026-02-01T00:00:00.000Z"),
      findLatestWebhookProcessedAt: async () => new Date("2026-02-02T00:00:00.000Z"),
    });

    assert.equal(result.complete, true);
    assert.equal(result.connections.length, 1);
    const [summary] = result.connections;
    assert.equal(summary.provider, "COMMERCE7");
    assert.equal(summary.orderCountsByFinancialStatus.PAID, 3);
    assert.equal(summary.orderCountsByFinancialStatus.REFUNDED, 1);
    assert.equal(summary.unknownFinancialStatusCount, 2);
    assert.equal(summary.attributedOrderCount, 4);
    assert.equal(summary.unattributedOrderCount, 2);
    assert.equal(summary.latestOrderIngestedAt, "2026-02-01T00:00:00.000Z");
    assert.equal(summary.latestWebhookProcessedAt, "2026-02-02T00:00:00.000Z");

    const serialized = JSON.stringify(result);
    for (const forbidden of ["email", "address", "customer", "creditCard", "cardNumber"]) {
      assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()));
    }
  });

  test("an incomplete underlying connection list is surfaced honestly, not silently dropped", async () => {
    const result = await getBrandOrderOperationsSummary("brand-a", {
      getConnections: async () => ({ connections: [connectionSummary()], complete: false }),
      countOrdersByFinancialStatus: async () => [],
      countAttributedOrders: async () => 0,
      countUnattributedOrders: async () => 0,
      findLatestOrderIngestedAt: async () => null,
      findLatestWebhookProcessedAt: async () => null,
    });
    assert.equal(result.complete, false);
  });

  test("multiple connections across providers are each summarized independently", async () => {
    const shopify = connectionSummary({
      id: "conn-shopify",
      provider: CommerceProvider.SHOPIFY,
      externalAccountId: "shop-1.myshopify.com",
    });
    const commerce7 = connectionSummary({ id: "conn-c7" });

    const perConnectionCounts: Record<string, number> = { "conn-shopify": 10, "conn-c7": 5 };
    const deps: Partial<OrderOperationsSummaryDeps> = {
      getConnections: async () => ({ connections: [shopify, commerce7], complete: true }),
      countOrdersByFinancialStatus: async (connectionId) => [
        { financialStatus: "PAID", count: perConnectionCounts[connectionId] ?? 0 },
      ],
      countAttributedOrders: async () => 0,
      countUnattributedOrders: async () => 0,
      findLatestOrderIngestedAt: async () => null,
      findLatestWebhookProcessedAt: async () => null,
    };

    const result = await getBrandOrderOperationsSummary("brand-a", deps);
    assert.equal(result.connections.length, 2);
    const byId = new Map(result.connections.map((c) => [c.connectionId, c]));
    assert.equal(byId.get("conn-shopify")?.orderCountsByFinancialStatus.PAID, 10);
    assert.equal(byId.get("conn-c7")?.orderCountsByFinancialStatus.PAID, 5);
  });

  test("no connections yields an empty, still-complete summary", async () => {
    const result = await getBrandOrderOperationsSummary("brand-a", {
      getConnections: async () => ({ connections: [], complete: true }),
    });
    assert.deepEqual(result.connections, []);
    assert.equal(result.complete, true);
  });
});

describe("route: brandCommerceOrdersSummaryGetImpl", () => {
  test("unauthenticated caller never reaches getSummary()", async () => {
    let called = false;
    const res = await brandCommerceOrdersSummaryGetImpl({
      getContext: async () => null,
      getSummary: async () => {
        called = true;
        return { connections: [], complete: true };
      },
    });
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("brandId passed to getSummary is always the authenticated context's own brand", async () => {
    let captured: string | null = null;
    const res = await brandCommerceOrdersSummaryGetImpl({
      getContext: async () => makeContext(),
      getSummary: async (brandId) => {
        captured = brandId;
        return { connections: [], complete: true };
      },
    });
    assert.equal(res.status, 200);
    assert.equal(captured, "brand-a");
  });
});
