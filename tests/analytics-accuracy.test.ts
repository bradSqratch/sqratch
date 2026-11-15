import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { CommerceProvider } from "@prisma/client";
import { buildConversionAnalytics, buildConversionDailyTrend } from "../src/lib/commerce/order-analytics";
import { ORDER_VALUE_LABELS } from "../src/lib/commerce/analytics-labels";

const attribution = { entryCampaignId: null, productCampaignId: null, experienceId: "e", creatorProfileId: "c", lessonId: null, connectedProductId: null };
type Status = "PENDING" | "AUTHORIZED" | "PARTIALLY_PAID" | "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | "VOIDED" | null;
const order = (status: Status, total: number, refunded = 0, currency: string | null = "USD", extra: { cancelledAt?: Date } = {}) => ({
  provider: CommerceProvider.SHOPIFY, financialStatus: status, currencyCode: currency,
  totalMinor: BigInt(total), totalRefundedMinor: BigInt(refunded), netRevenueMinor: BigInt(total - refunded),
  attribution, lineItems: [], ...extra,
});

const mixed = [
  order("PENDING", 1000), order("AUTHORIZED", 2000), order("PARTIALLY_PAID", 3000), order("PAID", 4000),
  order("PARTIALLY_REFUNDED", 5000, 1000), order("REFUNDED", 6000, 6000), order("VOIDED", 700, 0, "CAD", { cancelledAt: new Date("2026-10-01") }),
  order(null, 80, 0, null), order("PAID", 9000, 0, "CAD"),
];

test("the new order-value fields carry exactly the old figures and keep currencies apart", () => {
  const result = buildConversionAnalytics(mixed);
  assert.deepEqual(result.attributedOrderValueByCurrency, result.grossAttributedRevenueByCurrency);
  assert.deepEqual(result.refundedAttributedValueByCurrency, result.refundedRevenueByCurrency);
  assert.deepEqual(result.currentNetAttributedOrderValueByCurrency, result.netAttributedRevenueByCurrency);
  // Every status contributes to order value, including pending, authorized and voided.
  assert.deepEqual(result.attributedOrderValueByCurrency, [
    { currencyCode: "CAD", minor: "9700" },
    { currencyCode: "USD", minor: "21000" },
    { currencyCode: "UNKNOWN", minor: "80" },
  ]);
  // A currency with orders but no refunds reports a known zero; this is unchanged behavior.
  assert.deepEqual(result.refundedAttributedValueByCurrency, [
    { currencyCode: "CAD", minor: "0" },
    { currencyCode: "USD", minor: "7000" },
    { currencyCode: "UNKNOWN", minor: "0" },
  ]);
  // Current net counts only paid, partially paid and partially refunded orders with a positive net.
  assert.deepEqual(result.currentNetAttributedOrderValueByCurrency, [
    { currencyCode: "CAD", minor: "9000" },
    { currencyCode: "USD", minor: "11000" },
  ]);
  assert.ok(!JSON.stringify(result.attributedOrderValueByCurrency).includes("21000,"), "currencies are never summed");
});

test("the status breakdown shows what the order value contains, including voided, unknown and cancelled orders", () => {
  const result = buildConversionAnalytics(mixed);
  assert.deepEqual(result.financialStatusBreakdown, [
    { status: "PENDING", orders: 1 },
    { status: "AUTHORIZED", orders: 1 },
    { status: "PARTIALLY_PAID", orders: 1 },
    { status: "PAID", orders: 2 },
    { status: "PARTIALLY_REFUNDED", orders: 1 },
    { status: "REFUNDED", orders: 1 },
    { status: "VOIDED", orders: 1 },
    { status: "UNKNOWN", orders: 1 },
  ]);
  assert.equal(result.financialStatusBreakdown.reduce((sum, row) => sum + row.orders, 0), result.attributedOrders);
  assert.equal(result.cancelledAttributedOrders, 1);
  // A cancelled order never changes a money figure; it is only counted.
  const withoutCancelled = buildConversionAnalytics(mixed.map((row) => ({ ...row, cancelledAt: undefined })));
  assert.deepEqual(withoutCancelled.attributedOrderValueByCurrency, result.attributedOrderValueByCurrency);
  assert.equal(withoutCancelled.cancelledAttributedOrders, 0);
});

