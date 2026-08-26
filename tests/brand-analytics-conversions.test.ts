/**
 * tests/brand-analytics-conversions.test.ts
 *
 * PHASE 24 — PART 29: static source assertions for the Brand Analytics
 * conversion/revenue panel. Same idiom as
 * `tests/brand-product-page.test.ts`'s "static source assertions" — this
 * repo has no React testing library, so page behavior is proven by reading
 * the component source rather than rendering it.
 */
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE_PATH = join(
  process.cwd(),
  "src/app/(withSidebar)/dashboard/brand/analytics/page.tsx",
);

describe("Brand Analytics — attributed conversions & revenue panel", () => {
  const source = readFileSync(PAGE_PATH, "utf8");

  test("1. the conversions endpoint is actually consumed", () => {
    assert.match(source, /\/api\/brand\/analytics\/conversions/);
    assert.match(source, /parseBrandConversionAnalytics/);
  });

  test("2. dateFrom/dateTo are forwarded to the conversions request", () => {
    const effectStart = source.indexOf("Attributed conversions & revenue — a THIRD");
    const effectBody = source.slice(effectStart, effectStart + 1400);
    assert.match(effectBody, /query\.set\("dateFrom", filters\.dateFrom\)/);
    assert.match(effectBody, /query\.set\("dateTo", filters\.dateTo\)/);
  });

  test("3. the campaign dropdown is never forwarded to the conversions request, and the effect does not depend on it", () => {
    const effectStart = source.indexOf("useEffect(() => {\n    const seq = ++conversionRequestSeq.current;");
    assert.ok(effectStart > -1, "conversion effect not found");
    const effectEnd = source.indexOf("}, [filters.dateFrom, filters.dateTo]);", effectStart);
    assert.ok(effectEnd > -1, "conversion effect must depend only on the date range, not campaignId");
    const effectBody = source.slice(effectStart, effectEnd);
    assert.doesNotMatch(effectBody, /campaignId/);
  });

  test("4. the stale 'order and revenue attribution are not enabled' copy is gone", () => {
    assert.doesNotMatch(source, /Order and\s+revenue attribution are not enabled/);
    assert.doesNotMatch(source, /revenue attribution are not enabled/i);
  });

  test("5. attributed orders is shown", () => {
    assert.match(source, /"attributedOrders"/);
    assert.match(source, /Attributed orders/);
  });

  test("6. current paid conversions is shown", () => {
    assert.match(source, /"currentlyNetPositivePaidOrders"/);
    assert.match(source, /Current paid conversions/);
  });

  test("7. pending/authorized is shown", () => {
    assert.match(source, /"pendingOrAuthorizedOrders"/);
    assert.match(source, /Pending \/ authorized/);
  });

  test("8. partially and fully refunded are both shown", () => {
    assert.match(source, /"partiallyRefundedOrders"/);
    assert.match(source, /Partially refunded/);
    assert.match(source, /"fullyRefundedOrders"/);
    assert.match(source, /Fully refunded/);
  });

  test("9. gross/refunded/net revenue are rendered as three separate cards, never combined", () => {
    assert.match(source, /Gross attributed revenue/);
    assert.match(source, /Refunded attributed revenue/);
    assert.match(source, /Net attributed revenue/);
    assert.match(source, /<MoneyRowsCard title="Gross attributed revenue"/);
    assert.match(source, /<MoneyRowsCard title="Refunded attributed revenue"/);
    assert.match(source, /<MoneyRowsCard title="Net attributed revenue"/);
  });

  test("10. currency rows are never summed — MoneyRowsCard renders formatMoneyRows' per-currency lines, and no reduce/sum appears near revenue rendering", () => {
    const cardStart = source.indexOf("function MoneyRowsCard(");
    assert.ok(cardStart > -1);
    const cardBody = source.slice(cardStart, cardStart + 700);
    assert.match(cardBody, /formatMoneyRows\(rows\)/);
    assert.doesNotMatch(cardBody, /\.reduce\(/);
    assert.doesNotMatch(cardBody, /\+\s*row/);
  });

  test("11. a provider breakdown exists", () => {
    assert.match(source, /By provider/);
    assert.match(source, /<ProviderBreakdownTable/);
    assert.match(source, /attributedOrdersByProvider/);
  });

  test("12. entry campaign and product campaign breakdowns are rendered as two separate sections, never combined into one number", () => {
    assert.match(source, /By entry campaign/);
    assert.match(source, /By product campaign/);
    assert.match(source, /attributedOrdersByEntryCampaign/);
    assert.match(source, /attributedOrdersByProductCampaign/);
    // No arithmetic anywhere combines the two breakdown arrays/counts.
    assert.doesNotMatch(
      source,
      /attributedOrdersByEntryCampaign.*\+.*attributedOrdersByProductCampaign/,
    );
  });

  test("13. an empty state exists for ingested-but-unattributed orders", () => {
    assert.match(source, /noAttributionYet/);
    assert.match(
      source,
      /Orders have been ingested, but none in this range have exact SQRATCH\s*\n?\s*attribution yet\./,
    );
  });

  test("13b. an empty state exists for zero ingested orders, and an UNKNOWN-currency-safe empty revenue message exists", () => {
    assert.match(source, /No commerce orders were recorded in this date range\./);
    assert.match(source, /No attributed revenue in this range\./);
  });

  test("14. no customer PII vocabulary or fields are introduced", () => {
    for (const forbidden of [
      "email",
      "phone",
      "address",
      "customerName",
      "billingAddress",
      "shippingAddress",
      "cardNumber",
      "ipAddress",
    ]) {
      const pattern = new RegExp(forbidden, "i");
      assert.doesNotMatch(source, pattern, `forbidden PII vocabulary found: ${forbidden}`);
    }
  });

  test("conversion loading/error state is isolated from engagement and click analytics state", () => {
    assert.match(source, /conversionLoading/);
    assert.match(source, /conversionError/);
    assert.match(source, /const \[conversion, setConversion\]/);
    // Distinct from the pre-existing `error`/`commerceError` state variables.
    assert.match(source, /const \[error, setError\]/);
    assert.match(source, /const \[commerceError, setCommerceError\]/);
  });

  test("a race-safety sequence guard exists on the conversion request", () => {
    assert.match(source, /conversionRequestSeq/);
    assert.match(source, /seq !== conversionRequestSeq\.current/);
  });

  test("a non-primary link to Order Operations is present, and Analytics renders no operational controls (no reconcile/catch-up/sync button in this section)", () => {
    const sectionStart = source.indexOf("function ConversionAnalyticsSection(");
    const sectionEnd = source.indexOf("\nfunction ConversionMetricCard(");
    const sectionBody = source.slice(sectionStart, sectionEnd);
    assert.match(sectionBody, /href="\/dashboard\/brand\/commerce\/orders"/);
    assert.doesNotMatch(sectionBody, /catch.?up/i);
    assert.doesNotMatch(sectionBody, /reconcile/i);
  });

  test("no naive conversion-rate (attributed orders / clicks) is ever computed", () => {
    assert.doesNotMatch(source, /clicks\s*\/\s*attributedOrders/i);
    assert.doesNotMatch(source, /attributedOrders\s*\/\s*.*clicks/i);
    assert.doesNotMatch(source, /conversionRate/i);
  });

  test("large breakdowns are capped to a reasonable display footprint rather than an unbounded table", () => {
    assert.match(source, /CONVERSION_BREAKDOWN_DISPLAY_LIMIT/);
    assert.match(source, /rows\.slice\(0, CONVERSION_BREAKDOWN_DISPLAY_LIMIT\)/);
  });
});
