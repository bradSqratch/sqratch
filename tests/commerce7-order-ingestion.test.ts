/**
 * PHASE 16 BIG ROUND / SUBPHASE 4 — Commerce7 order ingestion foundation.
 * Battery items 37-60: order API client (37-40), pure normalizer (41-50),
 * order webhook route (51-58), and the bounded backfill entrypoint (59-60).
 */
import "./env-setup";

process.env.COMMERCE7_APP_ID = "test-app-id";
process.env.COMMERCE7_APP_SECRET = "test-app-secret";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import {
  fetchCommerce7Order,
  fetchCommerce7OrdersByDateRange,
  COMMERCE7_BACKFILL_MAX_RESULTS,
  type Commerce7Fetch,
} from "../src/lib/commerce/providers/commerce7-orders";
import { normalizeCommerce7Order } from "../src/lib/commerce/providers/commerce7-order-normalizer";
import { CommerceProviderApiError } from "../src/lib/commerce/errors";
import {
  handleCommerce7OrderWebhook,
  computeCommerce7PayloadDigest,
  resolveCommerce7ProviderEventId,
  type Commerce7OrderWebhookConnection,
} from "../src/lib/commerce/providers/commerce7-order-webhook";
import {
  backfillCommerce7Orders,
  type Commerce7BackfillConnectionRow,
} from "../src/lib/commerce/providers/commerce7-order-backfill";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "../src/lib/commerce/errors";
import type { OrderIngestionOutcome } from "../src/lib/commerce/order-ingestion";

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<Commerce7Fetch>> {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// ---------------------------------------------------------------------------
// 37-40. Commerce7 order API client
// ---------------------------------------------------------------------------

describe("37-40. commerce7-orders.ts API client", () => {
  test("37. fetchCommerce7Order sends Basic Auth + tenant header and returns raw JSON", async () => {
    let capturedHeaders: Record<string, string> | null = null;
    let capturedUrl = "";
    const fetchImpl: Commerce7Fetch = async (url, init) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      return jsonResponse(200, { id: "order-1", total: 1000 });
    };

    const order = await fetchCommerce7Order(
      { tenant: "acme-tenant", externalOrderId: "order-1" },
      { fetchImpl },
    );

    assert.equal(order.id, "order-1");
    assert.ok(capturedUrl.includes("/order/order-1"));
    if (!capturedHeaders) {
      throw new Error("expected fetchImpl to be called with headers");
    }
    const headers: Record<string, string> = capturedHeaders;
    assert.equal(headers.tenant, "acme-tenant");
    assert.ok(headers.Authorization.startsWith("Basic "));
  });

  test("38. a 404 from Commerce7 raises CommerceProviderApiError carrying httpStatus 404", async () => {
    const fetchImpl: Commerce7Fetch = async () => jsonResponse(404, { message: "not found" });

    await assert.rejects(
      () =>
        fetchCommerce7Order(
          { tenant: "acme-tenant", externalOrderId: "missing-order" },
          { fetchImpl },
        ),
      (error: unknown) => {
        assert.ok(error instanceof CommerceProviderApiError);
        assert.equal(error.httpStatus, 404);
        assert.equal(error.provider, CommerceProvider.COMMERCE7);
        return true;
      },
    );
  });

  test("39. missing app credentials fail closed BEFORE any network call", async () => {
    const originalId = process.env.COMMERCE7_APP_ID;
    const originalSecret = process.env.COMMERCE7_APP_SECRET;
    delete process.env.COMMERCE7_APP_ID;
    delete process.env.COMMERCE7_APP_SECRET;

    let fetchCalled = false;
    try {
      await assert.rejects(() =>
        fetchCommerce7Order(
          { tenant: "acme-tenant", externalOrderId: "order-1" },
          {
            fetchImpl: async () => {
              fetchCalled = true;
              return jsonResponse(200, {});
            },
          },
        ),
      );
      assert.equal(fetchCalled, false);
    } finally {
      process.env.COMMERCE7_APP_ID = originalId;
      process.env.COMMERCE7_APP_SECRET = originalSecret;
    }
  });

  test("40. fetchCommerce7OrdersByDateRange refuses a missing/inverted date window", async () => {
    const fetchImpl: Commerce7Fetch = async () => jsonResponse(200, { orders: [], total: 0 });

    await assert.rejects(() =>
      fetchCommerce7OrdersByDateRange(
        {
          tenant: "acme-tenant",
          updatedAtGte: new Date("2026-01-10"),
          updatedAtLte: new Date("2026-01-01"),
        },
        { fetchImpl },
      ),
    );
  });

  test("40b. fetchCommerce7OrdersByDateRange enforces the upper bound client-side", async () => {
    const fetchImpl: Commerce7Fetch = async () =>
      jsonResponse(200, {
        orders: [
          { id: "in-window", updatedAt: "2026-01-05T00:00:00.000Z" },
          { id: "out-of-window", updatedAt: "2026-02-01T00:00:00.000Z" },
        ],
        total: 2,
      });

    const page = await fetchCommerce7OrdersByDateRange(
      {
        tenant: "acme-tenant",
        updatedAtGte: new Date("2026-01-01"),
        updatedAtLte: new Date("2026-01-31"),
      },
      { fetchImpl },
    );

    assert.equal(page.orders.length, 1);
    assert.equal(page.orders[0].id, "in-window");
  });
});

// ---------------------------------------------------------------------------
// 41-50. Pure normalizer
// ---------------------------------------------------------------------------

function rawOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "order-1",
    orderNumber: 1042,
    subTotal: 5000,
    shipTotal: 500,
    taxTotal: 400,
    total: 5900,
    totalAfterTip: 6200,
    paymentStatus: "Paid",
    fulfillmentStatus: "Fulfilled",
    createdAt: "2026-01-01T12:00:00.000Z",
    updatedAt: "2026-01-02T12:00:00.000Z",
    items: [
      {
        id: "line-1",
        productId: "prod-1",
        productVariantId: "var-1",
        productTitle: "2021 Malbec",
        sku: "MALBEC-21",
        quantity: 2,
        price: 2500,
        originalPrice: 3000,
        tax: 400,
      },
    ],
    ...overrides,
  };
}

