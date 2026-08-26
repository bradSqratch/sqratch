/**
 * tests/creator-analytics-conversions.test.ts
 *
 * PHASE 24 — PART 30: static source assertions for the Creator Analytics
 * conversion/revenue panel — same "no React testing library, read the
 * source" idiom as `tests/brand-analytics-conversions.test.ts`. The primary
 * concern on this page is privacy: a creator must never be shown a
 * sponsoring brand's campaign identifiers, whole-order basket composition,
 * or another creator's data.
 */
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE_PATH = join(
  process.cwd(),
  "src/app/(withSidebar)/dashboard/creator/analytics/page.tsx",
);

describe("Creator Analytics — attributed conversions & revenue panel", () => {
  const source = readFileSync(PAGE_PATH, "utf8");

  test("1. the conversions endpoint is actually consumed", () => {
    assert.match(source, /\/api\/creator\/analytics\/conversions/);
    assert.match(source, /parseCreatorConversionAnalytics/);
  });

  test("2. the creator conversion section cannot render any campaign identifier — no entry/product campaign field or breakdown table exists anywhere on this page", () => {
    assert.doesNotMatch(source, /attributedOrdersByEntryCampaign/);
    assert.doesNotMatch(source, /attributedOrdersByProductCampaign/);
    assert.doesNotMatch(source, /[Ee]ntry campaign/);
    assert.doesNotMatch(source, /[Pp]roduct campaign/);
    assert.doesNotMatch(source, /campaignName/);
    assert.doesNotMatch(source, /campaignId/);
  });

  test("3. whole-order line-item/basket vocabulary is never introduced", () => {
    assert.doesNotMatch(source, /lineItem/i);
    assert.doesNotMatch(source, /\bbasket\b/i);
    assert.doesNotMatch(source, /order\s*items?\b/i);
  });

  test("4. creator attributed revenue renders per currency via the same never-summed helper as the Brand page", () => {
    assert.match(source, /formatMoneyRows/);
    assert.match(source, /<MoneyRowsCard title="Gross attributed revenue"/);
    assert.match(source, /<MoneyRowsCard title="Refunded attributed revenue"/);
    assert.match(source, /<MoneyRowsCard title="Net attributed revenue"/);
    const cardStart = source.indexOf("function MoneyRowsCard(");
    const cardBody = source.slice(cardStart, cardStart + 700);
    assert.doesNotMatch(cardBody, /\.reduce\(/);
  });

  test("5. Experience/Lesson/promoted-product breakdowns are rendered, scoped to creator-authorized data only", () => {
    assert.match(source, /By Experience/);
    assert.match(source, /By Lesson/);
    assert.match(source, /By promoted product/);
    assert.match(source, /attributedOrdersByExperience/);
    assert.match(source, /attributedOrdersByLesson/);
    assert.match(source, /attributedOrdersByProduct/);
  });

  test("6. an Experience filter is forwarded to the conversions request, and the request depends on filters.experienceId", () => {
    const loaderStart = source.indexOf("const loadConversion = useCallback(");
    assert.ok(loaderStart > -1, "loadConversion not found");
    const loaderEnd = source.indexOf("}, [filters]);", loaderStart);
    const loaderBody = source.slice(loaderStart, loaderEnd);
    assert.match(loaderBody, /query\.set\("experienceId", filters\.experienceId\)/);
  });

  test("7. existing creator click analytics remain intact (own state, own effect, own section still present)", () => {
    assert.match(source, /CommerceClickSection/);
    assert.match(source, /commerceLoading/);
    assert.match(source, /commerceError/);
    assert.match(source, /\/api\/creator\/analytics\/commerce/);
  });

  test("8. no brand-private campaign metadata leaks anywhere in the file, and no customer PII vocabulary is introduced", () => {
    for (const forbidden of [
      "email",
      "phone",
      "billingAddress",
      "shippingAddress",
      "cardNumber",
      "ipAddress",
      "customerName",
    ]) {
      const pattern = new RegExp(forbidden, "i");
      assert.doesNotMatch(source, pattern, `forbidden vocabulary found: ${forbidden}`);
    }
  });

  test("'orders ingested' is deliberately NOT shown as a creator-facing card — every order in creator scope is already attributed by construction", () => {
    assert.doesNotMatch(source, /"totalIngestedOrders"/);
    assert.doesNotMatch(source, /label="Orders ingested"/);
    assert.doesNotMatch(source, />Orders ingested</);
  });

  test("conversion loading/error state is isolated from engagement and click analytics state", () => {
    assert.match(source, /conversionLoading/);
    assert.match(source, /conversionError/);
    assert.match(source, /const \[conversion, setConversion\]/);
  });

  test("a race-safety sequence guard exists on the conversion request", () => {
    assert.match(source, /conversionRequestSeq/);
    assert.match(source, /seq !== conversionRequestSeq\.current/);
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
