/**
 * tests/brand-commerce-order-explorer.test.ts
 *
 * PHASE B — the Order Explorer: filtering, search, date semantics, cursor
 * pagination, money correctness, response validation, and the tenant/PII
 * boundaries the explorer must never cross.
 *
 * Pure helpers are tested directly; the route is driven through its real
 * handler (`brandCommerceOrdersGetImpl`) with an injected `findOrders`, so
 * every filter's translation into a query predicate is a real behavioural
 * assertion rather than a source-text one. No database, no network.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommerceProvider, type Prisma } from "@prisma/client";

import {
  brandCommerceOrdersGetImpl,
  type BrandCommerceOrderListDeps,
} from "../src/app/api/brand/commerce/orders/route";
import {
  buildOrderDateWhere,
  buildOrderListWhere,
  buildOrderNumberWhere,
  MAX_ORDER_NUMBER_SEARCH_LENGTH,
  normalizeConnectionIdFilter,
  normalizeOrderFulfillmentStatusFilter,
  normalizeOrderNumberSearch,
  parseOrderDateRange,
} from "../src/lib/commerce/order-list";
import {
  isOrderListRow,
  parseOrderListEnvelope,
  type OrderListRow,
} from "../src/app/(withSidebar)/dashboard/brand/commerce/commerce-response-validation";
import type { BrandAdminContext } from "../src/lib/brand-auth";

/**
 * Strips comments before a "must NOT contain X" source scan.
 *
 * Without this, these assertions fail on their own documentation — the
 * modules under test legitimately explain *why* they avoid offset
 * pagination, a hardcoded `/100`, or any customer field, and matching that
 * prose would be testing the comment rather than the code.
 */
function executableSource(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

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

type FindOrdersInput = Parameters<BrandCommerceOrderListDeps["findOrders"]>[0];

function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "order-1",
    connectionId: "conn-1",
    provider: CommerceProvider.COMMERCE7,
    orderNumber: "1002",
    providerCreatedAt: new Date("2026-08-20T00:00:00.000Z"),
    createdAt: new Date("2026-08-26T00:00:00.000Z"),
    updatedAt: new Date("2026-08-26T18:11:55.847Z"),
    financialStatus: "PARTIALLY_REFUNDED" as const,
    fulfillmentStatus: "FULFILLED" as const,
    currencyCode: "CAD",
    minorUnitExponent: 2,
    totalMinor: BigInt(9831),
    totalRefundedMinor: BigInt(3277),
    netRevenueMinor: BigInt(6554),
    attributionId: null,
    ...overrides,
  };
}

/** Captures exactly what the route asked the data layer for. */
function capturingDeps(rows: ReturnType<typeof dbRow>[] = [dbRow()]) {
  const captured: { input: FindOrdersInput | null } = { input: null };
  const deps: Partial<BrandCommerceOrderListDeps> = {
    getContext: async () => makeContext(),
    findOrders: async (input) => {
      captured.input = input;
      return rows;
    },
  };
  return { captured, deps };
}

// ---------------------------------------------------------------------------
// Authorization / tenant isolation
// ---------------------------------------------------------------------------

