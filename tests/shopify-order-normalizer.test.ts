process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/shopify-order-normalizer.test.ts
 *
 * Unit tests for the PURE Shopify order/refund normalizer
 * (`src/lib/commerce/providers/shopify-order-normalizer.ts`). No I/O, no
 * Prisma, no network — every test calls the exported pure functions directly
 * against hand-built fixture payloads.
 *
 * Covered cases (numbered to match the task's review checklist):
 *  6.  Variant mapping — externalVariantId/externalProductId extracted correctly.
 *  8.  Integer money precision — "49.99" converts via the real decimalStringToMinorUnits.
 *  9.  Zero-decimal currency (JPY) converts with exponent 0.
 *  10. Three-decimal currency (KWD) converts with exponent 3.
 *  11. Discounts normalized to discountsMinor.
 *  12. Tax normalized to taxMinor.
 *  13. Shipping normalized to shippingMinor.
 *  14/15/16 groundwork: FULL vs PARTIAL, refund derivation, cancellation
 *      fields — full end-to-end behavior through ingestion is proven in
 *      tests/order-ingestion.test.ts and tests/shopify-order-webhook.test.ts;
 *      this file proves the NORMALIZER half in isolation.
 *  29. PII exclusion — the most important test in this file: a fixture that
 *      DOES contain a full customer/billing_address/shipping_address block
 *      never surfaces in the normalized output.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeShopifyOrderPayload,
  normalizeShopifyRefundPayload,
  normalizeShopifyOrderTransactionPayload,
  mapShopifyFinancialStatus,
  mapShopifyFulfillmentStatus,
  readMoneyAmount,
  shopifyOrderHasRefundEvidence,
  extractShopifyAttributionToken,
  computeShopifyPayloadDigest,
  SHOPIFY_ORDER_PII_KEYS,
} from "../src/lib/commerce/providers/shopify-order-normalizer";

const CONTEXT = { connectionId: "conn-1", brandId: "brand-1" };

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/** A realistic Shopify orders/create-shaped payload, minus anything PII. */
function baseOrderFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 820982911946154500,
    order_number: 1001,
    name: "#1001",
    currency: "USD",
    financial_status: "paid",
    fulfillment_status: null,
    subtotal_price: "45.00",
    total_discounts: "5.00",
    total_tax: "3.60",
    total_shipping_price_set: { shop_money: { amount: "4.99", currency_code: "USD" } },
    total_price: "48.59",
    cancelled_at: null,
    cancel_reason: null,
    created_at: "2026-08-01T10:00:00-04:00",
    updated_at: "2026-08-01T10:05:00-04:00",
    line_items: [
      {
        id: 866550311766439000,
        product_id: 632910392,
        variant_id: 808950810,
        title: "IPod Nano - 8GB",
        sku: "IPOD-NANO-8GB",
        quantity: 1,
        price: "49.99",
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 6. Variant mapping
// ---------------------------------------------------------------------------

describe("6. line-item variant/product id extraction", () => {
  test("externalVariantId and externalProductId are extracted correctly from a real line-item fixture", () => {
    const result = normalizeShopifyOrderPayload(baseOrderFixture(), CONTEXT);
    assert.equal(result.order.lineItems.length, 1);
    const item = result.order.lineItems[0];
    assert.equal(item.externalProductId, "632910392");
    assert.equal(item.externalVariantId, "808950810");
    assert.equal(item.externalLineItemId, "866550311766439000");
    assert.equal(item.sku, "IPOD-NANO-8GB");
    assert.equal(item.title, "IPod Nano - 8GB");
  });

  test("a malformed line item (not an object) is skipped, not fatal to the order", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({ line_items: [null, "not-an-object", { id: 1, quantity: 1, price: "1.00" }] }),
      CONTEXT,
    );
    assert.equal(result.order.lineItems.length, 1);
    assert.ok(result.warnings.includes("SKIPPED_MALFORMED_LINE_ITEM"));
  });

  test("a line item with a non-numeric quantity is skipped rather than defaulted to 1", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({ line_items: [{ id: 1, quantity: "not-a-number", price: "1.00" }] }),
      CONTEXT,
    );
    assert.equal(result.order.lineItems.length, 0);
    assert.ok(result.warnings.includes("SKIPPED_MALFORMED_LINE_ITEM"));
  });
});

