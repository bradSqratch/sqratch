/**
 * tests/conversion-analytics-client.test.ts
 *
 * PHASE 24 — PART 28: focused tests for the shared response contract at
 * `src/lib/commerce/conversion-analytics-client.ts`. Pure, DB-free,
 * network-free — the same idiom as
 * `tests/commerce-response-validation.test.ts`-style validators elsewhere in
 * this repo.
 */
import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  parseBrandConversionAnalytics,
  parseCreatorConversionAnalytics,
  formatMoneyRows,
  providerLabel,
  type BrandConversionAnalytics,
} from "../src/lib/commerce/conversion-analytics-client";

function validBrandFixture(): BrandConversionAnalytics {
  return {
    range: { start: "2026-08-01T00:00:00.000Z", end: "2026-08-26T00:00:00.000Z" },
    totalIngestedOrders: 10,
    attributedOrders: 6,
    currentlyNetPositivePaidOrders: 4,
    pendingOrAuthorizedOrders: 1,
    partiallyRefundedOrders: 1,
    fullyRefundedOrders: 0,
    grossAttributedRevenueByCurrency: [{ currencyCode: "USD", minor: "123456" }],
    refundedRevenueByCurrency: [],
    netAttributedRevenueByCurrency: [{ currencyCode: "USD", minor: "123456" }],
    attributedOrdersByProvider: [{ id: "SHOPIFY", orders: 6 }],
    attributedOrdersByEntryCampaign: [{ id: "campaign-1", name: "Spring", orders: 3 }],
    attributedOrdersByProductCampaign: [{ id: "campaign-2", name: "Push", orders: 3 }],
    attributedOrdersByExperience: [{ id: "experience-1", name: "Tasting Room", orders: 6 }],
    attributedOrdersByCreator: [{ id: "creator-1", name: "Jordan", orders: 6 }],
    attributedOrdersByLesson: [{ id: "lesson-1", name: "Intro", orders: 6 }],
    attributedOrdersByProduct: [{ id: "product-1", name: "Estate Red", orders: 6 }],
  };
}

