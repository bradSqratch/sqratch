process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.NEXTAUTH_SECRET ||= "test-nextauth-secret";
process.env.APP_ENCRYPTION_KEY ||= "test-app-encryption-key";

/**
 * tests/brand-product-page.test.ts
 *
 * Unit tests for Workstream 5 (brand product interface,
 * `/dashboard/brand/products`). There is no React testing library in this
 * repo (see CLAUDE.md / task brief), so these tests exercise:
 *
 *   1. The pure helpers extracted to
 *      `src/app/(withSidebar)/dashboard/brand/products/product-catalog-helpers.ts`
 *      (money formatting, sync-outcome-to-message mapping, query-string
 *      building, client-side override validation) — same idiom as
 *      `tests/commerce-connection-compatibility.test.ts`.
 *   2. Static source-inspection assertions against the page/client
 *      component source, following the precedent of
 *      `tests/shopify-scope-drift.test.ts`.
 *
 * No database, no network, no React runtime anywhere in this file.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  buildProductQueryString,
  DISPLAY_ORDER_MAX,
  DISPLAY_ORDER_MIN,
  describeSyncOutcome,
  formatPriceDisplay,
  SHORT_DESCRIPTION_OVERRIDE_MAX_LENGTH,
  TITLE_OVERRIDE_MAX_LENGTH,
  validateDisplayOrder,
  validateShortDescriptionOverride,
  validateTitleOverride,
  type ProductPrice,
} from "../src/app/(withSidebar)/dashboard/brand/products/product-catalog-helpers";

const PRODUCTS_DIR = path.join(
  process.cwd(),
  "src/app/(withSidebar)/dashboard/brand/products",
);

function priceFixture(overrides: Partial<ProductPrice> = {}): ProductPrice {
  return {
    minMinor: 1000,
    maxMinor: 1000,
    currencyCode: "USD",
    minorUnitExponent: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Minor-unit money formatting
// ---------------------------------------------------------------------------

describe("formatPriceDisplay — minor-unit exponents", () => {
  test("exponent 2 (e.g. USD cents) divides by 100", () => {
    const result = formatPriceDisplay(priceFixture({ minMinor: 1999, maxMinor: 1999, minorUnitExponent: 2 }));
    assert.match(result, /19\.99/);
  });

  test("exponent 0 (zero-decimal currency, e.g. JPY) does not divide at all", () => {
    const result = formatPriceDisplay(
      priceFixture({ minMinor: 1999, maxMinor: 1999, currencyCode: "JPY", minorUnitExponent: 0 }),
    );
    // 1999 JPY, not 19.99 — no fractional digits, no /100 assumption.
    assert.match(result, /1,999|1999/);
    assert.doesNotMatch(result, /19\.99/);
  });

  test("exponent 3 (e.g. BHD/KWD-style) divides by 1000", () => {
    const result = formatPriceDisplay(
      priceFixture({ minMinor: 19999, maxMinor: 19999, currencyCode: "BHD", minorUnitExponent: 3 }),
    );
    assert.match(result, /19\.999/);
  });

  test("never assumes /100 regardless of currency — exponent always drives the division", () => {
    const twoDigit = formatPriceDisplay(priceFixture({ minMinor: 100, maxMinor: 100, minorUnitExponent: 2 }));
    const threeDigit = formatPriceDisplay(
      priceFixture({ minMinor: 100, maxMinor: 100, minorUnitExponent: 3, currencyCode: "BHD" }),
    );
    assert.notEqual(twoDigit, threeDigit);
  });

  test("minMinor === maxMinor renders a single price, not a range", () => {
    const result = formatPriceDisplay(priceFixture({ minMinor: 500, maxMinor: 500 }));
    assert.doesNotMatch(result, /-/);
  });

  test("minMinor !== maxMinor renders a range", () => {
    const result = formatPriceDisplay(priceFixture({ minMinor: 500, maxMinor: 900 }));
    assert.match(result, / - /);
  });

  test("null minMinor/maxMinor/exponent renders an unavailable price, not a crash", () => {
    assert.doesNotThrow(() => formatPriceDisplay(priceFixture({ minMinor: null })));
    const result = formatPriceDisplay(priceFixture({ minMinor: null }));
    assert.match(result, /unavailable/i);
  });
});

// ---------------------------------------------------------------------------
// 2. Null currencyCode
// ---------------------------------------------------------------------------

describe("formatPriceDisplay — null currencyCode", () => {
  test("renders no currency symbol and no guessed default currency", () => {
    const result = formatPriceDisplay(priceFixture({ currencyCode: null }));
    // No $, no bare numeric-looking price, and no common default currency
    // code silently substituted.
    assert.doesNotMatch(result, /\$/);
    assert.doesNotMatch(result, /USD|CAD|EUR|GBP/);
    assert.match(result, /unavailable|unknown/i);
  });

  test("a null currency with valid amounts still does not fall back to a raw number", () => {
    const result = formatPriceDisplay(
      priceFixture({ currencyCode: null, minMinor: 1999, maxMinor: 1999 }),
    );
    assert.doesNotMatch(result, /19\.99/);
  });
});

// ---------------------------------------------------------------------------
// 3. Sync outcome mapping
// ---------------------------------------------------------------------------

describe("describeSyncOutcome — every documented outcome", () => {
  test("SUCCEEDED maps to a success-toned message", () => {
    const notice = describeSyncOutcome({ status: "SUCCEEDED" });
    assert.equal(notice.tone, "success");
  });

  test("PARTIAL without a reason is a truthful generic warning", () => {
    const notice = describeSyncOutcome({ status: "PARTIAL", failureSummary: null });
    assert.notEqual(notice.tone, "success");
    assert.match(notice.message, /did not complete|preserved|not marked inactive/i);
    assert.doesNotMatch(notice.message, /continue|resume/i);
  });

  test("PARTIAL diagnostics use reason-specific, conservative messages", () => {
    const cases = [
      ["PAGINATION_TIMEOUT", /time limit/i],
      ["MAX_PAGES_REACHED", /page safety limit/i],
      ["MAX_PRODUCTS_REACHED", /product safety limit/i],
      ["MISSING_CURSOR", /incomplete pagination/i],
      ["CURSOR_LOOP", /incomplete pagination/i],
      ["INVALID_PAGE", /incomplete pagination/i],
      ["PARTIAL_WRITE_FAILURE", /could not be saved/i],
    ] as const;

    for (const [tag, expected] of cases) {
      const notice = describeSyncOutcome({
        status: "PARTIAL",
        failureSummary: `${tag}: internal detail that must not be rendered`,
        fetchedCount: 12,
        failedCount: tag === "PARTIAL_WRITE_FAILURE" ? 2 : 0,
      });
      assert.equal(notice.tone, "warning");
      assert.match(notice.message, expected);
      assert.match(notice.message, /preserved|kept|not marked inactive/i);
      assert.doesNotMatch(notice.message, /internal detail|continue|resume/i);
    }
  });

  test("PARTIAL count details are bounded and only safe numeric counts are shown", () => {
    const notice = describeSyncOutcome({
      status: "PARTIAL",
      failureSummary: "PARTIAL_WRITE_FAILURE: detail",
      fetchedCount: 7,
      failedCount: 3,
      runId: "run-secret-like-id",
    });
    assert.match(notice.message, /Products fetched: 7/);
    assert.match(notice.message, /Product writes failed: 3/);
    assert.doesNotMatch(notice.message, /run-secret-like-id|detail/);
  });

  test("SKIPPED/NO_CONNECTION is an error", () => {
    const notice = describeSyncOutcome({ status: "SKIPPED", code: "NO_CONNECTION" });
    assert.equal(notice.tone, "error");
    assert.match(notice.message, /no commerce connection|connect a store/i);
  });

  test("SYNC_IN_PROGRESS is not a success", () => {
    const notice = describeSyncOutcome({ status: "SYNC_IN_PROGRESS" });
    assert.notEqual(notice.tone, "success");
    assert.match(notice.message, /already in progress/i);
  });

  test("SYNC_FAILED is an error and surfaces the failure summary when present", () => {
    const notice = describeSyncOutcome({
      status: "SYNC_FAILED",
      failureSummary: "Shopify returned 500",
    });
    assert.equal(notice.tone, "error");
    assert.match(notice.message, /Shopify returned 500/);
  });

  test("all five outcomes produce distinct messages", () => {
    const messages = [
      describeSyncOutcome({ status: "SUCCEEDED" }),
      describeSyncOutcome({ status: "PARTIAL" }),
      describeSyncOutcome({ status: "SKIPPED", code: "NO_CONNECTION" }),
      describeSyncOutcome({ status: "SYNC_IN_PROGRESS" }),
      describeSyncOutcome({ status: "SYNC_FAILED", failureSummary: null }),
    ].map((n) => n.message);
    assert.equal(new Set(messages).size, messages.length);
  });
});

// ---------------------------------------------------------------------------
// 4. Query-string building
// ---------------------------------------------------------------------------

describe("buildProductQueryString", () => {
  test("includes q, availability, selection, connectionId, cursor, limit when provided", () => {
    const qs = buildProductQueryString({
      q: "hoodie",
      availability: "unavailable",
      selection: "eligible",
      connectionId: "conn_123",
      cursor: "cursor_abc",
      limit: 25,
    });
    const params = new URLSearchParams(qs);
    assert.equal(params.get("q"), "hoodie");
    assert.equal(params.get("availability"), "unavailable");
    assert.equal(params.get("selection"), "eligible");
    assert.equal(params.get("connectionId"), "conn_123");
    assert.equal(params.get("cursor"), "cursor_abc");
    assert.equal(params.get("limit"), "25");
  });

  test("omits empty/undefined fields rather than sending blank params", () => {
    const qs = buildProductQueryString({ q: "", availability: "available" });
    const params = new URLSearchParams(qs);
    assert.equal(params.has("q"), false);
    assert.equal(params.get("availability"), "available");
    assert.equal(params.has("connectionId"), false);
    assert.equal(params.has("cursor"), false);
  });

  test("trims whitespace-only search terms to nothing", () => {
    const qs = buildProductQueryString({ q: "   " });
    const params = new URLSearchParams(qs);
    assert.equal(params.has("q"), false);
  });
});

// ---------------------------------------------------------------------------
// 5. Client-side override validation matches server bounds
// ---------------------------------------------------------------------------

describe("client-side override validation", () => {
  test("displayOrder bounds match the server and preserve zero", () => {
    assert.equal(DISPLAY_ORDER_MIN, 0);
    assert.equal(DISPLAY_ORDER_MAX, 1_000_000);
    assert.equal(validateDisplayOrder("0"), null);
    assert.equal(validateDisplayOrder("1000000"), null);
    assert.match(validateDisplayOrder("") ?? "", /required/i);
    assert.match(validateDisplayOrder("1.5") ?? "", /integer/i);
    assert.match(validateDisplayOrder("1000001") ?? "", /1000000/);
  });

  test("titleOverride bound matches the server (200)", () => {
    assert.equal(TITLE_OVERRIDE_MAX_LENGTH, 200);
    assert.equal(validateTitleOverride("a".repeat(200)), null);
    assert.match(validateTitleOverride("a".repeat(201)) ?? "", /200/);
  });

  test("shortDescriptionOverride bound matches the server (1000)", () => {
    assert.equal(SHORT_DESCRIPTION_OVERRIDE_MAX_LENGTH, 1000);
    assert.equal(validateShortDescriptionOverride("a".repeat(1000)), null);
    assert.match(validateShortDescriptionOverride("a".repeat(1001)) ?? "", /1000/);
  });

});

// ---------------------------------------------------------------------------
// 6 & 7. Static source assertions
// ---------------------------------------------------------------------------

describe("static source assertions", () => {
  const clientSource = readFileSync(path.join(PRODUCTS_DIR, "BrandProductsClient.tsx"), "utf8");
  const pageSource = readFileSync(path.join(PRODUCTS_DIR, "page.tsx"), "utf8");
  const combined = `${clientSource}\n${pageSource}`;

  test("no checkout/cart/payment affordance anywhere in the page source", () => {
    assert.doesNotMatch(combined, /checkout/i);
    assert.doesNotMatch(combined, /\bcart\b/i);
    assert.doesNotMatch(combined, /\bpayment\b/i);
    assert.doesNotMatch(combined, /add[-\s]?to[-\s]?cart/i);
  });

  test("does not import any campaign/creator/Experience/Lesson selector", () => {
    assert.doesNotMatch(combined, /campaign-form/i);
    assert.doesNotMatch(combined, /creator[/-]/i);
    assert.doesNotMatch(combined, /ExperienceSelector|LessonSelector|CampaignProductSelector/);
    assert.doesNotMatch(combined, /from ["']@\/components\/creator/);
    assert.doesNotMatch(combined, /from ["']@\/components\/experience\/(?!client-utils|experience-shell)/);
  });

  test("external product links use target=\"_blank\" with rel containing noopener", () => {
    assert.match(clientSource, /target="_blank"/);
    // Every target="_blank" anchor in the file must be paired with a
    // rel attribute containing noopener somewhere nearby.
    const anchorBlocks = clientSource.split(/<a[\s>]/).slice(1);
    const blankAnchors = anchorBlocks.filter((block) => block.includes('target="_blank"'));
    assert.ok(blankAnchors.length > 0, "expected at least one target=_blank anchor");
    for (const block of blankAnchors) {
      assert.match(block, /rel="[^"]*noopener[^"]*"/);
    }
  });

  test("page.tsx is a minimal server wrapper matching the Shopify page pattern", () => {
    assert.doesNotMatch(pageSource, /"use client"/);
    assert.match(pageSource, /BrandProductsClient/);
  });

  test("presentation overrides submit a bounded display order with the existing save feedback", () => {
    assert.match(clientSource, /type="number"/);
    assert.match(clientSource, /min=\{DISPLAY_ORDER_MIN\}/);
    assert.match(clientSource, /max=\{DISPLAY_ORDER_MAX\}/);
    assert.match(clientSource, /displayOrder: Number\(draft\.displayOrder\)/);
    assert.match(clientSource, /validateDisplayOrder\(draft\.displayOrder\)/);
    assert.match(clientSource, /state\?\.error/);
    assert.match(clientSource, /state\?\.success/);
  });

  test("the dashboard passes sanitized partial diagnostics from the API response", () => {
    assert.match(clientSource, /failureSummary: syncData\.failureSummary/);
    assert.match(clientSource, /hasNextPage: syncData\.hasNextPage/);
    assert.match(clientSource, /fetchedCount: syncData\.stats\?\.fetchedCount/);
    assert.match(clientSource, /failedCount: syncData\.stats\?\.failedCount/);
    assert.match(clientSource, /runId: syncData\.runId/);
  });

  test("does not render or submit an image-override control", () => {
    assert.doesNotMatch(clientSource, /imageUrlOverride|Image URL override/i);
  });

  test("explains current product-status and curation-control semantics", () => {
    assert.match(clientSource, /changing a product between Active and Draft/i);
    assert.match(clientSource, /Shows this product in the public SQRATCH campaign storefront/i);
    assert.match(clientSource, /eligible for future campaign assignment/i);
  });
});