// ---------------------------------------------------------------------------
// 8, 9, 10. Money precision across currency exponents
// ---------------------------------------------------------------------------

describe("8, 9, 10. money conversion uses the real, sign-aware decimalStringToMinorUnits at the correct exponent", () => {
  test("8. USD (exponent 2): '49.99' line price converts to 4999 minor units, via the real converter (not a stub)", () => {
    const result = normalizeShopifyOrderPayload(baseOrderFixture(), CONTEXT);
    assert.equal(result.order.lineItems[0].unitPriceMinor, BigInt(4999));
    assert.equal(result.order.minorUnitExponent, 2);
  });

  test("9. JPY (exponent 0): a whole-number amount converts with no fractional scaling", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({
        currency: "JPY",
        total_price: "1500",
        subtotal_price: "1500",
        line_items: [{ id: 1, product_id: 1, variant_id: 1, quantity: 1, price: "1500" }],
      }),
      CONTEXT,
    );
    assert.equal(result.order.minorUnitExponent, 0);
    assert.equal(result.order.totalMinor, BigInt(1500));
    assert.equal(result.order.lineItems[0].unitPriceMinor, BigInt(1500));
  });

  test("10. KWD (exponent 3): a 3-decimal amount converts to the correct minor-unit integer", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({
        currency: "KWD",
        total_price: "12.345",
        subtotal_price: "12.345",
        line_items: [{ id: 1, product_id: 1, variant_id: 1, quantity: 1, price: "12.345" }],
      }),
      CONTEXT,
    );
    assert.equal(result.order.minorUnitExponent, 3);
    assert.equal(result.order.totalMinor, BigInt(12345));
    assert.equal(result.order.lineItems[0].unitPriceMinor, BigInt(12345));
  });

  test("an unrecognized currency code defaults to exponent 2, never guesses a different value silently", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({ currency: "XYZ", total_price: "10.00" }),
      CONTEXT,
    );
    assert.equal(result.order.minorUnitExponent, 2);
    assert.equal(result.order.totalMinor, BigInt(1000));
  });

  test("an unresolvable currency nulls ALL six money fields, not just currencyCode/minorUnitExponent", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({
        currency: undefined,
        presentment_currency: undefined,
        total_price: "10.00",
        subtotal_price: "10.00",
        total_discounts: "1.00",
        total_tax: "0.50",
      }),
      CONTEXT,
    );
    assert.ok(result.warnings.includes("MISSING_CURRENCY"));
    assert.equal(result.order.currencyCode, null);
    assert.equal(result.order.minorUnitExponent, null);
    // A defaulted exponent must never be used to compute a "real-looking"
    // amount paired with a null currency — every money field is nulled
    // together, or none are. See shopify-order-normalizer.ts's moneyFields.
    assert.equal(result.order.subtotalMinor, null);
    assert.equal(result.order.discountsMinor, null);
    assert.equal(result.order.shippingMinor, null);
    assert.equal(result.order.taxMinor, null);
    assert.equal(result.order.totalMinor, null);
    assert.equal(result.order.totalRefundedMinor, null);
  });

  test("readMoneyAmount handles a bare decimal string, a MoneyBag (shop_money preferred), a bare Money object, and a plain number", () => {
    assert.equal(readMoneyAmount("19.99"), "19.99");
    assert.equal(
      readMoneyAmount({ shop_money: { amount: "19.99", currency_code: "USD" }, presentment_money: { amount: "25.00", currency_code: "CAD" } }),
      "19.99",
    );
    assert.equal(readMoneyAmount({ presentment_money: { amount: "25.00", currency_code: "CAD" } }), "25.00");
    assert.equal(readMoneyAmount({ amount: "5.00" }), "5.00");
    assert.equal(readMoneyAmount(19.99), "19.99");
    assert.equal(readMoneyAmount(null), null);
    assert.equal(readMoneyAmount(undefined), null);
    assert.equal(readMoneyAmount({}), null);
  });
});