const CONNECTED_CONTEXT = {
  connectionId: "conn-1",
  brandId: "brand-a",
  provider: CommerceProvider.COMMERCE7,
  currencyCode: "USD",
} as const;

describe("41-50. normalizeCommerce7Order", () => {
  test("41. a representative Order object normalizes fully with a known currency", () => {
    const { order, warnings } = normalizeCommerce7Order(rawOrder(), CONNECTED_CONTEXT);

    assert.equal(order.externalOrderId, "order-1");
    assert.equal(order.orderNumber, "1042");
    assert.equal(order.currencyCode, "USD");
    assert.equal(order.minorUnitExponent, 2);
    assert.equal(order.subtotalMinor, BigInt(5000));
    assert.equal(order.shippingMinor, BigInt(500));
    assert.equal(order.taxMinor, BigInt(400));
    assert.equal(order.totalMinor, BigInt(5900));
    assert.equal(order.completeness, "FULL");
    assert.equal(order.lineItems.length, 1);
    assert.deepEqual(warnings, []);
  });

  test("42. paymentStatus maps Paid/Authorized/Cancelled to PAID/AUTHORIZED/VOIDED", () => {
    const paid = normalizeCommerce7Order(rawOrder({ paymentStatus: "Paid" }), CONNECTED_CONTEXT);
    const authorized = normalizeCommerce7Order(
      rawOrder({ paymentStatus: "Authorized" }),
      CONNECTED_CONTEXT,
    );
    const cancelled = normalizeCommerce7Order(
      rawOrder({ paymentStatus: "Cancelled" }),
      CONNECTED_CONTEXT,
    );
    assert.equal(paid.order.financialStatus, "PAID");
    assert.equal(authorized.order.financialStatus, "AUTHORIZED");
    assert.equal(cancelled.order.financialStatus, "VOIDED");
  });

  test("43. fulfillmentStatus maps all four documented values, 'No Fulfillment Required' -> null", () => {
    const cases: Array<[string, string | null]> = [
      ["Fulfilled", "FULFILLED"],
      ["Not Fulfilled", "UNFULFILLED"],
      ["Partially Fulfilled", "PARTIALLY_FULFILLED"],
      ["No Fulfillment Required", null],
    ];
    for (const [raw, expected] of cases) {
      const { order } = normalizeCommerce7Order(
        rawOrder({ fulfillmentStatus: raw }),
        CONNECTED_CONTEXT,
      );
      assert.equal(order.fulfillmentStatus, expected, raw);
    }
  });

  test("44. an unknown connection currency nulls every money field and the exponent, with a warning", () => {
    const { order, warnings } = normalizeCommerce7Order(rawOrder(), {
      ...CONNECTED_CONTEXT,
      currencyCode: null,
    });
    assert.equal(order.currencyCode, null);
    assert.equal(order.minorUnitExponent, null);
    assert.equal(order.subtotalMinor, null);
    assert.equal(order.shippingMinor, null);
    assert.equal(order.taxMinor, null);
    assert.equal(order.totalMinor, null);
    assert.equal(order.lineItems[0].unitPriceMinor, null);
    assert.equal(order.lineItems[0].taxMinor, null);
    assert.equal(order.lineItems[0].totalMinor, null);
    assert.ok(warnings.includes("UNKNOWN_CONNECTION_CURRENCY"));
  });

  test("45. cancelledAt/cancelReason are always null — Commerce7 documents no such field", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({ paymentStatus: "Cancelled" }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.cancelledAt, null);
    assert.equal(order.cancelReason, null);
  });

  test("46. discountsMinor (order) and discountMinor (line) are always null — no documented field", () => {
    const { order } = normalizeCommerce7Order(rawOrder(), CONNECTED_CONTEXT);
    assert.equal(order.discountsMinor, null);
    assert.equal(order.lineItems[0].discountMinor, null);
  });

  test("47. totalRefundedMinor is null when the payload carries no tenders array (PHASE 16/17 REPAIR: refined — see the dedicated tender-based tests below)", () => {
    const { order } = normalizeCommerce7Order(rawOrder(), CONNECTED_CONTEXT);
    assert.equal(order.totalRefundedMinor, null);
  });

  test("48. line item totalMinor is pure arithmetic: unitPriceMinor * quantity", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({ items: [{ id: "l1", productId: "p1", price: 1500, quantity: 3, tax: 100 }] }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.lineItems[0].unitPriceMinor, BigInt(1500));
    assert.equal(order.lineItems[0].totalMinor, BigInt(4500));
  });

  test("49. a malformed (non-object) payload never throws — returns an empty FULL order with a warning", () => {
    const { order, warnings } = normalizeCommerce7Order("not an object", CONNECTED_CONTEXT);
    assert.equal(order.externalOrderId, null);
    assert.equal(order.completeness, "FULL");
    assert.deepEqual(order.lineItems, []);
    assert.ok(warnings.includes("MALFORMED_PAYLOAD"));
  });

  test("50. a missing order id produces a MISSING_EXTERNAL_ORDER_ID warning", () => {
    const { order, warnings } = normalizeCommerce7Order(rawOrder({ id: undefined }), CONNECTED_CONTEXT);
    assert.equal(order.externalOrderId, null);
    assert.ok(warnings.includes("MISSING_EXTERNAL_ORDER_ID"));
  });
});

// ---------------------------------------------------------------------------
// PHASE 16/17 REPAIR — PART 1F: financial reconciliation via tenders[]
// ---------------------------------------------------------------------------

function tender(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tender-1",
    tenderType: "Credit Card",
    chargeType: "Sale",
    chargeStatus: "Success",
    amountTendered: 5900,
    ...overrides,
  };
}

