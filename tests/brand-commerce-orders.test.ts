/**
 * PHASE 18 — PART 7: Brand order list. Battery items 30-33 (+ filters).
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import { brandCommerceOrdersGetImpl } from "../src/app/api/brand/commerce/orders/route";
import { encodeCommerceOrderCursor } from "../src/lib/commerce/order-list";
import type { BrandAdminContext } from "../src/lib/brand-auth";

function makeContext(brandId = "brand-a"): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired: false,
    brands: [{ id: brandId, name: "Acme", slug: "acme", membershipRole: "ADMIN" }],
    membership: {
      id: "member-1",
      role: "ADMIN",
      brand: { id: brandId, name: "Acme", slug: "acme", bio: null, websiteUrl: null, logoUrl: null, coverImageUrl: null },
    },
  };
}

function orderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    connectionId: "conn-1",
    provider: CommerceProvider.COMMERCE7,
    orderNumber: "1001",
    providerCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
    createdAt: new Date("2026-01-01T00:05:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    financialStatus: "PAID" as const,
    fulfillmentStatus: "FULFILLED" as const,
    currencyCode: "USD",
    minorUnitExponent: 2,
    totalMinor: BigInt(5900),
    totalRefundedMinor: BigInt(0),
    netRevenueMinor: BigInt(5900),
    attributionId: "attr-1",
    ...overrides,
  };
}

describe("30-33. brandCommerceOrdersGetImpl", () => {
  test("30. returns the authenticated brand's own orders", async () => {
    let capturedBrandId: string | null = null;
    const res = await brandCommerceOrdersGetImpl({
      getContext: async () => makeContext("brand-a"),
      findOrders: async (input) => {
        capturedBrandId = input.brandId;
        return [orderRow()];
      },
    });
    assert.equal(res.status, 200);
    assert.equal(capturedBrandId, "brand-a");
    const body = await res.json();
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].orderNumber, "1001");
    assert.equal(body.data[0].attributed, true);
  });

  test("31. an unauthenticated caller never reaches findOrders() — foreign/cross-brand access is structurally impossible", async () => {
    let called = false;
    const res = await brandCommerceOrdersGetImpl({
      getContext: async () => null,
      findOrders: async () => {
        called = true;
        return [];
      },
    });
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("32. pagination: hasNextPage true when more rows exist than the limit, nextCursor derived from the last row", async () => {
    const res = await brandCommerceOrdersGetImpl(
      {
        getContext: async () => makeContext(),
        findOrders: async () => [
          orderRow({ id: "o1", createdAt: new Date("2026-01-03T00:00:00.000Z") }),
          orderRow({ id: "o2", createdAt: new Date("2026-01-02T00:00:00.000Z") }),
          orderRow({ id: "o3", createdAt: new Date("2026-01-01T00:00:00.000Z") }),
        ],
      },
      { provider: null, financialStatus: null, attributed: null, cursor: null, limit: "2" },
    );
    const body = await res.json();
    assert.equal(body.data.length, 2);
    assert.equal(body.meta.hasNextPage, true);
    assert.equal(body.meta.nextCursor, encodeCommerceOrderCursor({ createdAt: "2026-01-02T00:00:00.000Z", id: "o2" }));
  });

  test("32b. hasNextPage false and nextCursor null when exactly the limit's worth of rows exist", async () => {
    const res = await brandCommerceOrdersGetImpl(
      {
        getContext: async () => makeContext(),
        findOrders: async () => [orderRow({ id: "o1" })],
      },
      { provider: null, financialStatus: null, attributed: null, cursor: null, limit: "5" },
    );
    const body = await res.json();
    assert.equal(body.meta.hasNextPage, false);
    assert.equal(body.meta.nextCursor, null);
  });

  test("33. unknown/null money fields are returned as null, NEVER coerced to zero", async () => {
    const res = await brandCommerceOrdersGetImpl({
      getContext: async () => makeContext(),
      findOrders: async () => [
        orderRow({
          totalMinor: null,
          netRevenueMinor: null,
          currencyCode: null,
          financialStatus: null,
          fulfillmentStatus: null,
        }),
      ],
    });
    const body = await res.json();
    assert.equal(body.data[0].totalMinor, null);
    assert.equal(body.data[0].netRevenueMinor, null);
    assert.equal(body.data[0].currencyCode, null);
    assert.equal(body.data[0].financialStatus, null);
    assert.equal(body.data[0].fulfillmentStatus, null);
    assert.notEqual(body.data[0].totalMinor, 0);
    assert.notEqual(body.data[0].totalMinor, "0");
  });

  test("BigInt money fields serialize as decimal strings, never truncated numbers", async () => {
    const res = await brandCommerceOrdersGetImpl({
      getContext: async () => makeContext(),
      findOrders: async () => [orderRow({ totalMinor: BigInt("9007199254740993") })],
    });
    const body = await res.json();
    assert.equal(body.data[0].totalMinor, "9007199254740993");
  });

  test("orderDate prefers providerCreatedAt, falls back to createdAt only when unknown", async () => {
    const withProviderDate = await brandCommerceOrdersGetImpl({
      getContext: async () => makeContext(),
      findOrders: async () => [
        orderRow({
          providerCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-05T00:00:00.000Z"),
        }),
      ],
    });
    const bodyA = await withProviderDate.json();
    assert.equal(bodyA.data[0].orderDate, "2026-01-01T00:00:00.000Z");

    const withoutProviderDate = await brandCommerceOrdersGetImpl({
      getContext: async () => makeContext(),
      findOrders: async () => [
        orderRow({ providerCreatedAt: null, createdAt: new Date("2026-01-05T00:00:00.000Z") }),
      ],
    });
    const bodyB = await withoutProviderDate.json();
    assert.equal(bodyB.data[0].orderDate, "2026-01-05T00:00:00.000Z");
  });

  test("provider filter is applied only for a real CommerceProvider value", async () => {
    let capturedProvider: unknown = "unset";
    await brandCommerceOrdersGetImpl(
      {
        getContext: async () => makeContext(),
        findOrders: async (input) => {
          capturedProvider = input.provider;
          return [];
        },
      },
      { provider: "COMMERCE7", financialStatus: null, attributed: null, cursor: null, limit: null },
    );
    assert.equal(capturedProvider, "COMMERCE7");

    await brandCommerceOrdersGetImpl(
      {
        getContext: async () => makeContext(),
        findOrders: async (input) => {
          capturedProvider = input.provider;
          return [];
        },
      },
      { provider: "NotAProvider", financialStatus: null, attributed: null, cursor: null, limit: null },
    );
    assert.equal(capturedProvider, null, "an invalid provider value must never be passed through as a filter");
  });

  test("attributed/unattributed filter maps to the correct attributionId predicate", async () => {
    let capturedWhere: unknown = null;
    await brandCommerceOrdersGetImpl(
      {
        getContext: async () => makeContext(),
        findOrders: async (input) => {
          capturedWhere = input.attributionWhere;
          return [];
        },
      },
      { provider: null, financialStatus: null, attributed: "unattributed", cursor: null, limit: null },
    );
    assert.deepEqual(capturedWhere, { attributionId: null });
  });

  // PHASE 19 REPAIR (P1-3): the list DTO must expose the persisted exponent
  // so the UI never has to guess/derive one from currencyCode.
  test("minorUnitExponent is passed through from the canonical row, for both 2-decimal and 0-decimal currencies", async () => {
    const res = await brandCommerceOrdersGetImpl({
      getContext: async () => makeContext("brand-a"),
      findOrders: async () => [
        orderRow({ id: "order-usd", currencyCode: "USD", minorUnitExponent: 2 }),
        orderRow({ id: "order-jpy", currencyCode: "JPY", minorUnitExponent: 0, totalMinor: BigInt(5000) }),
      ],
    });
    const body = await res.json();
    assert.equal(body.data[0].minorUnitExponent, 2);
    assert.equal(body.data[1].minorUnitExponent, 0);
    assert.equal(body.data[1].totalMinor, "5000", "JPY total is the raw integer minor value, never divided");
  });

  test("a null minorUnitExponent is passed through as null, never defaulted to 2", async () => {
    const res = await brandCommerceOrdersGetImpl({
      getContext: async () => makeContext("brand-a"),
      findOrders: async () => [orderRow({ minorUnitExponent: null })],
    });
    const body = await res.json();
    assert.equal(body.data[0].minorUnitExponent, null);
  });
});