// ---------------------------------------------------------------------------
// 11, 12, 13. Discounts / tax / shipping
// ---------------------------------------------------------------------------

describe("11, 12, 13. discounts, tax, and shipping normalize independently and correctly", () => {
  test("discountsMinor, taxMinor, and shippingMinor are each converted from their own dedicated field", () => {
    const result = normalizeShopifyOrderPayload(baseOrderFixture(), CONTEXT);
    assert.equal(result.order.discountsMinor, BigInt(500));
    assert.equal(result.order.taxMinor, BigInt(360));
    assert.equal(result.order.shippingMinor, BigInt(499));
    // The order total is the provider's own field, never a sum of these.
    assert.equal(result.order.totalMinor, BigInt(4859));
  });

  test("total_shipping_price_set (a MoneyBag) is read correctly, distinct from the *_price string fields", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({
        total_shipping_price_set: { shop_money: { amount: "12.34", currency_code: "USD" } },
      }),
      CONTEXT,
    );
    assert.equal(result.order.shippingMinor, BigInt(1234));
  });

  test("a missing shipping field yields null, not zero — absence is not the same claim as a free-shipping order", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({ total_shipping_price_set: undefined }),
      CONTEXT,
    );
    assert.equal(result.order.shippingMinor, null);
  });

  test("line-item tax_lines sum into the line's taxMinor", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({
        line_items: [
          {
            id: 1,
            product_id: 1,
            variant_id: 1,
            quantity: 2,
            price: "10.00",
            tax_lines: [{ price: "1.00" }, { price: "0.50" }],
          },
        ],
      }),
      CONTEXT,
    );
    assert.equal(result.order.lineItems[0].taxMinor, BigInt(150));
  });
});

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

describe("financial and fulfillment status mapping", () => {
  test("mapShopifyFinancialStatus covers every neutral member and defaults unrecognized values to null", () => {
    assert.equal(mapShopifyFinancialStatus("pending"), "PENDING");
    assert.equal(mapShopifyFinancialStatus("authorized"), "AUTHORIZED");
    assert.equal(mapShopifyFinancialStatus("partially_paid"), "PARTIALLY_PAID");
    assert.equal(mapShopifyFinancialStatus("paid"), "PAID");
    assert.equal(mapShopifyFinancialStatus("partially_refunded"), "PARTIALLY_REFUNDED");
    assert.equal(mapShopifyFinancialStatus("refunded"), "REFUNDED");
    assert.equal(mapShopifyFinancialStatus("voided"), "VOIDED");
    // Shopify's `expired` has no neutral equivalent and must not be guessed.
    assert.equal(mapShopifyFinancialStatus("expired"), null);
    assert.equal(mapShopifyFinancialStatus(null), null);
    assert.equal(mapShopifyFinancialStatus(undefined), null);
  });

  test("mapShopifyFulfillmentStatus treats a null value as UNFULFILLED only when told the payload is a full snapshot", () => {
    assert.equal(mapShopifyFulfillmentStatus(null, true), "UNFULFILLED");
    assert.equal(mapShopifyFulfillmentStatus(null, false), null);
    assert.equal(mapShopifyFulfillmentStatus("fulfilled", true), "FULFILLED");
    assert.equal(mapShopifyFulfillmentStatus("partial", true), "PARTIALLY_FULFILLED");
    assert.equal(mapShopifyFulfillmentStatus("partially_fulfilled", true), "PARTIALLY_FULFILLED");
    assert.equal(mapShopifyFulfillmentStatus("restocked", true), "RESTOCKED");
    assert.equal(mapShopifyFulfillmentStatus("something-new", true), null);
  });
});