describe("PHASE B — authorization and tenant isolation", () => {
  test("an unauthenticated caller never reaches the data layer", async () => {
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

  test("the brandId used for the query is ALWAYS the authenticated context's own — never client-supplied", async () => {
    const { captured, deps } = capturingDeps();
    // Attempt to smuggle a foreign brand through every string-ish filter.
    await brandCommerceOrdersGetImpl(deps, {
      connectionId: "brand-OTHER",
      orderNumber: "brand-OTHER",
      provider: "brand-OTHER",
    });
    assert.equal(captured.input?.brandId, "brand-a");
  });

  test("a connectionId belonging to another brand is still ANDed with the authenticated brandId, so it matches nothing rather than leaking", async () => {
    const { captured, deps } = capturingDeps([]);
    await brandCommerceOrdersGetImpl(deps, { connectionId: "conn-of-another-brand" });
    assert.equal(captured.input?.brandId, "brand-a");
    assert.equal(captured.input?.connectionId, "conn-of-another-brand");
    // Both constraints are present — the connection filter never replaces
    // the tenant scope.
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("PHASE B — filters", () => {
  test("order number search is passed through as a case-insensitive contains predicate", async () => {
    const { captured, deps } = capturingDeps();
    await brandCommerceOrdersGetImpl(deps, { orderNumber: " 1002 " });
    assert.deepEqual(captured.input?.orderNumberWhere, {
      orderNumber: { contains: "1002", mode: "insensitive" },
    });
  });

  test("an empty/whitespace order number applies NO filter rather than matching nothing", async () => {
    const { captured, deps } = capturingDeps();
    await brandCommerceOrdersGetImpl(deps, { orderNumber: "   " });
    assert.deepEqual(captured.input?.orderNumberWhere, {});
  });

  test("an over-long order number is a 400 with ORDER_NUMBER_TOO_LONG and never reaches the query", async () => {
    let called = false;
    const res = await brandCommerceOrdersGetImpl(
      {
        getContext: async () => makeContext(),
        findOrders: async () => {
          called = true;
          return [];
        },
      },
      { orderNumber: "x".repeat(MAX_ORDER_NUMBER_SEARCH_LENGTH + 1) },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "ORDER_NUMBER_TOO_LONG");
    assert.equal(called, false);
  });

  test("financial status filter is forwarded", async () => {
    const { captured, deps } = capturingDeps();
    await brandCommerceOrdersGetImpl(deps, { financialStatus: "PARTIALLY_REFUNDED" });
    assert.equal(captured.input?.financialStatus, "PARTIALLY_REFUNDED");
  });

  test("fulfillment status filter is forwarded and is INDEPENDENT of financial status", async () => {
    const { captured, deps } = capturingDeps();
    await brandCommerceOrdersGetImpl(deps, { fulfillmentStatus: "FULFILLED", financialStatus: "PAID" });
    assert.equal(captured.input?.fulfillmentStatus, "FULFILLED");
    assert.equal(captured.input?.financialStatus, "PAID");
  });

  test("attribution filter maps to the canonical attributionId predicate in both directions", async () => {
    const attributed = capturingDeps();
    await brandCommerceOrdersGetImpl(attributed.deps, { attributed: "attributed" });
    assert.deepEqual(attributed.captured.input?.attributionWhere, { attributionId: { not: null } });

    const unattributed = capturingDeps();
    await brandCommerceOrdersGetImpl(unattributed.deps, { attributed: "unattributed" });
    assert.deepEqual(unattributed.captured.input?.attributionWhere, { attributionId: null });
  });

  test("an unknown enum value is IGNORED (no filter), never turned into a match-nothing query", async () => {
    const { captured, deps } = capturingDeps();
    await brandCommerceOrdersGetImpl(deps, {
      financialStatus: "NOT_A_REAL_STATUS",
      fulfillmentStatus: "ALSO_NOT_REAL",
      provider: "NOT_A_PROVIDER",
      attributed: "maybe",
    });
    assert.equal(captured.input?.financialStatus, null);
    assert.equal(captured.input?.fulfillmentStatus, null);
    assert.equal(captured.input?.provider, null);
    assert.deepEqual(captured.input?.attributionWhere, {});
  });

  test("filters COMPOSE — every one is forwarded together in a single query", async () => {
    const { captured, deps } = capturingDeps();
    await brandCommerceOrdersGetImpl(deps, {
      provider: "COMMERCE7",
      connectionId: "conn-1",
      orderNumber: "1002",
      financialStatus: "PARTIALLY_REFUNDED",
      fulfillmentStatus: "FULFILLED",
      attributed: "unattributed",
      dateFrom: "2026-08-01T00:00:00.000Z",
      dateTo: "2026-08-31T00:00:00.000Z",
    });
    const input = captured.input;
    assert.equal(input?.provider, "COMMERCE7");
    assert.equal(input?.connectionId, "conn-1");
    assert.equal(input?.financialStatus, "PARTIALLY_REFUNDED");
    assert.equal(input?.fulfillmentStatus, "FULFILLED");
    assert.deepEqual(input?.attributionWhere, { attributionId: null });
    assert.ok(input?.orderNumberWhere.orderNumber);
    assert.ok(input?.dateWhere.OR);
  });
});

// ---------------------------------------------------------------------------
// Date semantics
// ---------------------------------------------------------------------------

describe("PHASE B — date semantics", () => {
  test("a malformed date is a 400 (INVALID_DATE) and never reaches the query", async () => {
    let called = false;
    const res = await brandCommerceOrdersGetImpl(
      {
        getContext: async () => makeContext(),
        findOrders: async () => {
          called = true;
          return [];
        },
      },
      { dateFrom: "not-a-date" },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "INVALID_DATE");
    assert.equal(called, false);
  });

  test("an inverted range is a 400 (INVERTED_RANGE) — never silently swapped", async () => {
    const res = await brandCommerceOrdersGetImpl(
      { getContext: async () => makeContext(), findOrders: async () => [] },
      { dateFrom: "2026-08-31T00:00:00.000Z", dateTo: "2026-08-01T00:00:00.000Z" },
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "INVERTED_RANGE");
  });

  test("parseOrderDateRange accepts either bound alone, and both absent", () => {
    assert.deepEqual(parseOrderDateRange(null, null), { ok: true, from: null, to: null });
    const fromOnly = parseOrderDateRange("2026-08-01T00:00:00.000Z", null);
    assert.equal(fromOnly.ok, true);
    if (fromOnly.ok) assert.equal(fromOnly.to, null);
    const toOnly = parseOrderDateRange(null, "2026-08-01T00:00:00.000Z");
    assert.equal(toOnly.ok, true);
    if (toOnly.ok) assert.equal(toOnly.from, null);
  });

  test("an equal from/to is valid (a single instant), not treated as inverted", () => {
    const result = parseOrderDateRange("2026-08-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z");
    assert.equal(result.ok, true);
  });

  test("the date filter targets the BUSINESS order date, matching what the UI displays — provider date, falling back to ingestion date", () => {
    const from = new Date("2026-08-01T00:00:00.000Z");
    const to = new Date("2026-08-31T00:00:00.000Z");
    const where = buildOrderDateWhere(from, to);
    assert.ok(Array.isArray(where.OR));
    // Branch 1: rows that HAVE a provider timestamp are compared on it.
    assert.deepEqual(where.OR?.[0], { providerCreatedAt: { gte: from, lte: to } });
    // Branch 2: rows WITHOUT one fall back to createdAt — never dropped.
    assert.deepEqual(where.OR?.[1], {
      AND: [{ providerCreatedAt: null }, { createdAt: { gte: from, lte: to } }],
    });
  });

  test("no date bounds produce NO predicate at all", () => {
    assert.deepEqual(buildOrderDateWhere(null, null), {});
  });

  test("bounds are inclusive (gte/lte), never exclusive", () => {
    const where = buildOrderDateWhere(new Date("2026-08-01"), new Date("2026-08-31"));
    const first = where.OR?.[0] as { providerCreatedAt: Prisma.DateTimeFilter };
    assert.ok("gte" in first.providerCreatedAt);
    assert.ok("lte" in first.providerCreatedAt);
  });
});

// ---------------------------------------------------------------------------
// Cursor pagination
// ---------------------------------------------------------------------------

describe("PHASE B — cursor pagination", () => {
  test("a full page yields hasNextPage + a nextCursor; a short page yields neither", async () => {
    const many = Array.from({ length: 26 }, (_, i) =>
      dbRow({ id: `order-${i}`, createdAt: new Date(2026, 7, 26, 0, 0, i) }),
    );
    const full = await brandCommerceOrdersGetImpl(
      { getContext: async () => makeContext(), findOrders: async () => many },
      { limit: "25" },
    );
    const fullBody = await full.json();
    assert.equal(fullBody.data.length, 25, "the +1 look-ahead row must never be returned to the client");
    assert.equal(fullBody.meta.hasNextPage, true);
    assert.ok(typeof fullBody.meta.nextCursor === "string" && fullBody.meta.nextCursor.length > 0);

    const short = await brandCommerceOrdersGetImpl(
      { getContext: async () => makeContext(), findOrders: async () => [dbRow()] },
      { limit: "25" },
    );
    const shortBody = await short.json();
    assert.equal(shortBody.meta.hasNextPage, false);
    assert.equal(shortBody.meta.nextCursor, null);
  });

  test("the query asks for limit + 1 rows so hasNextPage can be determined without a COUNT", async () => {
    const { captured, deps } = capturingDeps();
    await brandCommerceOrdersGetImpl(deps, { limit: "10" });
    assert.equal(captured.input?.limit, 10);
  });

  test("a cursor is forwarded as a keyset predicate, and filters compose WITH it", async () => {
    const { captured, deps } = capturingDeps();
    const cursor = Buffer.from(
      JSON.stringify({ createdAt: "2026-08-26T00:00:00.000Z", id: "order-1" }),
      "utf8",
    ).toString("base64url");
    await brandCommerceOrdersGetImpl(deps, { cursor, financialStatus: "PAID" });
    assert.ok(captured.input?.cursorWhere, "cursor must reach the query");
    assert.ok(Array.isArray(captured.input?.cursorWhere?.OR), "keyset predicate, not an offset");
    assert.equal(captured.input?.financialStatus, "PAID", "filters must compose with the cursor");
  });

  test("a malformed cursor is ignored (page 1) rather than crashing or returning a wrong page", async () => {
    const { captured, deps } = capturingDeps();
    await brandCommerceOrdersGetImpl(deps, { cursor: "!!!not-base64!!!" });
    assert.equal(captured.input?.cursorWhere, null);
  });

  test("pagination is SEEK-based — the route never uses skip/offset", () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/api/brand/commerce/orders/route.ts"),
      "utf8",
    );
    assert.doesNotMatch(source, /\bskip:/);
    assert.doesNotMatch(source, /\boffset\b/i);
  });
});

// ---------------------------------------------------------------------------
// Money / BigInt
// ---------------------------------------------------------------------------

describe("PHASE B — money and BigInt serialization", () => {
  test("BigInt money is serialized as a decimal STRING, never a JS number", async () => {
    const res = await brandCommerceOrdersGetImpl(
      { getContext: async () => makeContext(), findOrders: async () => [dbRow()] },
      {},
    );
    const body = await res.json();
    const row = body.data[0];
    assert.equal(typeof row.totalMinor, "string");
    assert.equal(row.totalMinor, "9831");
    assert.equal(row.totalRefundedMinor, "3277");
    assert.equal(row.netRevenueMinor, "6554");
  });

  test("a value beyond Number.MAX_SAFE_INTEGER survives serialization exactly", async () => {
    const huge = BigInt("9007199254740993"); // 2^53 + 1
    const res = await brandCommerceOrdersGetImpl(
      { getContext: async () => makeContext(), findOrders: async () => [dbRow({ totalMinor: huge })] },
      {},
    );
    const body = await res.json();
    assert.equal(body.data[0].totalMinor, "9007199254740993");
  });

  test("unknown money stays null — never coerced to 0", async () => {
    const res = await brandCommerceOrdersGetImpl(
      {
        getContext: async () => makeContext(),
        findOrders: async () => [
          dbRow({ totalMinor: null, netRevenueMinor: null, currencyCode: null, minorUnitExponent: null }),
        ],
      },
      {},
    );
    const body = await res.json();
    assert.equal(body.data[0].totalMinor, null);
    assert.equal(body.data[0].netRevenueMinor, null);
    assert.equal(body.data[0].currencyCode, null);
    assert.equal(body.data[0].minorUnitExponent, null);
  });

  test("the persisted exponent is returned verbatim for exponent 0 / 2 / 3 currencies", async () => {
    for (const [currencyCode, exponent] of [["JPY", 0], ["CAD", 2], ["KWD", 3]] as const) {
      const res = await brandCommerceOrdersGetImpl(
        {
          getContext: async () => makeContext(),
          findOrders: async () => [dbRow({ currencyCode, minorUnitExponent: exponent })],
        },
        {},
      );
      const body = await res.json();
      assert.equal(body.data[0].minorUnitExponent, exponent, currencyCode);
      assert.equal(body.data[0].currencyCode, currencyCode);
    }
  });

  test("the order date shown prefers the PROVIDER timestamp, falling back to ingestion time", async () => {
    const withProvider = await brandCommerceOrdersGetImpl(
      { getContext: async () => makeContext(), findOrders: async () => [dbRow()] },
      {},
    );
    assert.equal((await withProvider.json()).data[0].orderDate, "2026-08-20T00:00:00.000Z");

    const withoutProvider = await brandCommerceOrdersGetImpl(
      {
        getContext: async () => makeContext(),
        findOrders: async () => [dbRow({ providerCreatedAt: null })],
      },
      {},
    );
    assert.equal((await withoutProvider.json()).data[0].orderDate, "2026-08-26T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// Commerce7 partial refund + Shopify parity
// ---------------------------------------------------------------------------

describe("PHASE B — provider parity and the Commerce7 partial-refund case", () => {
  test("the Commerce7 #1002 partial refund exposes gross / refunded / net independently", async () => {
    const res = await brandCommerceOrdersGetImpl(
      { getContext: async () => makeContext(), findOrders: async () => [dbRow()] },
      {},
    );
    const row = (await res.json()).data[0];
    assert.equal(row.financialStatus, "PARTIALLY_REFUNDED");
    assert.equal(row.fulfillmentStatus, "FULFILLED");
    assert.equal(row.totalMinor, "9831");
    assert.equal(row.totalRefundedMinor, "3277");
    assert.equal(row.netRevenueMinor, "6554");
    assert.equal(row.currencyCode, "CAD");
  });

  test("a Shopify row goes through the IDENTICAL provider-neutral shape — no provider branch in the response", async () => {
    const res = await brandCommerceOrdersGetImpl(
      {
        getContext: async () => makeContext(),
        findOrders: async () => [
          dbRow({
            provider: CommerceProvider.SHOPIFY,
            currencyCode: "USD",
            orderNumber: "#1001",
            financialStatus: "REFUNDED",
            totalMinor: BigInt(2000),
            totalRefundedMinor: BigInt(2000),
            netRevenueMinor: BigInt(0),
          }),
        ],
      },
      {},
    );
    const row = (await res.json()).data[0];
    assert.equal(row.provider, "SHOPIFY");
    assert.equal(row.financialStatus, "REFUNDED");
    assert.equal(row.netRevenueMinor, "0");
    // Same key set as the Commerce7 row above.
    assert.deepEqual(
      Object.keys(row).sort(),
      [
        "attributed", "connectionId", "currencyCode", "financialStatus", "fulfillmentStatus",
        "id", "minorUnitExponent", "netRevenueMinor", "orderDate", "orderNumber", "provider",
        "totalMinor", "totalRefundedMinor", "updatedAt",
      ].sort(),
    );
  });

  test("no customer PII field is ever present in a list row", async () => {
    const res = await brandCommerceOrdersGetImpl(
      { getContext: async () => makeContext(), findOrders: async () => [dbRow()] },
      {},
    );
    const serialized = JSON.stringify(await res.json()).toLowerCase();
    for (const forbidden of ["email", "phone", "address", "customer", "cardnumber", "billing", "shipping"]) {
      assert.ok(!serialized.includes(forbidden), `list response must not contain "${forbidden}"`);
    }
  });

  test("the route exposes no free-text search other than order number — there is no customer lookup", () => {
    const source = executableSource(
      readFileSync(join(process.cwd(), "src/app/api/brand/commerce/orders/route.ts"), "utf8"),
    );
    for (const forbidden of [/customerName/i, /\bemail\b/i, /\bphone\b/i, /\baddress\b/i]) {
      assert.doesNotMatch(source, forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("PHASE B — pure filter helpers", () => {
  test("normalizeOrderFulfillmentStatusFilter accepts only canonical enum values", () => {
    for (const value of ["UNFULFILLED", "PARTIALLY_FULFILLED", "FULFILLED", "RESTOCKED"]) {
      assert.equal(normalizeOrderFulfillmentStatusFilter(value), value);
    }
    assert.equal(normalizeOrderFulfillmentStatusFilter("SHIPPED"), null);
    assert.equal(normalizeOrderFulfillmentStatusFilter(null), null);
    assert.equal(normalizeOrderFulfillmentStatusFilter(""), null);
  });

  test("normalizeOrderNumberSearch trims, treats blank as absent, and bounds length", () => {
    assert.deepEqual(normalizeOrderNumberSearch(null), { ok: true, value: null });
    assert.deepEqual(normalizeOrderNumberSearch("  "), { ok: true, value: null });
    assert.deepEqual(normalizeOrderNumberSearch(" 1002 "), { ok: true, value: "1002" });
    assert.equal(normalizeOrderNumberSearch("x".repeat(MAX_ORDER_NUMBER_SEARCH_LENGTH)).ok, true);
    assert.deepEqual(normalizeOrderNumberSearch("x".repeat(MAX_ORDER_NUMBER_SEARCH_LENGTH + 1)), {
      ok: false,
      code: "ORDER_NUMBER_TOO_LONG",
    });
  });

  test("buildOrderNumberWhere produces no predicate for an absent search", () => {
    assert.deepEqual(buildOrderNumberWhere(null), {});
  });

  test("normalizeConnectionIdFilter rejects blank/over-long input without throwing", () => {
    assert.equal(normalizeConnectionIdFilter(null), null);
    assert.equal(normalizeConnectionIdFilter("  "), null);
    assert.equal(normalizeConnectionIdFilter("x".repeat(65)), null);
    assert.equal(normalizeConnectionIdFilter(" conn-1 "), "conn-1");
  });
});

// ---------------------------------------------------------------------------
// Runtime response validation (B7)
// ---------------------------------------------------------------------------

function validRow(overrides: Partial<OrderListRow> = {}): OrderListRow {
  return {
    id: "order-1",
    connectionId: "conn-1",
    provider: "COMMERCE7",
    orderNumber: "1002",
    orderDate: "2026-08-20T00:00:00.000Z",
    financialStatus: "PARTIALLY_REFUNDED",
    fulfillmentStatus: "FULFILLED",
    currencyCode: "CAD",
    minorUnitExponent: 2,
    totalMinor: "9831",
    totalRefundedMinor: "3277",
    netRevenueMinor: "6554",
    attributed: false,
    updatedAt: "2026-08-26T18:11:55.847Z",
    ...overrides,
  };
}

describe("PHASE B — runtime response validation", () => {
  test("a valid envelope parses", () => {
    const parsed = parseOrderListEnvelope({
      data: [validRow()],
      meta: { hasNextPage: false, nextCursor: null },
    });
    assert.ok(parsed);
    assert.equal(parsed?.data.length, 1);
  });

  test("a malformed MONEY field (float, not an integer string) is rejected — never rendered as NaN", () => {
    assert.equal(isOrderListRow(validRow({ totalMinor: "98.31" as unknown as string })), false);
    assert.equal(isOrderListRow({ ...validRow(), totalMinor: 9831 }), false);
  });

  test("an unknown enum value is rejected rather than rendered as a broken badge", () => {
    assert.equal(isOrderListRow({ ...validRow(), financialStatus: "SOMETHING_NEW" }), false);
    assert.equal(isOrderListRow({ ...validRow(), fulfillmentStatus: "SHIPPED" }), false);
    assert.equal(isOrderListRow({ ...validRow(), provider: "WOOCOMMERCE" }), false);
  });

  test("a malformed timestamp is rejected", () => {
    assert.equal(isOrderListRow({ ...validRow(), orderDate: "not-a-date" }), false);
    assert.equal(isOrderListRow({ ...validRow(), updatedAt: "" }), false);
  });

  test("an out-of-range or non-integer exponent is rejected — it is load-bearing for money rendering", () => {
    assert.equal(isOrderListRow({ ...validRow(), minorUnitExponent: 2.5 }), false);
    assert.equal(isOrderListRow({ ...validRow(), minorUnitExponent: -1 }), false);
    assert.equal(isOrderListRow({ ...validRow(), minorUnitExponent: 99 }), false);
    assert.equal(isOrderListRow(validRow({ minorUnitExponent: 0 })), true);
    assert.equal(isOrderListRow(validRow({ minorUnitExponent: 3 })), true);
  });

  test("legitimate nulls are accepted (unknown is a valid state, unlike malformed)", () => {
    assert.equal(
      isOrderListRow(
        validRow({
          orderNumber: null,
          financialStatus: null,
          fulfillmentStatus: null,
          currencyCode: null,
          minorUnitExponent: null,
          totalMinor: null,
          totalRefundedMinor: null,
          netRevenueMinor: null,
        }),
      ),
      true,
    );
  });

  test("ONE malformed row rejects the WHOLE envelope — a partially-rendered list would silently hide orders", () => {
    const parsed = parseOrderListEnvelope({
      data: [validRow(), { ...validRow({ id: "order-2" }), totalMinor: "abc" }],
      meta: { hasNextPage: false, nextCursor: null },
    });
    assert.equal(parsed, null);
  });

  test("a missing/malformed meta is rejected rather than crashing on undefined", () => {
    assert.equal(parseOrderListEnvelope({ data: [] }), null);
    assert.equal(parseOrderListEnvelope({ data: [], meta: {} }), null);
    assert.equal(parseOrderListEnvelope(null), null);
    assert.equal(parseOrderListEnvelope("nope"), null);
    assert.equal(parseOrderListEnvelope({ data: "not-an-array", meta: { hasNextPage: false } }), null);
  });

  test("an empty-string cursor is normalized to null, never sent back as a filter value", () => {
    const parsed = parseOrderListEnvelope({
      data: [],
      meta: { hasNextPage: false, nextCursor: "" },
    });
    assert.equal(parsed?.meta.nextCursor, null);
  });
});

// ---------------------------------------------------------------------------
// Client wiring (source assertions — no React testing library in this repo)
// ---------------------------------------------------------------------------

describe("PHASE B — order explorer client wiring", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "src/app/(withSidebar)/dashboard/brand/commerce/orders/BrandCommerceOrdersClient.tsx",
    ),
    "utf8",
  );
  const executable = executableSource(source);

  test("changing a filter RESETS pagination — the cursor stack is cleared when applied filters change", () => {
    assert.match(source, /useEffect\(\(\) => \{\s*\n\s*setCursorStack\(\[\]\);\s*\n\s*setCurrentCursor\(null\);/);
    assert.match(source, /\}, \[applied, refreshToken, load\]\);/);
  });

  test("Previous is a cursor-stack pop, never a reverse-offset query", () => {
    assert.match(source, /const previousCursor = stack\.pop\(\) \?\? null;/);
    // Precise: look for OFFSET PAGINATION, not the substring "offset"
    // (which also appears in the Tailwind class `underline-offset-2`).
    assert.doesNotMatch(executable, /\bskip[:=]/);
    assert.doesNotMatch(executable, /[?&]offset=/);
    assert.doesNotMatch(executable, /\boffsetPagination\b/i);
  });

  test("a stale-response guard exists on the list request", () => {
    assert.match(source, /const requestSeq = useRef\(0\)/);
    assert.match(source, /seq !== requestSeq\.current/);
  });

  test("money is always rendered through formatMoneyDisplay with the row's OWN exponent — never a hardcoded /100", () => {
    assert.match(source, /formatMoneyDisplay\(row\.totalMinor, row\.currencyCode, row\.minorUnitExponent\)/);
    assert.doesNotMatch(executable, /\/\s*100\b/);
    assert.doesNotMatch(executable, /\*\s*100\b/);
  });

  test("rows are real anchors, so keyboard focus and Enter work without custom key handling", () => {
    const rowStart = source.indexOf("function OrderExplorerRow(");
    const rowBody = source.slice(rowStart, rowStart + 2200);
    assert.match(rowBody, /<a\s/);
    assert.match(rowBody, /href=\{`\/dashboard\/brand\/commerce\/orders\/\$\{row\.id\}`\}/);
    assert.match(rowBody, /focus-visible:ring/);
  });

  test("datetime-local values are converted via toISOString, never by appending a literal Z", () => {
    assert.match(source, /new Date\(filters\.dateFrom\)\.toISOString\(\)/);
    assert.match(source, /new Date\(filters\.dateTo\)\.toISOString\(\)/);
    assert.doesNotMatch(source, /dateFrom\}Z|\$\{filters\.dateFrom\}Z/);
  });

  test("the explorer links to the EXISTING detail page — no second detail architecture", () => {
    assert.match(source, /\/dashboard\/brand\/commerce\/orders\/\$\{row\.id\}/);
  });

  test("no customer search control exists anywhere in the explorer", () => {
    for (const forbidden of [/customerName/i, /Search customer/i, /\bemail\b/i, /\bphone\b/i]) {
      assert.doesNotMatch(executable, forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// ADVERSARIAL REVIEW ROUND 1 — the two findings this round fixed.
// ---------------------------------------------------------------------------

describe("PHASE B — where-clause composition (previously untested, highest-risk)", () => {
  const base = {
    brandId: "brand-a",
    provider: null,
    financialStatus: null,
    fulfillmentStatus: null,
    connectionId: null,
    attributionWhere: {},
    orderNumberWhere: {},
    dateWhere: {},
    cursorWhere: null,
  } as const;

  test("brandId is ALWAYS present, even with no filters at all", () => {
    assert.equal(buildOrderListWhere({ ...base }).brandId, "brand-a");
  });

  test("THE COLLISION CASE: a date range AND a cursor both emit a top-level OR — both must survive", () => {
    const dateWhere = buildOrderDateWhere(new Date("2026-08-01"), new Date("2026-08-31"));
    const cursorWhere = { OR: [{ createdAt: { lt: new Date("2026-08-26") } }] };
    const where = buildOrderListWhere({ ...base, dateWhere, cursorWhere });

    // If these had been object-spread, the second OR would have clobbered the
    // first — dropping the date filter or breaking keyset pagination.
    assert.ok(Array.isArray(where.AND));
    assert.ok(
      (where.AND as unknown[]).some((p) => JSON.stringify(p) === JSON.stringify(dateWhere)),
      "the date predicate must survive",
    );
    assert.ok(
      (where.AND as unknown[]).some((p) => JSON.stringify(p) === JSON.stringify(cursorWhere)),
      "the cursor predicate must survive",
    );
    assert.equal(where.OR, undefined, "no top-level OR may leak out and shadow another");
  });

  test("every scalar filter lands as its own top-level equality when present, and is absent when not", () => {
    const withAll = buildOrderListWhere({
      ...base,
      provider: "COMMERCE7",
      financialStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      connectionId: "conn-1",
    });
    assert.equal(withAll.provider, "COMMERCE7");
    assert.equal(withAll.financialStatus, "PAID");
    assert.equal(withAll.fulfillmentStatus, "FULFILLED");
    assert.equal(withAll.connectionId, "conn-1");

    const withNone = buildOrderListWhere({ ...base });
    assert.ok(!("provider" in withNone));
    assert.ok(!("financialStatus" in withNone));
    assert.ok(!("fulfillmentStatus" in withNone));
    assert.ok(!("connectionId" in withNone));
  });

  test("a null cursor contributes no predicate", () => {
    const where = buildOrderListWhere({ ...base, cursorWhere: null });
    assert.equal((where.AND as unknown[]).length, 3);
  });

  test("attribution + order number + date all compose together with the cursor", () => {
    const where = buildOrderListWhere({
      ...base,
      attributionWhere: { attributionId: null },
      orderNumberWhere: { orderNumber: { contains: "1002", mode: "insensitive" } },
      dateWhere: buildOrderDateWhere(new Date("2026-08-01"), null),
      cursorWhere: { OR: [{ createdAt: { lt: new Date("2026-08-26") } }] },
    });
    assert.equal((where.AND as unknown[]).length, 4);
  });
});

describe("PHASE B — deep-linked filters are seeded from the URL", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "src/app/(withSidebar)/dashboard/brand/commerce/orders/BrandCommerceOrdersClient.tsx",
    ),
    "utf8",
  );
  const analytics = readFileSync(
    join(process.cwd(), "src/app/(withSidebar)/dashboard/brand/analytics/page.tsx"),
    "utf8",
  );

  test("the explorer reads seedable filters from the URL on mount", () => {
    assert.match(source, /function readFiltersFromUrl\(search: string\)/);
    assert.match(source, /readFiltersFromUrl\(window\.location\.search\)/);
  });

  test("URL seeding happens in an EFFECT, never during render (no SSR crash / hydration mismatch)", () => {
    const fnStart = source.indexOf("readFiltersFromUrl(window.location.search)");
    const before = source.slice(Math.max(0, fnStart - 400), fnStart);
    assert.match(before, /useEffect\(\(\) => \{/);
    assert.match(before, /typeof window === "undefined"/);
  });

  test("only values the toolbar itself could produce are accepted from the URL", () => {
    assert.match(source, /URL_SEEDABLE_ATTRIBUTION\.has\(attributed\)/);
    assert.match(source, /FINANCIAL_STATUS_OPTIONS\.some\(\(o\) => o\.value === financialStatus\)/);
    assert.match(source, /FULFILLMENT_STATUS_OPTIONS\.some\(\(o\) => o\.value === fulfillmentStatus\)/);
    assert.match(source, /orderNumber\.trim\(\)\.length <= MAX_ORDER_NUMBER_SEARCH_LENGTH/);
  });

  test("the search bound is IMPORTED from the server module, never re-typed as a literal", () => {
    // ADVERSARIAL REVIEW ROUND 2. The client previously hardcoded `64` in the
    // `maxLength` control AND in the URL seeder while the server owned
    // `MAX_ORDER_NUMBER_SEARCH_LENGTH`. Raising the server bound would have
    // left the input silently stricter; lowering it would have let the input
    // accept text the API answers with a 400. One constant, one source.
    assert.match(source, /import \{ MAX_ORDER_NUMBER_SEARCH_LENGTH \} from "@\/lib\/commerce\/order-list"/);
    assert.match(source, /maxLength=\{MAX_ORDER_NUMBER_SEARCH_LENGTH\}/);
    assert.doesNotMatch(executableSource(source), /maxLength=\{64\}|length <= 64/);
  });

  test("importing order-list into the client bundle stays safe (type-only imports there)", () => {
    // The import above is only legitimate because `order-list.ts` pulls in no
    // Prisma/server runtime. If that ever changes, this must be revisited
    // rather than shipping the server client into the browser bundle.
    const orderList = readFileSync(join(process.cwd(), "src/lib/commerce/order-list.ts"), "utf8");
    const imports = orderList.match(/^import .*/gm) ?? [];
    assert.ok(imports.length > 0, "expected order-list.ts to have at least one import");
    for (const line of imports) {
      assert.match(line, /^import type /, `non-type import would reach the client bundle: ${line}`);
    }
  });

  test("pagination controls are disabled while a page is in flight (double-click cannot desync the cursor stack)", () => {
    assert.match(source, /disabled=\{!canGoPrevious \|\| loading\}/);
    assert.match(source, /disabled=\{!hasNextPage \|\| loading\}/);
  });

  test("the Analytics deep link uses the SAME parameter name the API and toolbar use", () => {
    assert.match(analytics, /\/dashboard\/brand\/commerce\/orders\?attributed=attributed/);
    // The earlier, inert name must not come back.
    assert.doesNotMatch(analytics, /orders\?attribution=/);
  });
});