describe("Part 1F. Commerce7 tender-based financial reconciliation", () => {
  test("1. paid normal sale: a single successful Sale tender, no refund tenders -> PAID, totalRefundedMinor 0", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({ paymentStatus: "Paid", tenders: [tender({ chargeType: "Sale", amountTendered: 5900 })] }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.financialStatus, "PAID");
    assert.equal(order.totalRefundedMinor, BigInt(0));
  });

  test("2. a successful Refund tender fully covering the total -> REFUNDED, totalRefundedMinor equals total", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        total: 5900,
        tenders: [
          tender({ id: "t1", chargeType: "Sale", chargeStatus: "Success", amountTendered: 5900 }),
          tender({ id: "t2", chargeType: "Refund", chargeStatus: "Success", amountTendered: 5900 }),
        ],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.totalRefundedMinor, BigInt(5900));
    assert.equal(order.financialStatus, "REFUNDED");
  });

  test("3. a Failed Refund tender is never counted as completed money movement", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        tenders: [
          tender({ id: "t1", chargeType: "Sale", chargeStatus: "Success", amountTendered: 5900 }),
          tender({ id: "t2", chargeType: "Refund", chargeStatus: "Failed", amountTendered: 2000 }),
        ],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.totalRefundedMinor, BigInt(0));
    assert.equal(order.financialStatus, "PAID");
  });

  test("4. a Cancelled Refund tender is never counted as completed money movement", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        tenders: [tender({ chargeType: "Refund", chargeStatus: "Cancelled", amountTendered: 2000 })],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.totalRefundedMinor, BigInt(0));
    assert.equal(order.financialStatus, "PAID");
  });

  test("5. repeated identical refund update (same tenders re-normalized) yields the SAME totalRefundedMinor — idempotent", () => {
    const payload = rawOrder({
      paymentStatus: "Paid",
      total: 5900,
      tenders: [tender({ chargeType: "Refund", chargeStatus: "Success", amountTendered: 2000 })],
    });
    const first = normalizeCommerce7Order(payload, CONNECTED_CONTEXT);
    const second = normalizeCommerce7Order(payload, CONNECTED_CONTEXT);
    assert.equal(first.order.totalRefundedMinor, second.order.totalRefundedMinor);
    assert.equal(first.order.totalRefundedMinor, BigInt(2000));
  });

  test("6. multiple successful refund tenders sum together", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        total: 5900,
        tenders: [
          tender({ id: "t1", chargeType: "Sale", chargeStatus: "Success", amountTendered: 5900 }),
          tender({ id: "t2", chargeType: "Refund", chargeStatus: "Success", amountTendered: 2000 }),
          tender({ id: "t3", chargeType: "Refund", chargeStatus: "Success", amountTendered: 1500 }),
        ],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.totalRefundedMinor, BigInt(3500));
    assert.equal(order.financialStatus, "PARTIALLY_REFUNDED");
  });

  test("7. an unsafe (non-safe-integer) amountTendered on a refund tender is skipped, not fabricated", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        tenders: [tender({ chargeType: "Refund", chargeStatus: "Success", amountTendered: 2 ** 53 })],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.totalRefundedMinor, BigInt(0));
  });

  test("8. a malformed (non-numeric) amountTendered is skipped, not fabricated", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        tenders: [tender({ chargeType: "Refund", chargeStatus: "Success", amountTendered: "2000" })],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.totalRefundedMinor, BigInt(0));
  });

  test("9. an unknown/unrecognized chargeType is never counted as a refund", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        tenders: [tender({ chargeType: "SomeUnknownChargeType", chargeStatus: "Success", amountTendered: 2000 })],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.totalRefundedMinor, BigInt(0));
    assert.equal(order.financialStatus, "PAID");
  });

  test("10. the PURE per-order normalizer never reads previousOrderId/linkedOrders/purchaseType and never substitutes identity", () => {
    // PHASE 25 CLARIFICATION: this test is scoped to `normalizeCommerce7Order`
    // itself, which is deliberately unchanged — a pure per-order snapshot
    // function has no business resolving cross-order identity. What DID
    // change is one layer up: `commerce7-order-refund-reconciliation.ts` now
    // reads these exact fields BEFORE this function is ever called, and
    // resolves a genuine Commerce7 refund order to its ORIGINAL order's
    // canonical identity — see that module's tests
    // (`commerce7-order-refund-reconciliation.test.ts`) for the real
    // observed refund relationship this repository now understands. This
    // test only proves the normalizer itself still has no such behavior.
    const { order } = normalizeCommerce7Order(
      rawOrder({
        id: "order-child",
        previousOrderId: "order-parent",
        previousOrderNumber: 999,
        linkedOrders: ["order-sibling"],
        purchaseType: "Refund",
      }),
      CONNECTED_CONTEXT,
    );
    // The normalizer must still resolve to ITS OWN order id, never the
    // referenced previousOrderId — no merge, no identity substitution.
    assert.equal(order.externalOrderId, "order-child");
  });

  test("11. an unrelated purchaseType value on the payload has no effect (field is not read at all)", () => {
    const { order: withExchange } = normalizeCommerce7Order(
      rawOrder({ purchaseType: "Exchange" }),
      CONNECTED_CONTEXT,
    );
    const { order: withoutField } = normalizeCommerce7Order(rawOrder(), CONNECTED_CONTEXT);
    assert.equal(withExchange.financialStatus, withoutField.financialStatus);
    assert.equal(withExchange.totalRefundedMinor, withoutField.totalRefundedMinor);
  });

  test("12. (pure normalizer only) a linkedOrders array present alongside tenders does not affect the tender-derived refund computation — see commerce7-order-refund-reconciliation.test.ts for the layer that DOES act on linkedOrders", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        total: 5900,
        linkedOrders: ["some-other-order-id"],
        tenders: [tender({ chargeType: "Refund", chargeStatus: "Success", amountTendered: 1000 })],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.totalRefundedMinor, BigInt(1000));
  });

  test("13. a Cancelled order (paymentStatus) is never refund-refined even with a present Refund tender", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Cancelled",
        tenders: [tender({ chargeType: "Refund", chargeStatus: "Success", amountTendered: 1000 })],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.financialStatus, "VOIDED");
  });

  test("14. an Authorized order is never refund-refined even with a present Refund tender", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Authorized",
        tenders: [tender({ chargeType: "Refund", chargeStatus: "Success", amountTendered: 1000 })],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.financialStatus, "AUTHORIZED");
  });

  test("15. paid then refunded update: a FULL re-normalization after a refund correctly transitions PAID -> PARTIALLY_REFUNDED", () => {
    const paidOnly = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        total: 5900,
        tenders: [tender({ id: "t1", chargeType: "Sale", chargeStatus: "Success", amountTendered: 5900 })],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(paidOnly.order.financialStatus, "PAID");

    const afterRefund = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        total: 5900,
        tenders: [
          tender({ id: "t1", chargeType: "Sale", chargeStatus: "Success", amountTendered: 5900 }),
          tender({ id: "t2", chargeType: "Refund", chargeStatus: "Success", amountTendered: 2000 }),
        ],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(afterRefund.order.financialStatus, "PARTIALLY_REFUNDED");
    assert.equal(afterRefund.order.totalRefundedMinor, BigInt(2000));
  });

  test("16. an empty tenders array is complete evidence of zero refunds, not 'unknown'", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({ paymentStatus: "Paid", tenders: [] }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.totalRefundedMinor, BigInt(0));
    assert.notEqual(order.totalRefundedMinor, null);
  });

  // -----------------------------------------------------------------------
  // PHASE 18 REPAIR — P2-4C: tender.id-based dedup.
  // -----------------------------------------------------------------------
  test("18. the SAME tender.id repeated in the array is counted ONCE, never summed twice", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        total: 5900,
        tenders: [
          tender({ id: "t1", chargeType: "Sale", chargeStatus: "Success", amountTendered: 5900 }),
          tender({ id: "t2", chargeType: "Refund", chargeStatus: "Success", amountTendered: 2000 }),
          // A byte-identical repeat of t2 — simulates a duplicated array
          // entry, not a second real refund.
          tender({ id: "t2", chargeType: "Refund", chargeStatus: "Success", amountTendered: 2000 }),
        ],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.totalRefundedMinor, BigInt(2000), "the repeated t2 must not double-count");
  });

  test("19. the SAME refundId split across DIFFERENT tender.id values counts BOTH — never deduplicated by refundId", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        total: 5900,
        tenders: [
          tender({ id: "t1", chargeType: "Sale", chargeStatus: "Success", amountTendered: 5900 }),
          tender({
            id: "t2",
            refundId: "refund-shared",
            chargeType: "Refund",
            chargeStatus: "Success",
            amountTendered: 1000,
          }),
          tender({
            id: "t3",
            refundId: "refund-shared",
            chargeType: "Refund",
            chargeStatus: "Success",
            amountTendered: 500,
          }),
        ],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(
      order.totalRefundedMinor,
      BigInt(1500),
      "a split refund sharing one refundId across two distinct tender ids must sum both parts",
    );
  });

  test("20. a malformed/missing tender.id is never fabricated an identity, and is never deduplicated against another entry", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        total: 5900,
        tenders: [
          tender({ id: undefined, chargeType: "Refund", chargeStatus: "Success", amountTendered: 1000 }),
          tender({ id: undefined, chargeType: "Refund", chargeStatus: "Success", amountTendered: 1000 }),
        ],
      }),
      CONNECTED_CONTEXT,
    );
    // Two genuinely separate id-less tenders each contribute their own
    // amount — id-less entries are simply never collapsed against each
    // other (no fabricated shared identity), so both count.
    assert.equal(order.totalRefundedMinor, BigInt(2000));
  });

  test("21. a tender-derived refund total exceeding the order total is passed through HONESTLY — never silently clamped, corrected, or hidden by this normalizer", () => {
    // This normalizer has no authority to invent a corrected number, so it
    // must not try to "fix" an overshoot itself — that responsibility
    // belongs to the EXISTING, already-tested, provider-neutral FINANCIAL
    // INVARIANT GUARD inside `ingestNormalizedOrder`
    // (see tests/order-ingestion.test.ts, describe "K. the financial
    // invariant guard...", which proves `totalRefundedMinor > totalMinor`
    // is rejected as FAILED/CONTRADICTORY_FINANCIAL_SNAPSHOT with nothing
    // written — that coverage is provider-neutral and already exercises
    // this exact condition, so it is not re-mocked here). This test's job
    // is narrower and specific to Commerce7: prove the normalizer feeds
    // that guard the TRUE, un-doctored tender-derived value rather than
    // masking the overshoot before it ever reaches the guard.
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        total: 5900,
        tenders: [
          tender({ id: "t1", chargeType: "Sale", chargeStatus: "Success", amountTendered: 5900 }),
          // A refund total that overshoots the order total — e.g. a data
          // anomaly on Commerce7's side.
          tender({ id: "t2", chargeType: "Refund", chargeStatus: "Success", amountTendered: 9999 }),
        ],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.totalRefundedMinor, BigInt(9999), "the true overshot value, not clamped to the total");
    assert.ok(order.totalMinor !== null && order.totalRefundedMinor! > order.totalMinor);
    // financialStatus still reports the base PAID->REFUNDED mapping (>=
    // total triggers REFUNDED) — it is the DOWNSTREAM guard's job, not
    // this normalizer's, to notice totalRefundedMinor !== totalMinor
    // exactly and reject the whole snapshot as contradictory.
    assert.equal(order.financialStatus, "REFUNDED");
  });

  test("sign-agnostic: a negative amountTendered on a refund tender still contributes its magnitude, never a fabricated/negative total", () => {
    const { order } = normalizeCommerce7Order(
      rawOrder({
        paymentStatus: "Paid",
        total: 5900,
        tenders: [tender({ chargeType: "Refund", chargeStatus: "Success", amountTendered: -2000 })],
      }),
      CONNECTED_CONTEXT,
    );
    assert.equal(order.totalRefundedMinor, BigInt(2000));
    assert.ok(order.totalRefundedMinor !== null && order.totalRefundedMinor >= BigInt(0));
  });

  test("missing tenders (undefined, as in the base rawOrder fixture) yields null, preserving any stored value", () => {
    const { order } = normalizeCommerce7Order(rawOrder({ paymentStatus: "Paid" }), CONNECTED_CONTEXT);
    assert.equal(order.totalRefundedMinor, null);
  });
});