// ---------------------------------------------------------------------------
// 16. Cancellation
// ---------------------------------------------------------------------------

describe("16. cancellation fields normalize onto the order", () => {
  test("cancelled_at and cancel_reason are read straight through on a FULL order payload", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({ cancelled_at: "2026-08-02T00:00:00-04:00", cancel_reason: "customer" }),
      CONTEXT,
    );
    assert.equal(result.order.completeness, "FULL");
    assert.notEqual(result.order.cancelledAt, null);
    assert.equal(result.order.cancelledAt?.toISOString(), new Date("2026-08-02T00:00:00-04:00").toISOString());
    assert.equal(result.order.cancelReason, "customer");
  });

  test("a null cancelled_at on a FULL payload is authoritative (genuinely not cancelled)", () => {
    const result = normalizeShopifyOrderPayload(baseOrderFixture({ cancelled_at: null }), CONTEXT);
    assert.equal(result.order.cancelledAt, null);
  });
});

// ---------------------------------------------------------------------------
// 14/15. Refunds are a SIGNAL, never a normalizer-computed total
// ---------------------------------------------------------------------------

describe("shopifyOrderHasRefundEvidence: the pure refund-evidence signal", () => {
  test("a non-empty refunds[] is evidence", () => {
    assert.equal(shopifyOrderHasRefundEvidence({ refunds: [{ id: 1 }] }), true);
  });

  test("an empty refunds[] is NOT evidence — Shopify is affirmatively saying zero refunds", () => {
    assert.equal(shopifyOrderHasRefundEvidence({ refunds: [] }), false);
  });

  test("an absent refunds key is not evidence", () => {
    assert.equal(shopifyOrderHasRefundEvidence({}), false);
  });

  test("a non-object payload is not evidence", () => {
    assert.equal(shopifyOrderHasRefundEvidence(null), false);
    assert.equal(shopifyOrderHasRefundEvidence("not an object"), false);
  });
});

describe("14/15. a FULL order payload NEVER computes totalRefundedMinor/financialStatus from REST refund evidence — both defer to live reconciliation", () => {
  test("refunds[] present: totalRefundedMinor is null (not a REST-derived guess), financialStatus is ALSO null even though financial_status says 'refunded' — deferring both together avoids ever persisting a contradictory REFUNDED-with-unknown-amount snapshot", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({
        total_price: "1322.57",
        currency: "CAD",
        refunds: [{ id: 1, refund_line_items: [{ subtotal_set: { shop_money: { amount: "610.63", currency_code: "CAD" } } }] }],
        financial_status: "partially_refunded",
      }),
      CONTEXT,
    );
    assert.equal(result.order.totalRefundedMinor, null);
    assert.equal(result.order.financialStatus, null);
    assert.ok(result.warnings.includes("REFUND_CUMULATIVE_UNAVAILABLE"));
    // The immutable, pre-refund total is still trustworthy directly from
    // REST (Shopify: total_price_set is "before returns") and is NOT deferred.
    assert.equal(result.order.totalMinor, BigInt(132257));
    assert.equal(result.order.currencyCode, "CAD");
  });

  test("refunds[] empty: totalRefundedMinor is a confident 0n (Shopify affirmatively says zero refunds), financialStatus reads straight through — no ambiguity to defer", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({ total_price: "48.59", refunds: [], financial_status: "paid" }),
      CONTEXT,
    );
    assert.equal(result.order.totalRefundedMinor, BigInt(0));
    assert.equal(result.order.financialStatus, "PAID");
    assert.ok(!result.warnings.includes("REFUND_CUMULATIVE_UNAVAILABLE"));
  });

  test("refunds key entirely absent: same as empty — confident 0n, financialStatus reads through", () => {
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({ total_price: "48.59", financial_status: "paid" }),
      CONTEXT,
    );
    assert.equal(result.order.totalRefundedMinor, BigInt(0));
    assert.equal(result.order.financialStatus, "PAID");
  });

  test("a presentment-currency transaction amount embedded anywhere in refunds[] is never read by this normalizer at all — the whole payload is deferred to reconciliation the moment refunds[] is non-empty", () => {
    // This exact shape (bare transactions[] reporting the presentment USD
    // amount) is what caused the live P1 under the old REST-summing design.
    // The new design never inspects refund sub-fields at all.
    const result = normalizeShopifyOrderPayload(
      baseOrderFixture({
        currency: "CAD",
        total_price: "1322.57",
        refunds: [{ transactions: [{ status: "success", amount: "953.00", currency: "USD" }] }],
        financial_status: "refunded",
      }),
      CONTEXT,
    );
    assert.equal(result.order.totalRefundedMinor, null);
    assert.equal(result.order.financialStatus, null);
  });
});

