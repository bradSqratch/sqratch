/**
 * PHASE 19 — PART 11: Brand-owned order detail.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import {
  getBrandCommerceOrderDetail,
  readRefundAnomaly,
  type OrderDetailRow,
} from "../src/lib/commerce/order-detail";
import { brandCommerceOrderDetailGetImpl } from "../src/app/api/brand/commerce/orders/[orderId]/route";
import type { BrandAdminContext } from "../src/lib/brand-auth";

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

function orderRow(overrides: Partial<OrderDetailRow> = {}): OrderDetailRow {
  return {
    id: "order-1",
    connectionId: "conn-1",
    provider: CommerceProvider.COMMERCE7,
    orderNumber: "1001",
    providerCreatedAt: new Date("2026-01-05T00:00:00.000Z"),
    providerUpdatedAt: new Date("2026-08-26T18:11:55.847Z"),
    createdAt: new Date("2026-01-05T00:05:00.000Z"),
    updatedAt: new Date("2026-01-06T00:00:00.000Z"),
    financialStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    currencyCode: "USD",
    minorUnitExponent: 2,
    subtotalMinor: BigInt(5000),
    shippingMinor: BigInt(500),
    taxMinor: BigInt(400),
    totalMinor: BigInt(5900),
    totalRefundedMinor: BigInt(0),
    netRevenueMinor: BigInt(5900),
    attributionId: "attr-1",
    connection: { displayName: "Acme Winery", externalAccountId: "acme-tenant" },
    lineItems: [
      {
        id: "li-1",
        title: "2015 Chardonnay",
        sku: "2015C",
        quantity: 2,
        unitPriceMinor: BigInt(2500),
        totalMinor: BigInt(5000),
        externalProductId: "prod-ext-1",
        externalVariantId: "var-ext-1",
        connectedProductId: "ccp-1",
      },
    ],
    ...overrides,
  };
}

describe("getBrandCommerceOrderDetail", () => {
  test("resolves a full detail DTO including line items, money as strings", async () => {
    const detail = await getBrandCommerceOrderDetail("order-1", "brand-a", { findLatestAppliedEventNote: async () => null,
      findOrder: async (orderId, brandId) => {
        assert.equal(orderId, "order-1");
        assert.equal(brandId, "brand-a");
        return orderRow();
      },
    });
    assert.ok(detail);
    assert.equal(detail?.orderNumber, "1001");
    assert.equal(detail?.connectionDisplayName, "Acme Winery");
    assert.equal(detail?.connectionExternalAccountId, "acme-tenant");
    assert.equal(detail?.totalMinor, "5900");
    assert.equal(detail?.attributed, true);
    assert.equal(detail?.lineItems.length, 1);
    assert.equal(detail?.lineItems[0].title, "2015 Chardonnay");
    assert.equal(detail?.lineItems[0].unitPriceMinor, "2500");
    // orderDate prefers providerCreatedAt over createdAt.
    assert.equal(detail?.orderDate, "2026-01-05T00:00:00.000Z");
  });

  test("a foreign/nonexistent order resolves to null — the service's own query already scopes by brandId", async () => {
    const detail = await getBrandCommerceOrderDetail("order-1", "brand-a", { findLatestAppliedEventNote: async () => null,
      findOrder: async () => null,
    });
    assert.equal(detail, null);
  });

  test("null money fields stay null — never coerced to a zero string", async () => {
    const detail = await getBrandCommerceOrderDetail("order-1", "brand-a", { findLatestAppliedEventNote: async () => null,
      findOrder: async () =>
        orderRow({
          subtotalMinor: null,
          shippingMinor: null,
          taxMinor: null,
          totalMinor: null,
          netRevenueMinor: null,
          attributionId: null,
        }),
    });
    assert.equal(detail?.subtotalMinor, null);
    assert.equal(detail?.shippingMinor, null);
    assert.equal(detail?.totalMinor, null);
    assert.equal(detail?.netRevenueMinor, null);
    assert.equal(detail?.attributed, false);
    assert.equal(detail?.totalRefundedMinor, "0", "an explicit zero refund is a real value, not unknown");
  });

  test("a BigInt total beyond safe-integer range survives as a string with no precision loss", async () => {
    const huge = BigInt("9007199254740993");
    const detail = await getBrandCommerceOrderDetail("order-1", "brand-a", { findLatestAppliedEventNote: async () => null,
      findOrder: async () => orderRow({ totalMinor: huge }),
    });
    assert.equal(detail?.totalMinor, huge.toString());
  });

  test("no customer PII field is ever present on the serialized detail", async () => {
    const detail = await getBrandCommerceOrderDetail("order-1", "brand-a", { findLatestAppliedEventNote: async () => null,
      findOrder: async () => orderRow(),
    });
    const serialized = JSON.stringify(detail);
    for (const forbidden of ["email", "address", "phone", "cardNumber", "customerName"]) {
      assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()));
    }
  });

  // PHASE 19 REPAIR (P1-3): the exact persisted exponent, never derived.
  test("minorUnitExponent is passed through exactly, including 0 (JPY) and null (unresolved)", async () => {
    const jpy = await getBrandCommerceOrderDetail("order-1", "brand-a", { findLatestAppliedEventNote: async () => null,
      findOrder: async () => orderRow({ currencyCode: "JPY", minorUnitExponent: 0, totalMinor: BigInt(5000) }),
    });
    assert.equal(jpy?.minorUnitExponent, 0);
    assert.equal(jpy?.totalMinor, "5000");

    const unresolved = await getBrandCommerceOrderDetail("order-1", "brand-a", { findLatestAppliedEventNote: async () => null,
      findOrder: async () => orderRow({ minorUnitExponent: null }),
    });
    assert.equal(unresolved?.minorUnitExponent, null);
  });
});

describe("route: brandCommerceOrderDetailGetImpl", () => {
  test("unauthenticated caller never reaches getOrderDetail()", async () => {
    let called = false;
    const res = await brandCommerceOrderDetailGetImpl(
      {
        getContext: async () => null,
        getOrderDetail: async () => {
          called = true;
          return null;
        },
      },
      "order-1",
    );
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("a missing/foreign order maps to 404", async () => {
    const res = await brandCommerceOrderDetailGetImpl(
      { getContext: async () => makeContext(), getOrderDetail: async () => null },
      "order-1",
    );
    assert.equal(res.status, 404);
  });

  test("a resolved order returns its detail under data, with the caller's own brandId passed through", async () => {
    let capturedBrandId: string | null = null;
    const res = await brandCommerceOrderDetailGetImpl(
      {
        getContext: async () => makeContext(),
        getOrderDetail: async (orderId, brandId) => {
          capturedBrandId = brandId;
          return {
            id: orderId,
            connectionId: "conn-1",
            provider: CommerceProvider.COMMERCE7,
            connectionDisplayName: "Acme Winery",
            connectionExternalAccountId: "acme-tenant",
            orderNumber: "1001",
            orderDate: "2026-01-05T00:00:00.000Z",
            financialStatus: "PAID",
            fulfillmentStatus: "FULFILLED",
            currencyCode: "USD",
            minorUnitExponent: 2,
            subtotalMinor: "5000",
            shippingMinor: "500",
            taxMinor: "400",
            totalMinor: "5900",
            totalRefundedMinor: "0",
            netRevenueMinor: "5900",
            attributed: true,
            createdAt: "2026-01-05T00:05:00.000Z",
            updatedAt: "2026-01-06T00:00:00.000Z",
            providerUpdatedAt: null,
            lineItems: [],
            refundAnomaly: null,
          };
        },
      },
      "order-1",
    );
    assert.equal(res.status, 200);
    assert.equal(capturedBrandId, "brand-a");
    const body = await res.json();
    assert.equal(body.data.id, "order-1");
  });
});

describe("over-refund warning (Commerce7 #1007)", () => {
  const overRefunded = orderRow({ orderNumber: "1007", currencyCode: "CAD", financialStatus: "REFUNDED", totalMinor: BigInt(16272), totalRefundedMinor: BigInt(16272), netRevenueMinor: BigInt(0) });

  test("the latest applied event's OVER_REFUND_EXCESS note becomes a durable warning with the excess and the provider's full figure", async () => {
    const lookups: string[] = [];
    const detail = await getBrandCommerceOrderDetail("order-1", "brand-a", {
      findOrder: async () => overRefunded,
      findLatestAppliedEventNote: async (orderId) => { lookups.push(orderId); return "OVER_REFUND_EXCESS:16272"; },
    });
    assert.deepEqual(lookups, ["order-1"], "keyed by the Brand-scoped order's own id");
    assert.equal(detail?.totalRefundedMinor, "16272"); assert.equal(detail?.netRevenueMinor, "0");
    assert.deepEqual(detail?.refundAnomaly, { excessRefundMinor: "16272", reportedRefundedMinor: "32544" });
  });

  test("ordinary orders, other notes and malformed notes carry no warning; a foreign order is never looked up", async () => {
    for (const note of [null, "WRITE_FAILED", "OVER_REFUND_EXCESS:", "OVER_REFUND_EXCESS:abc", "OVER_REFUND_EXCESS:0", "OVER_REFUND_EXCESS:12 OR 1=1"]) {
      assert.equal(readRefundAnomaly(note, BigInt(100)), null, String(note));
    }
    let looked = false;
    const missing = await getBrandCommerceOrderDetail("order-1", "brand-b", { findOrder: async () => null, findLatestAppliedEventNote: async () => { looked = true; return "OVER_REFUND_EXCESS:1"; } });
    assert.equal(missing, null); assert.equal(looked, false);
  });

  test("the API returns the warning with the order", async () => {
    const res = await brandCommerceOrderDetailGetImpl({
      getContext: async () => makeContext(),
      getOrderDetail: (orderId, brandId) => getBrandCommerceOrderDetail(orderId, brandId, { findOrder: async () => overRefunded, findLatestAppliedEventNote: async () => "OVER_REFUND_EXCESS:16272" }),
    }, "order-1");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.data.refundAnomaly, { excessRefundMinor: "16272", reportedRefundedMinor: "32544" });
  });
});
