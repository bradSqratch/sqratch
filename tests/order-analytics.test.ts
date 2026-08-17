import assert from "node:assert/strict";
import { test } from "node:test";
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
      provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", totalMinor: BigInt(1000), totalRefundedMinor: BigInt(250), netRevenueMinor: BigInt(750),
      attribution: { entryCampaignId: "entry-a", productCampaignId: "product-a", experienceId: "experience-a", creatorProfileId: "creator-a", lessonId: "lesson-a", connectedProductId: "catalog-a" },
      lineItems: [{ connectedProductId: "catalog-a" }],
    },
    {
      provider: CommerceProvider.COMMERCE7, financialStatus: "PAID", totalMinor: BigInt(900), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(900),
      attribution: null, lineItems: [],
    },
  ]);
  assert.equal(result.totalIngestedOrders, 2);
  assert.equal(result.attributedOrders, 1);
  assert.equal(result.paidAttributedOrders, 1);
  assert.equal(result.attributedOrderValueMinor, "1000");
  assert.equal(result.attributedRefundedValueMinor, "250");
  assert.equal(result.attributedNetRevenueMinor, "750");
  assert.equal(result.grossAttributedRevenueMinor, "1000");
  assert.equal(result.refundedRevenueMinor, "250");
  assert.equal(result.netAttributedRevenueMinor, "750");
  assert.deepEqual(result.attributedOrdersByProvider, [{ id: "SHOPIFY", orders: 1 }]);
  assert.deepEqual(result.attributedOrdersByLesson, [{ id: "lesson-a", orders: 1 }]);
});

test("conversion analytics separates historical attribution from current financial state", () => {
  const base = {
    provider: CommerceProvider.SHOPIFY,
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
  assert.equal(result.grossAttributedRevenueMinor, "7000");
  assert.equal(result.refundedRevenueMinor, "1400");
  assert.equal(result.netAttributedRevenueMinor, "2100");
});

test("attributedOrdersByProduct counts each order once per distinct product regardless of repeated line items, falls back to the attribution product when no line items resolved, drops null product ids, and is not payment-gated", () => {
  const result = buildConversionAnalytics([
    {
      // Same connectedProductId repeated across multiple line items must count
      // as ONE attributed order for that product, not one per line item.
      provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", totalMinor: BigInt(500), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(500),
      attribution: { entryCampaignId: "entry-a", productCampaignId: "product-a", experienceId: "experience-a", creatorProfileId: "creator-a", lessonId: "lesson-a", connectedProductId: "prod-1" },
      lineItems: [{ connectedProductId: "prod-1" }, { connectedProductId: "prod-1" }, { connectedProductId: "prod-2" }],
    },
    {
      // Non-PAID financial status: attributedOrdersByProduct is not payment-gated
      // (only paidAttributedOrders is), so this order still contributes to prod-1.
      provider: CommerceProvider.SHOPIFY, financialStatus: "PENDING", totalMinor: BigInt(300), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(300),
      attribution: { entryCampaignId: "entry-b", productCampaignId: "product-b", experienceId: "experience-b", creatorProfileId: "creator-b", lessonId: "lesson-b", connectedProductId: "prod-1" },
      lineItems: [{ connectedProductId: "prod-1" }],
    },
    {
      // No resolved line items: falls back to the click's attributed product.
      provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", totalMinor: BigInt(200), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(200),
      attribution: { entryCampaignId: "entry-c", productCampaignId: "product-c", experienceId: "experience-c", creatorProfileId: "creator-c", lessonId: "lesson-c", connectedProductId: "prod-3" },
      lineItems: [],
    },
    {
      // Null connectedProductId on the only line item is dropped, not bucketed.
      provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", totalMinor: BigInt(100), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(100),
      attribution: { entryCampaignId: "entry-d", productCampaignId: "product-d", experienceId: "experience-d", creatorProfileId: "creator-d", lessonId: "lesson-d", connectedProductId: null },
      lineItems: [{ connectedProductId: null }],
    },
  ]);

  assert.equal(result.attributedOrders, 4);
  assert.equal(result.paidAttributedOrders, 3);
  assert.deepEqual(result.attributedOrdersByProduct, [
    { id: "prod-1", orders: 2 },
    { id: "prod-2", orders: 1 },
    { id: "prod-3", orders: 1 },
  ]);
});

// ---------------------------------------------------------------------------
// Tenant disclosure: the aggregator has no tenant identity, so redaction is the
// route's job and works by NULLING a dimension before aggregation.
// ---------------------------------------------------------------------------

test("a nulled dimension is dropped from its breakdown entirely — the mechanism both conversion routes redact with", () => {
  const result = buildConversionAnalytics([
    {
      provider: CommerceProvider.SHOPIFY, financialStatus: "PAID", totalMinor: BigInt(1000), totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(1000),
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