describe("normalizeShopifyRefundPayload: always a signal, never financial truth", () => {
  test("a bare refunds/create fragment (no embedded order) is PARTIAL and cannot fabricate a cumulative refund total — it flags REFUND_CUMULATIVE_UNAVAILABLE and leaves totalRefundedMinor null so the ingestion service preserves the stored figure", () => {
    const refundFixture = {
      id: 1,
      order_id: 450789469,
      created_at: "2026-08-03T00:00:00-04:00",
      processed_at: "2026-08-03T00:00:05-04:00",
      transactions: [{ status: "success", amount: "10.00" }],
    };
    const result = normalizeShopifyRefundPayload(refundFixture, CONTEXT);
    assert.equal(result.order.completeness, "PARTIAL");
    assert.equal(result.order.externalOrderId, "450789469");
    assert.equal(result.order.totalRefundedMinor, null);
    assert.ok(result.warnings.includes("REFUND_CUMULATIVE_UNAVAILABLE"));
    // Every other field stays null so the ingestion service's PARTIAL `pick`
    // preserves whatever is already stored for this order.
    assert.equal(result.order.currencyCode, null);
    assert.equal(result.order.financialStatus, null);
    assert.equal(result.order.lineItems.length, 0);
  });

  test("a refund payload that embeds its parent order object uses that order for every OTHER field (line items, cancellation) — but its financial fields are STILL deferred, exactly like any other FULL payload with refunds[] present", () => {
    const refundFixture = {
      id: 1,
      processed_at: "2026-08-03T00:00:05-04:00",
      order: baseOrderFixture({
        refunds: [{ id: 1 }],
        financial_status: "refunded",
        line_items: [
          { id: 1, product_id: 1, variant_id: 1, quantity: 1, price: "48.59" },
        ],
      }),
    };
    const result = normalizeShopifyRefundPayload(refundFixture, CONTEXT);
    assert.equal(result.order.completeness, "FULL");
    assert.equal(result.order.totalRefundedMinor, null);
    assert.equal(result.order.financialStatus, null);
    assert.ok(result.warnings.includes("REFUND_CUMULATIVE_UNAVAILABLE"));
    // The embed is still useful: every non-financial field is real.
    assert.equal(result.order.lineItems.length, 1);
    // The refund's own processed_at wins as the ordering timestamp.
    assert.equal(
      result.order.providerUpdatedAt?.toISOString(),
      new Date("2026-08-03T00:00:05-04:00").toISOString(),
    );
  });
});