describe("parseBrandConversionAnalytics", () => {
  test("1. a valid conversion response parses", () => {
    const parsed = parseBrandConversionAnalytics(validBrandFixture());
    assert.ok(parsed);
    assert.equal(parsed?.attributedOrders, 6);
  });

  test("2. a malformed count (wrong type) is rejected safely, not crashed on", () => {
    const fixture = validBrandFixture() as unknown as Record<string, unknown>;
    fixture.attributedOrders = "six";
    assert.equal(parseBrandConversionAnalytics(fixture), null);
  });

  test("2b. a missing count field is rejected safely", () => {
    const fixture = validBrandFixture() as unknown as Record<string, unknown>;
    delete fixture.pendingOrAuthorizedOrders;
    assert.equal(parseBrandConversionAnalytics(fixture), null);
  });

  test("3. a malformed revenue row (missing minor) is rejected safely", () => {
    const fixture = validBrandFixture() as unknown as { grossAttributedRevenueByCurrency: unknown };
    fixture.grossAttributedRevenueByCurrency = [{ currencyCode: "USD" }];
    assert.equal(parseBrandConversionAnalytics(fixture), null);
  });

  test("3b. a revenue row whose minor is a number (not a string) is rejected — BigInt-safe transport requires a decimal string", () => {
    const fixture = validBrandFixture() as unknown as { grossAttributedRevenueByCurrency: unknown };
    fixture.grossAttributedRevenueByCurrency = [{ currencyCode: "USD", minor: 123456 }];
    assert.equal(parseBrandConversionAnalytics(fixture), null);
  });

  test("4. a large BigInt-derived minor value survives as a decimal string, unchanged", () => {
    const fixture = validBrandFixture();
    fixture.grossAttributedRevenueByCurrency = [
      { currencyCode: "USD", minor: "9007199254740993" }, // one past Number.MAX_SAFE_INTEGER
    ];
    const parsed = parseBrandConversionAnalytics(fixture);
    assert.equal(parsed?.grossAttributedRevenueByCurrency[0]?.minor, "9007199254740993");
  });

  test("5. a multi-currency array parses with every row intact, never collapsed", () => {
    const fixture = validBrandFixture();
    fixture.netAttributedRevenueByCurrency = [
      { currencyCode: "CAD", minor: "132257" },
      { currencyCode: "USD", minor: "95300" },
    ];
    const parsed = parseBrandConversionAnalytics(fixture);
    assert.equal(parsed?.netAttributedRevenueByCurrency.length, 2);
    assert.deepEqual(parsed?.netAttributedRevenueByCurrency, fixture.netAttributedRevenueByCurrency);
  });

  test("6. an UNKNOWN currency row parses and remains explicitly labelled UNKNOWN", () => {
    const fixture = validBrandFixture();
    fixture.grossAttributedRevenueByCurrency = [{ currencyCode: "UNKNOWN", minor: "500" }];
    const parsed = parseBrandConversionAnalytics(fixture);
    assert.equal(parsed?.grossAttributedRevenueByCurrency[0]?.currencyCode, "UNKNOWN");
  });

  test("the creator variant also parses its own valid shape and requires filters.experienceId", () => {
    const fixture = {
      ...validBrandFixture(),
      filters: { experienceId: null },
    };
    // Creator responses do not carry campaign breakdowns, but the parser is
    // permissive about extra fields — this fixture still round-trips.
    const parsed = parseCreatorConversionAnalytics(fixture);
    assert.ok(parsed);
    assert.equal(parsed?.filters.experienceId, null);
  });

  test("a creator response missing filters is rejected safely", () => {
    const fixture = validBrandFixture() as unknown as Record<string, unknown>;
    assert.equal(parseCreatorConversionAnalytics(fixture), null);
  });

  test("null/undefined/array input never throws and returns null", () => {
    assert.equal(parseBrandConversionAnalytics(null), null);
    assert.equal(parseBrandConversionAnalytics(undefined), null);
    assert.equal(parseBrandConversionAnalytics([1, 2, 3]), null);
    assert.equal(parseBrandConversionAnalytics("not an object"), null);
  });
});

describe("formatMoneyRows", () => {
  test("7. renders each currency row independently — no helper anywhere sums minor values across rows", () => {
    const lines = formatMoneyRows([
      { currencyCode: "CAD", minor: "9831" },
      { currencyCode: "USD", minor: "4200" },
    ]);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^CAD /);
    assert.match(lines[1], /^USD /);
    // Never a combined "140.31"-style figure anywhere in the output.
    assert.ok(!lines.some((line) => line.includes("140.31")));
  });

  test("an UNKNOWN row renders an explicit, unformatted marker — never a fabricated $/exponent", () => {
    const lines = formatMoneyRows([{ currencyCode: "UNKNOWN", minor: "9831" }]);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Unknown currency/i);
    assert.match(lines[0], /9831/);
    assert.doesNotMatch(lines[0], /\$/);
  });

  test("zero-decimal currencies (e.g. JPY) render without a fabricated fraction", () => {
    const lines = formatMoneyRows([{ currencyCode: "JPY", minor: "5000" }]);
    assert.equal(lines[0], "JPY 5,000");
  });

  test("3-decimal currencies (e.g. KWD) render with three fraction digits, not two", () => {
    const lines = formatMoneyRows([{ currencyCode: "KWD", minor: "12345" }]);
    assert.equal(lines[0], "KWD 12.345");
  });

  test("an empty array renders an empty list (caller decides the empty-state copy)", () => {
    assert.deepEqual(formatMoneyRows([]), []);
  });
});

describe("providerLabel", () => {
  test("8. known provider values map to a friendly label", () => {
    assert.equal(providerLabel("SHOPIFY"), "Shopify");
    assert.equal(providerLabel("COMMERCE7"), "Commerce7");
  });

  test("9. an unknown/future provider value never crashes presentation — falls back to the raw value", () => {
    assert.equal(providerLabel("SOME_FUTURE_PROVIDER"), "SOME_FUTURE_PROVIDER");
    assert.doesNotThrow(() => providerLabel(""));
  });
});