// ---------------------------------------------------------------------------
// 51-58. Order webhook route
// ---------------------------------------------------------------------------

function makeRequest(body: unknown, authHeader: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authHeader) {
    headers.authorization = authHeader;
  }
  return new Request("https://sqratch.example/api/commerce7/webhooks/orders", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }) as unknown as Request;
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function orderWebhookPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: "Order",
    action: "Create",
    tenantId: "acme-tenant",
    user: { id: "some-commerce7-user" },
    payload: rawOrder(),
    ...overrides,
  };
}

const WEBHOOK_CONNECTION: Commerce7OrderWebhookConnection = {
  id: "conn-1",
  brandId: "brand-a",
  currencyCode: "USD",
  status: "CONNECTED",
};

describe("51-58. commerce7 order webhook route", () => {
  test("51. an unconfigured Basic Auth credential fails closed with 500 — never treated as authorized", async () => {
    const original = { u: process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME, p: process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD };
    delete process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME;
    delete process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD;
    try {
      const res = await handleCommerce7OrderWebhook(
        makeRequest(orderWebhookPayload(), null) as never,
      );
      assert.equal(res.status, 500);
    } finally {
      if (original.u) process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME = original.u;
      if (original.p) process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD = original.p;
    }
  });

  test("52. wrong Basic Auth credentials are rejected with 401", async () => {
    process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME = "hookuser";
    process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD = "hookpass";

    let ingestCalled = false;
    const res = await handleCommerce7OrderWebhook(
      makeRequest(orderWebhookPayload(), basicAuthHeader("wrong", "creds")) as never,
      {
        findConnectionByTenant: async () => WEBHOOK_CONNECTION,
        ingest: async () => {
          ingestCalled = true;
          throw new Error("must not be called");
        },
      },
    );
    assert.equal(res.status, 401);
    assert.equal(ingestCalled, false);
  });

  test("53. object !== 'Order' is a deterministic 200 no-op", async () => {
    let ingestCalled = false;
    const res = await handleCommerce7OrderWebhook(
      makeRequest(
        orderWebhookPayload({ object: "Product" }),
        basicAuthHeader("hookuser", "hookpass"),
      ) as never,
      {
        findConnectionByTenant: async () => WEBHOOK_CONNECTION,
        ingest: async () => {
          ingestCalled = true;
          throw new Error("must not be called");
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(ingestCalled, false);
  });

  test("54. an unsupported action (e.g. Delete) is a deterministic 200 no-op", async () => {
    let ingestCalled = false;
    const res = await handleCommerce7OrderWebhook(
      makeRequest(
        orderWebhookPayload({ action: "Delete" }),
        basicAuthHeader("hookuser", "hookpass"),
      ) as never,
      {
        findConnectionByTenant: async () => WEBHOOK_CONNECTION,
        ingest: async () => {
          ingestCalled = true;
          throw new Error("must not be called");
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(ingestCalled, false);
  });

  test("55. an unknown tenant is a 200 no-op — no ingestion attempted, never picks another connection", async () => {
    let ingestCalled = false;
    const res = await handleCommerce7OrderWebhook(
      makeRequest(orderWebhookPayload(), basicAuthHeader("hookuser", "hookpass")) as never,
      {
        findConnectionByTenant: async () => null,
        ingest: async () => {
          ingestCalled = true;
          throw new Error("must not be called");
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(ingestCalled, false);
  });

  // -----------------------------------------------------------------------
  // PHASE 18 REPAIR — P2-4D: resolver-level connection-status gate.
  // -----------------------------------------------------------------------
  test("55b. a DISCONNECTED tenant is a 200 no-op — zero normalization/ingestion attempted", async () => {
    let ingestCalled = false;
    const res = await handleCommerce7OrderWebhook(
      makeRequest(orderWebhookPayload(), basicAuthHeader("hookuser", "hookpass")) as never,
      {
        findConnectionByTenant: async () => ({ ...WEBHOOK_CONNECTION, status: "DISCONNECTED" }),
        ingest: async () => {
          ingestCalled = true;
          throw new Error("must not be called");
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(ingestCalled, false);
  });

  test("55c. an UNINSTALLED tenant is a 200 no-op — zero normalization/ingestion attempted", async () => {
    let ingestCalled = false;
    const res = await handleCommerce7OrderWebhook(
      makeRequest(orderWebhookPayload(), basicAuthHeader("hookuser", "hookpass")) as never,
      {
        findConnectionByTenant: async () => ({ ...WEBHOOK_CONNECTION, status: "UNINSTALLED" }),
        ingest: async () => {
          ingestCalled = true;
          throw new Error("must not be called");
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(ingestCalled, false);
  });

  test("55d. an ERROR-status tenant is a 200 no-op — zero normalization/ingestion attempted", async () => {
    let ingestCalled = false;
    const res = await handleCommerce7OrderWebhook(
      makeRequest(orderWebhookPayload(), basicAuthHeader("hookuser", "hookpass")) as never,
      {
        findConnectionByTenant: async () => ({ ...WEBHOOK_CONNECTION, status: "ERROR" }),
        ingest: async () => {
          ingestCalled = true;
          throw new Error("must not be called");
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(ingestCalled, false);
  });

  // -----------------------------------------------------------------------
  // PHASE 16-18 REPAIR — P1-3: a fresh independent review found the prior
  // (P2-4D) resolver-level gate too permissive — it reused the shared
  // `isIngestibleConnectionStatus` predicate, which treats PENDING and
  // REQUIRES_RECONNECT as ingestible. The review's required invariant for
  // this webhook boundary specifically is `status === CONNECTED`, full
  // stop. These two tests previously asserted the OPPOSITE (that ingestion
  // proceeds for these states) and are rewritten here to assert the
  // corrected, stricter behavior. `isIngestibleConnectionStatus` itself is
  // unchanged — this tightening is scoped to the Commerce7 webhook
  // resolver only (see `Commerce7OrderWebhookConnection.status`'s doc
  // comment in the source file).
  // -----------------------------------------------------------------------
  test("55e. a REQUIRES_RECONNECT tenant is a 200 no-op — zero normalization/ingestion attempted", async () => {
    let ingestCalled = false;
    const res = await handleCommerce7OrderWebhook(
      makeRequest(orderWebhookPayload(), basicAuthHeader("hookuser", "hookpass")) as never,
      {
        findConnectionByTenant: async () => ({ ...WEBHOOK_CONNECTION, status: "REQUIRES_RECONNECT" }),
        ingest: async () => {
          ingestCalled = true;
          throw new Error("must not be called");
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(ingestCalled, false);
  });

  test("55f. a PENDING tenant is a 200 no-op — zero normalization/ingestion attempted", async () => {
    let ingestCalled = false;
    const res = await handleCommerce7OrderWebhook(
      makeRequest(orderWebhookPayload(), basicAuthHeader("hookuser", "hookpass")) as never,
      {
        findConnectionByTenant: async () => ({ ...WEBHOOK_CONNECTION, status: "PENDING" }),
        ingest: async () => {
          ingestCalled = true;
          throw new Error("must not be called");
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(ingestCalled, false);
  });

  test("56. a known tenant + Create action ingests a FULL-completeness order via the exact resolved connection", async () => {
    let capturedEvent: unknown = null;
    let capturedOrder: unknown = null;
    const res = await handleCommerce7OrderWebhook(
      makeRequest(orderWebhookPayload(), basicAuthHeader("hookuser", "hookpass")) as never,
      {
        findConnectionByTenant: async (tenant) => {
          assert.equal(tenant, "acme-tenant");
          return WEBHOOK_CONNECTION;
        },
        ingest: async (event, order) => {
          capturedEvent = event;
          capturedOrder = order;
          return {
            status: "CREATED",
            reason: null,
            eventId: "evt-1",
            orderId: "order-row-1",
            lineItemCount: 1,
            attributionLinked: false,
            brandIdOverriddenFromConnection: false,
          } satisfies OrderIngestionOutcome;
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal((capturedEvent as { connectionId: string }).connectionId, "conn-1");
    assert.equal((capturedEvent as { brandId: string }).brandId, "brand-a");
    assert.equal((capturedEvent as { provider: string }).provider, "COMMERCE7");
    assert.equal((capturedOrder as { completeness: string }).completeness, "FULL");
    assert.equal((capturedOrder as { currencyCode: string | null }).currencyCode, "USD");
  });

  test("57. an IN_FLIGHT ingestion outcome maps to 500 (retryable), never acknowledged", async () => {
    const res = await handleCommerce7OrderWebhook(
      makeRequest(orderWebhookPayload(), basicAuthHeader("hookuser", "hookpass")) as never,
      {
        findConnectionByTenant: async () => WEBHOOK_CONNECTION,
        ingest: async () => ({
          status: "IN_FLIGHT",
          reason: "DELIVERY_IN_FLIGHT",
          eventId: "evt-1",
          orderId: null,
          lineItemCount: 0,
          attributionLinked: false,
          brandIdOverriddenFromConnection: false,
        }),
      },
    );
    assert.equal(res.status, 500);
  });

  test("58. resolveCommerce7ProviderEventId is deterministic and digest-based, byte-identical bodies dedupe", () => {
    const bodyA = JSON.stringify(orderWebhookPayload());
    const bodyB = JSON.stringify(orderWebhookPayload());
    const digestA = computeCommerce7PayloadDigest(bodyA);
    const digestB = computeCommerce7PayloadDigest(bodyB);
    assert.equal(digestA, digestB);
    assert.equal(resolveCommerce7ProviderEventId(digestA), resolveCommerce7ProviderEventId(digestB));
    assert.equal(resolveCommerce7ProviderEventId(digestA), `digest:${digestA}`);
  });

  // -------------------------------------------------------------------------
  // PHASE 25 — refund-aware preparation orchestration.
  // -------------------------------------------------------------------------

  test("61. a TRANSIENT_FAILURE from prepareOrder maps to 500 and NEVER calls ingest — no claim taken, redelivery starts fresh", async () => {
    let ingestCalled = false;
    const res = await handleCommerce7OrderWebhook(
      makeRequest(orderWebhookPayload(), basicAuthHeader("hookuser", "hookpass")) as never,
      {
        findConnectionByTenant: async () => WEBHOOK_CONNECTION,
        prepareOrder: async () => ({ outcome: "TRANSIENT_FAILURE" }),
        ingest: async () => {
          ingestCalled = true;
          throw new Error("must not be called");
        },
      },
    );
    assert.equal(res.status, 500);
    assert.equal(ingestCalled, false);
  });

  test("62. prepareOrder is called with the resolved tenant and the raw payload, and its READY order is what reaches ingest verbatim", async () => {
    let capturedTenant: string | null = null;
    let capturedIngestOrder: unknown = null;
    const res = await handleCommerce7OrderWebhook(
      makeRequest(orderWebhookPayload({ action: "Update" }), basicAuthHeader("hookuser", "hookpass")) as never,
      {
        findConnectionByTenant: async () => WEBHOOK_CONNECTION,
        prepareOrder: async (raw, _context, tenant) => {
          capturedTenant = tenant;
          assert.ok(raw && typeof raw === "object");
          return {
            outcome: "READY",
            order: {
              connectionId: "conn-1",
              brandId: "brand-a",
              provider: CommerceProvider.COMMERCE7,
              completeness: "FULL",
              externalOrderId: "order-1002",
              orderNumber: "1002",
              currencyCode: "USD",
              minorUnitExponent: 2,
              subtotalMinor: BigInt(8700),
              discountsMinor: null,
              shippingMinor: null,
              taxMinor: BigInt(1131),
              totalMinor: BigInt(9831),
              totalRefundedMinor: BigInt(3277),
              financialStatus: "PARTIALLY_REFUNDED",
              fulfillmentStatus: "FULFILLED",
              cancelledAt: null,
              cancelReason: null,
              providerCreatedAt: null,
              providerUpdatedAt: new Date("2026-08-26T04:39:24.783Z"),
              lineItems: [],
              attributionToken: null,
            },
            warnings: [],
            refundReconciliationOutcome: "RECONCILED",
            refundReconciliationReason: null,
          };
        },
        ingest: async (_event, order) => {
          capturedIngestOrder = order;
          return {
            status: "UPDATED",
            reason: null,
            eventId: "evt-1",
            orderId: "order-row-1",
            lineItemCount: 0,
            attributionLinked: false,
            brandIdOverriddenFromConnection: false,
          } satisfies OrderIngestionOutcome;
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(capturedTenant, "acme-tenant");
    assert.equal((capturedIngestOrder as { externalOrderId: string }).externalOrderId, "order-1002");
    assert.equal((capturedIngestOrder as { totalRefundedMinor: bigint }).totalRefundedMinor, BigInt(3277));
    assert.equal((capturedIngestOrder as { financialStatus: string }).financialStatus, "PARTIALLY_REFUNDED");
  });
});

// ---------------------------------------------------------------------------
// 59-60. Bounded backfill entrypoint
// ---------------------------------------------------------------------------

function backfillRow(
  overrides: Partial<Commerce7BackfillConnectionRow> = {},
): Commerce7BackfillConnectionRow {
  return {
    id: "conn-1",
    brandId: "brand-a",
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    externalAccountId: "acme-tenant",
    providerMetadata: { currencyCode: "USD" },
    ...overrides,
  };
}

describe("59-60. backfillCommerce7Orders", () => {
  test("59a. a foreign-brand connectionId throws CommerceConnectionNotFoundError", async () => {
    await assert.rejects(
      () =>
        backfillCommerce7Orders(
          {
            brandId: "brand-a",
            connectionId: "conn-1",
            updatedAtGte: new Date("2026-01-01"),
            updatedAtLte: new Date("2026-01-31"),
          },
          { loadConnection: async () => backfillRow({ brandId: "brand-OTHER" }) },
        ),
      CommerceConnectionNotFoundError,
    );
  });

  test("59b. a non-Commerce7 connection throws CommerceConnectionMismatchError", async () => {
    await assert.rejects(
      () =>
        backfillCommerce7Orders(
          {
            brandId: "brand-a",
            connectionId: "conn-1",
            updatedAtGte: new Date("2026-01-01"),
            updatedAtLte: new Date("2026-01-31"),
          },
          { loadConnection: async () => backfillRow({ provider: CommerceProvider.SHOPIFY }) },
        ),
      CommerceConnectionMismatchError,
    );
  });

  test("59c. a non-CONNECTED connection throws CommerceConnectionNotReadyError", async () => {
    await assert.rejects(
      () =>
        backfillCommerce7Orders(
          {
            brandId: "brand-a",
            connectionId: "conn-1",
            updatedAtGte: new Date("2026-01-01"),
            updatedAtLte: new Date("2026-01-31"),
          },
          { loadConnection: async () => backfillRow({ status: "DISCONNECTED" }) },
        ),
      CommerceConnectionNotReadyError,
    );
  });

  test("60a. truncates at COMMERCE7_BACKFILL_MAX_RESULTS and reports TRUNCATED", async () => {
    const overflow = COMMERCE7_BACKFILL_MAX_RESULTS + 5;
    const orders = Array.from({ length: overflow }, (_, i) =>
      rawOrder({ id: `order-${i}`, updatedAt: "2026-01-02T00:00:00.000Z" }),
    );

    const outcome = await backfillCommerce7Orders(
      {
        brandId: "brand-a",
        connectionId: "conn-1",
        updatedAtGte: new Date("2026-01-01"),
        updatedAtLte: new Date("2026-01-31"),
      },
      {
        loadConnection: async () => backfillRow(),
        fetchOrders: async () => ({ orders, total: overflow }),
        ingest: async () => ({
          status: "CREATED",
          reason: null,
          eventId: "evt",
          orderId: "row",
          lineItemCount: 1,
          attributionLinked: false,
          brandIdOverriddenFromConnection: false,
        }),
      },
    );

    assert.equal(outcome.status, "TRUNCATED");
    assert.equal(outcome.ordersFetched, overflow);
    assert.equal(outcome.ordersProcessed, COMMERCE7_BACKFILL_MAX_RESULTS);
  });

  test("60b. re-running the same window with an unchanged order derives the SAME deterministic event id", async () => {
    const order = rawOrder({ id: "order-stable", updatedAt: "2026-01-02T00:00:00.000Z" });
    const capturedEventIds: string[] = [];

    const deps = {
      loadConnection: async () => backfillRow(),
      fetchOrders: async () => ({ orders: [order], total: 1 }),
      ingest: async (event: { providerEventId: string }) => {
        capturedEventIds.push(event.providerEventId);
        return {
          status: "CREATED" as const,
          reason: null,
          eventId: "evt",
          orderId: "row",
          lineItemCount: 1,
          attributionLinked: false,
          brandIdOverriddenFromConnection: false,
        };
      },
    };

    await backfillCommerce7Orders(
      {
        brandId: "brand-a",
        connectionId: "conn-1",
        updatedAtGte: new Date("2026-01-01"),
        updatedAtLte: new Date("2026-01-31"),
      },
      deps,
    );
    await backfillCommerce7Orders(
      {
        brandId: "brand-a",
        connectionId: "conn-1",
        updatedAtGte: new Date("2026-01-01"),
        updatedAtLte: new Date("2026-01-31"),
      },
      deps,
    );

    assert.equal(capturedEventIds.length, 2);
    assert.equal(capturedEventIds[0], capturedEventIds[1]);
    assert.ok(capturedEventIds[0].startsWith("backfill:"));
  });

  // -------------------------------------------------------------------------
  // PHASE 25 — Part 11/19/20: backfill uses the SAME refund-aware
  // preparation the live webhook does, so a missed refund webhook is
  // repairable by re-running Catch Up / a Custom Range.
  // -------------------------------------------------------------------------

  test("19a. backfillCommerce7Orders calls prepareOrder (not normalizeCommerce7Order) with the connection's own tenant for every raw order", async () => {
    const capturedTenants: string[] = [];
    const capturedOrderIds: string[] = [];
    await backfillCommerce7Orders(
      {
        brandId: "brand-a",
        connectionId: "conn-1",
        updatedAtGte: new Date("2026-08-01"),
        updatedAtLte: new Date("2026-08-31"),
      },
      {
        loadConnection: async () => backfillRow({ externalAccountId: "sqratch-inc" }),
        fetchOrders: async () => ({ orders: [rawOrder({ id: "order-1002" })], total: 1 }),
        prepareOrder: async (raw, _context, tenant) => {
          capturedTenants.push(tenant);
          capturedOrderIds.push((raw as { id: string }).id);
          return {
            outcome: "READY",
            order: {
              connectionId: "conn-1",
              brandId: "brand-a",
              provider: CommerceProvider.COMMERCE7,
              completeness: "FULL",
              externalOrderId: "order-1002",
              orderNumber: "1002",
              currencyCode: "USD",
              minorUnitExponent: 2,
              subtotalMinor: null,
              discountsMinor: null,
              shippingMinor: null,
              taxMinor: null,
              totalMinor: BigInt(9831),
              totalRefundedMinor: null,
              financialStatus: "PAID",
              fulfillmentStatus: null,
              cancelledAt: null,
              cancelReason: null,
              providerCreatedAt: null,
              providerUpdatedAt: new Date("2026-08-26T04:39:24.783Z"),
              lineItems: [],
              attributionToken: null,
            },
            warnings: [],
            refundReconciliationOutcome: "NOT_APPLICABLE",
            refundReconciliationReason: null,
          };
        },
        ingest: async () => ({
          status: "UPDATED",
          reason: null,
          eventId: "evt",
          orderId: "row",
          lineItemCount: 0,
          attributionLinked: false,
          brandIdOverriddenFromConnection: false,
        }),
      },
    );
    assert.deepEqual(capturedTenants, ["sqratch-inc"]);
    assert.deepEqual(capturedOrderIds, ["order-1002"]);
  });

  test("19b. a TRANSIENT_FAILURE for one order in the page is skipped, never persisted, and never aborts the rest of the page", async () => {
    const ingestedOrderIds: string[] = [];
    const outcome = await backfillCommerce7Orders(
      {
        brandId: "brand-a",
        connectionId: "conn-1",
        updatedAtGte: new Date("2026-08-01"),
        updatedAtLte: new Date("2026-08-31"),
      },
      {
        loadConnection: async () => backfillRow(),
        fetchOrders: async () => ({
          orders: [rawOrder({ id: "order-transient-fail" }), rawOrder({ id: "order-fine" })],
          total: 2,
        }),
        prepareOrder: async (raw) => {
          const id = (raw as { id: string }).id;
          if (id === "order-transient-fail") {
            return { outcome: "TRANSIENT_FAILURE" };
          }
          return {
            outcome: "READY",
            order: {
              connectionId: "conn-1",
              brandId: "brand-a",
              provider: CommerceProvider.COMMERCE7,
              completeness: "FULL",
              externalOrderId: id,
              orderNumber: "1",
              currencyCode: "USD",
              minorUnitExponent: 2,
              subtotalMinor: null,
              discountsMinor: null,
              shippingMinor: null,
              taxMinor: null,
              totalMinor: BigInt(100),
              totalRefundedMinor: null,
              financialStatus: "PAID",
              fulfillmentStatus: null,
              cancelledAt: null,
              cancelReason: null,
              providerCreatedAt: null,
              providerUpdatedAt: new Date("2026-08-26T00:00:00.000Z"),
              lineItems: [],
              attributionToken: null,
            },
            warnings: [],
            refundReconciliationOutcome: "NOT_APPLICABLE",
            refundReconciliationReason: null,
          };
        },
        ingest: async (event, order) => {
          ingestedOrderIds.push(order.externalOrderId!);
          return {
            status: "UPDATED",
            reason: null,
            eventId: "evt",
            orderId: "row",
            lineItemCount: 0,
            attributionLinked: false,
            brandIdOverriddenFromConnection: false,
          };
        },
      },
    );
    assert.deepEqual(ingestedOrderIds, ["order-fine"]);
    assert.equal(outcome.ordersProcessed, 1);
  });

  test("20/21. one backfill page containing BOTH the root order and its own refund child reconciles to a SINGLE ingest write for the root — the refund child never becomes its own CommerceOrder row, and re-running the same page is idempotent", async () => {
    const ingestedOrderIds: string[] = [];
    const rootReadyResult = (refundedMinor: bigint) => ({
      outcome: "READY" as const,
      order: {
        connectionId: "conn-1",
        brandId: "brand-a",
        provider: CommerceProvider.COMMERCE7,
        completeness: "FULL" as const,
        externalOrderId: "order-1002",
        orderNumber: "1002",
        currencyCode: "CAD",
        minorUnitExponent: 2,
        subtotalMinor: BigInt(8700),
        discountsMinor: null,
        shippingMinor: null,
        taxMinor: BigInt(1131),
        totalMinor: BigInt(9831),
        totalRefundedMinor: refundedMinor,
        financialStatus: refundedMinor > BigInt(0) ? ("PARTIALLY_REFUNDED" as const) : ("PAID" as const),
        fulfillmentStatus: "FULFILLED" as const,
        cancelledAt: null,
        cancelReason: null,
        providerCreatedAt: null,
        providerUpdatedAt: new Date("2026-08-26T04:39:24.783Z"),
        lineItems: [],
        attributionToken: null,
      },
      warnings: [],
      refundReconciliationOutcome: "RECONCILED" as const,
      refundReconciliationReason: null,
    });

    const deps = {
      loadConnection: async () => backfillRow(),
      fetchOrders: async () => ({
        orders: [rawOrder({ id: "order-1002" }), rawOrder({ id: "order-1003" })],
        total: 2,
      }),
      // Both the root entry and the child entry resolve (via
      // prepareOrder) to the SAME root order id and the SAME reconciled
      // refund amount — exactly what the real classify/reconcile pipeline
      // produces regardless of which raw entry triggered it (see
      // commerce7-order-refund-reconciliation.test.ts's own "Case C" test
      // for the unit-level proof of this convergence).
      prepareOrder: async () => rootReadyResult(BigInt(3277)),
      ingest: async (_event: unknown, order: { externalOrderId: string | null }) => {
        ingestedOrderIds.push(order.externalOrderId!);
        return {
          status: "UPDATED" as const,
          reason: null,
          eventId: "evt",
          orderId: "row-1002",
          lineItemCount: 0,
          attributionLinked: false,
          brandIdOverriddenFromConnection: false,
        };
      },
    };

    const outcome = await backfillCommerce7Orders(
      {
        brandId: "brand-a",
        connectionId: "conn-1",
        updatedAtGte: new Date("2026-08-01"),
        updatedAtLte: new Date("2026-08-31"),
      },
      deps,
    );

    // Exactly ONE ingest write for the root, from a page containing two
    // raw entries that both resolve to it.
    assert.deepEqual(ingestedOrderIds, ["order-1002"]);
    assert.equal(outcome.ordersProcessed, 1);

    // Re-running the identical page is fully idempotent.
    ingestedOrderIds.length = 0;
    const secondRun = await backfillCommerce7Orders(
      {
        brandId: "brand-a",
        connectionId: "conn-1",
        updatedAtGte: new Date("2026-08-01"),
        updatedAtLte: new Date("2026-08-31"),
      },
      deps,
    );
    assert.deepEqual(ingestedOrderIds, ["order-1002"]);
    assert.equal(secondRun.ordersProcessed, 1);
  });
});