describe("normalizeShopifyOrderTransactionPayload: order_transactions/create is a bare order-id-only signal", () => {
  test("extracts externalOrderId from order_id, PARTIAL, financial fields null, REFUND_CUMULATIVE_UNAVAILABLE warning", () => {
    const result = normalizeShopifyOrderTransactionPayload(
      {
        id: 42,
        order_id: 5551,
        kind: "refund",
        status: "success",
        processed_at: "2026-08-15T12:00:10-04:00",
      },
      CONTEXT,
    );
    assert.equal(result.order.completeness, "PARTIAL");
    assert.equal(result.order.externalOrderId, "5551");
    assert.equal(result.order.totalRefundedMinor, null);
    assert.equal(result.order.financialStatus, null);
    assert.ok(result.warnings.includes("REFUND_CUMULATIVE_UNAVAILABLE"));
    assert.equal(
      result.order.providerUpdatedAt?.toISOString(),
      new Date("2026-08-15T12:00:10-04:00").toISOString(),
    );
  });

  test("falls back to created_at when processed_at is absent", () => {
    const result = normalizeShopifyOrderTransactionPayload(
      { id: 42, order_id: 5551, created_at: "2026-08-15T11:00:00-04:00" },
      CONTEXT,
    );
    assert.equal(
      result.order.providerUpdatedAt?.toISOString(),
      new Date("2026-08-15T11:00:00-04:00").toISOString(),
    );
  });

  test("a missing order_id is flagged MISSING_ORDER_ID, externalOrderId null", () => {
    const result = normalizeShopifyOrderTransactionPayload({ id: 42 }, CONTEXT);
    assert.equal(result.order.externalOrderId, null);
    assert.ok(result.warnings.includes("MISSING_ORDER_ID"));
  });

  test("a non-object payload is PAYLOAD_NOT_AN_OBJECT, never throws", () => {
    const result = normalizeShopifyOrderTransactionPayload(null, CONTEXT);
    assert.ok(result.warnings.includes("PAYLOAD_NOT_AN_OBJECT"));
    assert.equal(result.order.externalOrderId, null);
  });

  test("never reads a money field — this topic's payload is never treated as a financial source, even when it looks money-shaped", () => {
    const result = normalizeShopifyOrderTransactionPayload(
      { id: 42, order_id: 5551, amount: "953.00", currency: "USD" },
      CONTEXT,
    );
    assert.equal(result.order.totalMinor, null);
    assert.equal(result.order.currencyCode, null);
  });
});

// ---------------------------------------------------------------------------
// Attribution token extraction
// ---------------------------------------------------------------------------

describe("extractShopifyAttributionToken", () => {
  const VALID_TOKEN = "a".repeat(43);

  // The cart-attribute key Shopify carries into the order is underscore-
  // prefixed (`_sqratch_ref`); the bare `sqratch_ref` below is SQRATCH's own
  // URL query parameter, which is deliberately a different, distrusted source.
  test("finds the namespaced token in durable cart/order attributes", () => {
    const payload = { note_attributes: [{ name: "_sqratch_ref", value: VALID_TOKEN }] };
    assert.equal(extractShopifyAttributionToken(payload), VALID_TOKEN);
  });

  test("does not trust a landing-site query parameter as order evidence", () => {
    const payload = { landing_site: `/products/x?sqratch_ref=${VALID_TOKEN}` };
    assert.equal(extractShopifyAttributionToken(payload), null);
  });

  test("the pre-rename bare cart-attribute key is no longer accepted as the attribution attribute", () => {
    const payload = { note_attributes: [{ name: "sqratch_ref", value: VALID_TOKEN }] };
    assert.equal(extractShopifyAttributionToken(payload), null);
  });

  test("an obviously malformed candidate (wrong length) is rejected by the format screen and yields null", () => {
    const payload = { note_attributes: [{ name: "_sqratch_ref", value: "too-short" }] };
    assert.equal(extractShopifyAttributionToken(payload), null);
  });

  test("no token anywhere yields null", () => {
    assert.equal(extractShopifyAttributionToken({}), null);
    assert.equal(extractShopifyAttributionToken(null), null);
  });
});

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