test("a partially paid order counts at its full order total, and the label says so", () => {
  const result = buildConversionAnalytics([order("PARTIALLY_PAID", 10000)]);
  assert.deepEqual(result.currentNetAttributedOrderValueByCurrency, [{ currencyCode: "USD", minor: "10000" }]);
  assert.match(ORDER_VALUE_LABELS.currentNet.definition, /partially paid order counts at its full order total/);
  assert.match(ORDER_VALUE_LABELS.attributedOrderValue.definition, /not money collected/);
});

test("daily trend points keep the old and new money fields identical and still sum to the headline", () => {
  const rows = mixed.map((row, index) => ({ ...row, orderDate: new Date(Date.UTC(2026, 9, 1 + (index % 3))) }));
  const range = { start: new Date(Date.UTC(2026, 9, 1)), end: new Date(Date.UTC(2026, 9, 3, 23, 59, 59)) };
  const trend = buildConversionDailyTrend(rows, range, 400);
  const headline = buildConversionAnalytics(rows);
  for (const point of trend) {
    assert.deepEqual(point.grossRevenueByCurrency, point.attributedOrderValueByCurrency);
    assert.deepEqual(point.netRevenueByCurrency, point.currentNetAttributedOrderValueByCurrency);
  }
  const total = (currency: string) => trend.reduce((sum, point) => sum + BigInt(point.attributedOrderValueByCurrency.find((r) => r.currencyCode === currency)?.minor ?? "0"), BigInt(0));
  for (const row of headline.attributedOrderValueByCurrency) assert.equal(total(row.currencyCode).toString(), row.minor);
});

test("no analytics screen calls an order value revenue or sales collected", () => {
  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const path of [
    "src/app/(withSidebar)/dashboard/brand/analytics/page.tsx",
    "src/app/(withSidebar)/dashboard/creator/analytics/page.tsx",
    "src/components/commerce/financial-status-breakdown.tsx",
    "src/lib/commerce/analytics-labels.ts",
  ]) {
    assert.doesNotMatch(strip(readFileSync(path, "utf8")), /revenue/i, path);
  }
});

test("every conversion panel states its period, timezone and date basis, and the data limitation", () => {
  for (const path of [
    "src/app/(withSidebar)/dashboard/brand/analytics/page.tsx",
    "src/app/(withSidebar)/dashboard/creator/analytics/page.tsx",
  ]) {
    const page = readFileSync(path, "utf8");
    assert.match(page, /\(UTC\), counted only when SQRATCH has exact/);
    assert.match(page, /\{CONVERSION_DATE_BASIS_NOTE\}/);
    assert.match(page, /<FinancialStatusBreakdown/);
  }
  const labels = readFileSync("src/lib/commerce/analytics-labels.ts", "utf8");
  assert.match(labels, /date SQRATCH received them \(UTC\)/);
  assert.match(labels, /does not record the amount actually paid/);
  assert.match(labels, /does not show that SQRATCH caused the sale/);
});

test("the creator engagement route uses the strict UTC resolver and never falls back to all-time", () => {
  const route = readFileSync("src/app/api/creator/analytics/route.ts", "utf8");
  assert.match(route, /resolveCommerceClickAnalyticsDateRange\(/);
  assert.match(route, /status: 400/);
  assert.doesNotMatch(route, /setHours|new Date\(dateFrom\)|new Date\(dateTo\)/);
  assert.doesNotMatch(route, /start \|\| end|start \? \{/);
  const page = readFileSync("src/app/(withSidebar)/dashboard/creator/analytics/page.tsx", "utf8");
  assert.match(page, /Lessons marked complete, last updated in period/);
  assert.doesNotMatch(page, /label="Completed lessons"/);
});
