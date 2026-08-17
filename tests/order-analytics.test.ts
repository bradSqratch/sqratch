import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommerceProvider } from "@prisma/client";
import { buildConversionAnalytics } from "../src/lib/commerce/order-analytics";

const BRAND_CONVERSIONS_ROUTE = join(
  process.cwd(),
  "src/app/api/brand/analytics/conversions/route.ts",
);
const CREATOR_CONVERSIONS_ROUTE = join(
  process.cwd(),
  "src/app/api/creator/analytics/conversions/route.ts",
);

test("conversion analytics excludes unattributed orders from conversion values and preserves gross/refund/net", () => {
  const result = buildConversionAnalytics([
    {
      provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", currencyCode: "USD", totalMinor: BigInt(1000), totalRefundedMinor: BigInt(250), netRevenueMinor: BigInt(750),
      attribution: { entryCampaignId: "entry-a", productCampaignId: "product-a", experienceId: "experience-a", creatorProfileId: "creator-a", lessonId: "lesson-a", connectedProductId: "catalog-a" },
      lineItems: [{ connectedProductId: "catalog-a" }],
    },
    {
      provider: CommerceProvider.COMMERCE7, financialStatus: "PAID", currencyCode: "USD", totalMinor: BigInt(900), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(900),
      attribution: null, lineItems: [],
    },
  ]);
  assert.equal(result.totalIngestedOrders, 2);
  assert.equal(result.attributedOrders, 1);
  assert.equal(result.currentlyNetPositivePaidOrders, 1);
  assert.deepEqual(result.grossAttributedRevenueByCurrency, [{ currencyCode: "USD", minor: "1000" }]);
  assert.deepEqual(result.refundedRevenueByCurrency, [{ currencyCode: "USD", minor: "250" }]);
  assert.deepEqual(result.netAttributedRevenueByCurrency, [{ currencyCode: "USD", minor: "750" }]);
  assert.deepEqual(result.attributedOrdersByProvider, [{ id: "SHOPIFY", orders: 1 }]);
  assert.deepEqual(result.attributedOrdersByLesson, [{ id: "lesson-a", orders: 1 }]);
});

test("conversion analytics separates historical attribution from current financial state", () => {
  const base = {
    provider: CommerceProvider.SHOPIFY,
    currencyCode: "USD",
    totalMinor: BigInt(1000),
    totalRefundedMinor: BigInt(0),
    attribution: { entryCampaignId: null, productCampaignId: null, experienceId: "x", creatorProfileId: "c", lessonId: null, connectedProductId: "p" },
    lineItems: [],
  };
  const result = buildConversionAnalytics([
    { ...base, financialStatus: "PAID", netRevenueMinor: BigInt(1000) },
    { ...base, financialStatus: "PARTIALLY_PAID", netRevenueMinor: BigInt(500) },
    { ...base, financialStatus: "PARTIALLY_REFUNDED", totalRefundedMinor: BigInt(400), netRevenueMinor: BigInt(600) },
    { ...base, financialStatus: "REFUNDED", totalRefundedMinor: BigInt(1000), netRevenueMinor: BigInt(0) },
    { ...base, financialStatus: "PENDING", netRevenueMinor: BigInt(1000) },
    { ...base, financialStatus: "AUTHORIZED", netRevenueMinor: BigInt(1000) },
    { ...base, financialStatus: "VOIDED", netRevenueMinor: BigInt(0) },
  ]);
  assert.equal(result.attributedOrders, 7);
  assert.equal(result.currentlyNetPositivePaidOrders, 3);
  assert.equal(result.pendingOrAuthorizedOrders, 2);
  assert.equal(result.partiallyRefundedOrders, 1);
  assert.equal(result.fullyRefundedOrders, 1);
  assert.deepEqual(result.grossAttributedRevenueByCurrency, [{ currencyCode: "USD", minor: "7000" }]);
  assert.deepEqual(result.refundedRevenueByCurrency, [{ currencyCode: "USD", minor: "1400" }]);
  assert.deepEqual(result.netAttributedRevenueByCurrency, [{ currencyCode: "USD", minor: "2100" }]);
});