describe("computeShopifyPayloadDigest", () => {
  test("is a deterministic SHA-256 hex digest of the exact raw bytes", () => {
    const digestA = computeShopifyPayloadDigest('{"id":1}');
    const digestB = computeShopifyPayloadDigest('{"id":1}');
    const digestC = computeShopifyPayloadDigest('{"id":2}');
    assert.equal(digestA, digestB);
    assert.notEqual(digestA, digestC);
    assert.match(digestA, /^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 29. PII exclusion — THE MOST IMPORTANT TEST IN THIS FILE
// ---------------------------------------------------------------------------

describe("29. no customer PII ever survives normalization, even when the fixture is deliberately loaded with it", () => {
  test("SHOPIFY_ORDER_PII_KEYS is non-empty and covers email/name/address/phone-shaped keys", () => {
    assert.ok(SHOPIFY_ORDER_PII_KEYS.length > 0);
    for (const expected of ["customer", "billing_address", "shipping_address", "email", "phone"]) {
      assert.ok(
        SHOPIFY_ORDER_PII_KEYS.includes(expected),
        `expected SHOPIFY_ORDER_PII_KEYS to include "${expected}"`,
      );
    }
  });

  test("a realistic malicious/full payload carrying customer, billing_address, shipping_address, email, phone, customer_locale, browser_ip, and client_details never leaks any of it into the normalized output", () => {
    const maliciousPayload = baseOrderFixture({
      email: "victim@example.com",
      contact_email: "victim@example.com",
      phone: "+1-555-0100",
      customer_locale: "en-US",
      browser_ip: "203.0.113.42",
      client_details: {
        browser_ip: "203.0.113.42",
        user_agent: "Mozilla/5.0 (evidence of a real visitor)",
        session_hash: "abc123",
      },
      customer: {
        id: 999,
        email: "victim@example.com",
        first_name: "Alice",
        last_name: "Victim",
        phone: "+1-555-0100",
        default_address: {
          address1: "123 Main St",
          city: "Springfield",
          zip: "00000",
        },
      },
      billing_address: {
        first_name: "Alice",
        last_name: "Victim",
        address1: "123 Main St",
        city: "Springfield",
        phone: "+1-555-0100",
      },
      shipping_address: {
        first_name: "Alice",
        last_name: "Victim",
        address1: "123 Main St",
        city: "Springfield",
        phone: "+1-555-0100",
      },
    });

    const result = normalizeShopifyOrderPayload(maliciousPayload, CONTEXT);

    // Behavioral assertion, not merely a type check: walk the ENTIRE
    // serialized output and confirm none of the injected PII VALUES survived
    // anywhere in it (a value-level check catches a PII field being copied
    // under an unexpected key, which a key-name-only check would miss).
    const serialized = JSON.stringify(result.order, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    for (const leak of [
      "victim@example.com",
      "+1-555-0100",
      "Alice",
      "Victim",
      "123 Main St",
      "Springfield",
      "203.0.113.42",
      "en-US",
      "abc123",
      "Mozilla/5.0",
    ]) {
      assert.doesNotMatch(serialized, new RegExp(leak.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }

    // And structurally: none of the deny-listed keys exist as a property
    // anywhere on the returned object (shallow — the type has no nested
    // object fields that could hide one).
    for (const key of SHOPIFY_ORDER_PII_KEYS) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(result.order, key),
        false,
        `normalized order must never carry a "${key}" property`,
      );
    }

    // Order-legitimate identifiers (not PII) DID come through, proving the
    // exclusion is deliberate and scoped, not an accidental empty result.
    assert.equal(result.order.externalOrderId, "820982911946154500");
    assert.equal(result.order.orderNumber, "1001");
  });

  test("the normalizer's own source never reads any of the deny-listed keys off the payload record (source inspection, belt-and-suspenders)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "src/lib/commerce/providers/shopify-order-normalizer.ts"),
      "utf8",
    );
    for (const key of ["order.customer", "order.billing_address", "order.shipping_address", "order.email", "order.phone", "order.client_details"]) {
      assert.doesNotMatch(source, new RegExp(key.replace(".", "\\.")));
    }
  });
});