test("attributedOrdersByProduct counts each order once per distinct product regardless of repeated line items, falls back to the attribution product when no line items resolved, drops null product ids, and is not payment-gated", () => {
  const result = buildConversionAnalytics([
    {
      // Same connectedProductId repeated across multiple line items must count
      // as ONE attributed order for that product, not one per line item.
      provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", currencyCode: "USD", totalMinor: BigInt(500), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(500),
      attribution: { entryCampaignId: "entry-a", productCampaignId: "product-a", experienceId: "experience-a", creatorProfileId: "creator-a", lessonId: "lesson-a", connectedProductId: "prod-1" },
      lineItems: [{ connectedProductId: "prod-1" }, { connectedProductId: "prod-1" }, { connectedProductId: "prod-2" }],
    },
    {
      // Non-PAID financial status: attributedOrdersByProduct is not payment-gated
      // (only currentlyNetPositivePaidOrders is), so this order still contributes to prod-1.
      provider: CommerceProvider.SHOPIFY, financialStatus: "PENDING", currencyCode: "USD", totalMinor: BigInt(300), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(300),
      attribution: { entryCampaignId: "entry-b", productCampaignId: "product-b", experienceId: "experience-b", creatorProfileId: "creator-b", lessonId: "lesson-b", connectedProductId: "prod-1" },
      lineItems: [{ connectedProductId: "prod-1" }],
    },
    {
      // No resolved line items: falls back to the click's attributed product.
      provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", currencyCode: "USD", totalMinor: BigInt(200), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(200),
      attribution: { entryCampaignId: "entry-c", productCampaignId: "product-c", experienceId: "experience-c", creatorProfileId: "creator-c", lessonId: "lesson-c", connectedProductId: "prod-3" },
      lineItems: [],
    },
    {
      // Null connectedProductId on the only line item is dropped, not bucketed.
      provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", currencyCode: "USD", totalMinor: BigInt(100), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(100),
      attribution: { entryCampaignId: "entry-d", productCampaignId: "product-d", experienceId: "experience-d", creatorProfileId: "creator-d", lessonId: "lesson-d", connectedProductId: null },
      lineItems: [{ connectedProductId: null }],
    },
  ]);

  assert.equal(result.attributedOrders, 4);
  assert.equal(result.currentlyNetPositivePaidOrders, 3);
  assert.deepEqual(result.attributedOrdersByProduct, [
    { id: "prod-1", orders: 2 },
    { id: "prod-2", orders: 1 },
    { id: "prod-3", orders: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// Currency safety — the Phase 12.3 live-QA regression. Every money figure
// MUST be grouped by currency; a brand/creator whose orders span more than
// one currency must never see them silently added into one unlabeled total.
// ---------------------------------------------------------------------------

describe("currency-coded analytics never mix multiple currencies into one total", () => {
  test("orders in two different currencies produce two separate currency entries, never one summed number", () => {
    const result = buildConversionAnalytics([
      {
        // The exact live-QA shape: a CAD-denominated order.
        provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", currencyCode: "CAD", totalMinor: BigInt(132257), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(132257),
        attribution: { entryCampaignId: null, productCampaignId: null, experienceId: "x", creatorProfileId: "c", lessonId: null, connectedProductId: "p" },
        lineItems: [],
      },
      {
        provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", currencyCode: "USD", totalMinor: BigInt(95300), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(95300),
        attribution: { entryCampaignId: null, productCampaignId: null, experienceId: "x", creatorProfileId: "c", lessonId: null, connectedProductId: "p" },
        lineItems: [],
      },
    ]);

    assert.equal(result.attributedOrders, 2);
    // Two currencies present -> two rows, ascending by code. NEVER a single
    // BigInt sum of 132257 + 95300 = 227557, which would be denominated in
    // nothing (neither CAD nor USD).
    assert.deepEqual(result.grossAttributedRevenueByCurrency, [
      { currencyCode: "CAD", minor: "132257" },
      { currencyCode: "USD", minor: "95300" },
    ]);
    assert.deepEqual(result.netAttributedRevenueByCurrency, [
      { currencyCode: "CAD", minor: "132257" },
      { currencyCode: "USD", minor: "95300" },
    ]);
    // No entry anywhere sums to 227557 — the two totals are never combined.
    const allMinorValues = [
      ...result.grossAttributedRevenueByCurrency.map((r) => r.minor),
      ...result.netAttributedRevenueByCurrency.map((r) => r.minor),
    ];
    assert.ok(!allMinorValues.includes("227557"), "the two currencies must never be summed together");
  });

  test("P12.4 live-case: order #1002 after its full CAD/USD refund reports gross CAD 132257, refunded CAD 132257, net CAD absent (fully refunded is not currently net-positive) — presentment USD 95300 never appears anywhere", () => {
    const result = buildConversionAnalytics([
      {
        provider: CommerceProvider.SHOPIFY, financialStatus: "REFUNDED", currencyCode: "CAD", totalMinor: BigInt(132257), totalRefundedMinor: BigInt(132257), netRevenueMinor: BigInt(0),
        attribution: { entryCampaignId: null, productCampaignId: null, experienceId: "x", creatorProfileId: "c", lessonId: null, connectedProductId: "p" },
        lineItems: [],
      },
    ]);
    assert.deepEqual(result.grossAttributedRevenueByCurrency, [{ currencyCode: "CAD", minor: "132257" }]);
    assert.deepEqual(result.refundedRevenueByCurrency, [{ currencyCode: "CAD", minor: "132257" }]);
    // A fully-refunded order is not "currently net-positive" (net is zero),
    // so it contributes no row here — never a fabricated {CAD, 0} either.
    assert.deepEqual(result.netAttributedRevenueByCurrency, []);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('"USD"'), "the presentment currency must never appear in this order's analytics");
    assert.ok(!serialized.includes("95300"), "the presentment-currency minor amount must never appear");
    assert.equal(result.fullyRefundedOrders, 1);
  });

  test("multiple orders in the SAME currency are still summed together within that currency", () => {
    const base = {
      provider: CommerceProvider.SHOPIFY,
      currencyCode: "CAD",
      financialStatus: "PAID" as const,
      totalRefundedMinor: BigInt(0),
      attribution: { entryCampaignId: null, productCampaignId: null, experienceId: "x", creatorProfileId: "c", lessonId: null, connectedProductId: "p" },
      lineItems: [],
    };
    const result = buildConversionAnalytics([
      { ...base, totalMinor: BigInt(1000), netRevenueMinor: BigInt(1000) },
      { ...base, totalMinor: BigInt(2000), netRevenueMinor: BigInt(2000) },
    ]);
    assert.deepEqual(result.grossAttributedRevenueByCurrency, [{ currencyCode: "CAD", minor: "3000" }]);
  });

  test("an order with an unresolvable currency (null) is bucketed as UNKNOWN, never coalesced into a real currency and never silently dropped", () => {
    const result = buildConversionAnalytics([
      {
        provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", currencyCode: "CAD", totalMinor: BigInt(1000), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(1000),
        attribution: { entryCampaignId: null, productCampaignId: null, experienceId: "x", creatorProfileId: "c", lessonId: null, connectedProductId: "p" },
        lineItems: [],
      },
      {
        provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", currencyCode: null, totalMinor: BigInt(500), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(500),
        attribution: { entryCampaignId: null, productCampaignId: null, experienceId: "x", creatorProfileId: "c", lessonId: null, connectedProductId: "p" },
        lineItems: [],
      },
    ]);
    assert.deepEqual(result.grossAttributedRevenueByCurrency, [
      { currencyCode: "CAD", minor: "1000" },
      { currencyCode: "UNKNOWN", minor: "500" },
    ]);
  });

  test("three or more currencies each get their own entry, sorted ascending", () => {
    const mk = (currencyCode: string, amount: number) => ({
      provider: CommerceProvider.SHOPIFY, financialStatus: "PAID" as const, currencyCode, totalMinor: BigInt(amount), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(amount),
      attribution: { entryCampaignId: null, productCampaignId: null, experienceId: "x", creatorProfileId: "c", lessonId: null, connectedProductId: "p" },
      lineItems: [],
    });
    const result = buildConversionAnalytics([mk("EUR", 300), mk("CAD", 100), mk("USD", 200)]);
    assert.deepEqual(result.grossAttributedRevenueByCurrency, [
      { currencyCode: "CAD", minor: "100" },
      { currencyCode: "EUR", minor: "300" },
      { currencyCode: "USD", minor: "200" },
    ]);
  });

  test("refunded and net revenue are ALSO grouped by currency independently, never cross-mixed with gross", () => {
    const result = buildConversionAnalytics([
      {
        provider: CommerceProvider.SHOPIFY, financialStatus: "PARTIALLY_REFUNDED", currencyCode: "CAD", totalMinor: BigInt(1000), totalRefundedMinor: BigInt(300), netRevenueMinor: BigInt(700),
        attribution: { entryCampaignId: null, productCampaignId: null, experienceId: "x", creatorProfileId: "c", lessonId: null, connectedProductId: "p" },
        lineItems: [],
      },
      {
        provider: CommerceProvider.SHOPIFY, financialStatus: "PARTIALLY_REFUNDED", currencyCode: "USD", totalMinor: BigInt(2000), totalRefundedMinor: BigInt(400), netRevenueMinor: BigInt(1600),
        attribution: { entryCampaignId: null, productCampaignId: null, experienceId: "x", creatorProfileId: "c", lessonId: null, connectedProductId: "p" },
        lineItems: [],
      },
    ]);
    assert.deepEqual(result.grossAttributedRevenueByCurrency, [
      { currencyCode: "CAD", minor: "1000" },
      { currencyCode: "USD", minor: "2000" },
    ]);
    assert.deepEqual(result.refundedRevenueByCurrency, [
      { currencyCode: "CAD", minor: "300" },
      { currencyCode: "USD", minor: "400" },
    ]);
    assert.deepEqual(result.netAttributedRevenueByCurrency, [
      { currencyCode: "CAD", minor: "700" },
      { currencyCode: "USD", minor: "1600" },
    ]);
  });

  test("source lock: no flat unlabeled money field survives in the aggregator's output shape", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/commerce/order-analytics.ts"),
      "utf8",
    );
    // The old, currency-blind field names must never come back.
    for (const staleField of [
      "grossAttributedRevenueMinor",
      "refundedRevenueMinor",
      "netAttributedRevenueMinor",
      "attributedOrderValueMinor",
      "attributedRefundedValueMinor",
      "attributedNetRevenueMinor",
      "paidAttributedOrders",
    ]) {
      assert.doesNotMatch(source, new RegExp(`\\b${staleField}\\b`), `stale currency-unsafe field must not reappear: ${staleField}`);
    }
    assert.match(source, /grossAttributedRevenueByCurrency/);
    assert.match(source, /refundedRevenueByCurrency/);
    assert.match(source, /netAttributedRevenueByCurrency/);
  });
});

// ---------------------------------------------------------------------------
// Tenant disclosure: the aggregator has no tenant identity, so redaction is the
// route's job and works by NULLING a dimension before aggregation.
// ---------------------------------------------------------------------------

test("a nulled dimension is dropped from its breakdown entirely — the mechanism both conversion routes redact with", () => {
  const result = buildConversionAnalytics([
    {
      provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", currencyCode: "USD", totalMinor: BigInt(1000), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(1000),
      // A foreign entry campaign (redacted by the brand route) and a creator
      // view (both campaign ids redacted, line items withheld).
      attribution: { entryCampaignId: null, productCampaignId: null, experienceId: "experience-a", creatorProfileId: "creator-a", lessonId: "lesson-a", connectedProductId: "prod-1" },
      lineItems: [],
    },
  ]);

  assert.equal(result.attributedOrders, 1);
  assert.deepEqual(result.attributedOrdersByEntryCampaign, []);
  assert.deepEqual(result.attributedOrdersByProductCampaign, []);
  // The creator still gets the dimension they own: the product they drove
  // traffic to, resolved from the click rather than from the order's basket.
  assert.deepEqual(result.attributedOrdersByProduct, [{ id: "prod-1", orders: 1 }]);
  assert.deepEqual(result.attributedOrdersByExperience, [{ id: "experience-a", orders: 1 }]);
});

test("the creator conversions route selects and forwards currencyCode (source inspection)", () => {
  const source = readFileSync(CREATOR_CONVERSIONS_ROUTE, "utf8");
  assert.match(source, /currencyCode:\s*true/);
  assert.match(source, /currencyCode:\s*row\.currencyCode/);
});

test("the brand conversions route selects and forwards currencyCode (source inspection)", () => {
  const source = readFileSync(BRAND_CONVERSIONS_ROUTE, "utf8");
  assert.match(source, /currencyCode:\s*true/);
  assert.match(source, /currencyCode:\s*row\.currencyCode/);
});

test("the creator conversions route never reads a campaign id or an order line item (source inspection)", () => {
  const source = readFileSync(CREATOR_CONVERSIONS_ROUTE, "utf8");
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // A column that is never selected cannot be leaked by a later refactor of
  // the shared aggregator: no campaign id and no campaign relation is read out
  // of the click row, and no order line item is read at all.
  assert.doesNotMatch(executable, /entryCampaignId:\s*true/);
  assert.doesNotMatch(executable, /productCampaignId:\s*true/);
  assert.doesNotMatch(executable, /entryCampaign:\s*\{/);
  assert.doesNotMatch(executable, /productCampaign:\s*\{/);
  assert.doesNotMatch(executable, /lineItems:\s*\{/);
  // Both campaign dimensions are explicitly nulled on the way into the builder.
  assert.match(executable, /entryCampaignId:\s*null/);
  assert.match(executable, /productCampaignId:\s*null/);
  assert.match(executable, /lineItems:\s*\[\]/);
  // Scope comes from the authenticated creator profile, never request input.
  assert.match(executable, /creatorProfileId:\s*context\.creatorProfile\.id/);
});

test("the brand conversions route only emits a campaign id that the requesting brand owns (source inspection)", () => {
  const source = readFileSync(BRAND_CONVERSIONS_ROUTE, "utf8");
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // The owner is selected alongside the id, and the id only survives the
  // ownership comparison.
  assert.match(executable, /entryCampaign:\s*\{\s*select:\s*\{\s*id:\s*true,\s*brandId:\s*true\s*\}\s*\}/);
  assert.match(executable, /productCampaign:\s*\{\s*select:\s*\{\s*id:\s*true,\s*brandId:\s*true\s*\}\s*\}/);
  assert.match(executable, /campaign\.brandId === brandId \? campaign\.id : null/);
  assert.match(executable, /entryCampaignId:\s*ownedCampaignId\(/);
  assert.match(executable, /productCampaignId:\s*ownedCampaignId\(/);
  // No bare campaign id is ever selected straight out of the click row.
  assert.doesNotMatch(executable, /entryCampaignId:\s*true/);
  assert.doesNotMatch(executable, /productCampaignId:\s*true/);
});
