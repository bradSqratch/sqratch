/**
 * tests/conversion-breakdown-naming.test.ts
 *
 * PHASE 24 — pure unit tests for `attachConversionNames`
 * (`src/lib/commerce/conversion-breakdown-naming.ts`) and the two per-route
 * enrichment wrappers, `enrichBrandConversionBreakdownNames` and the
 * creator route's inline enrichment shape. No Prisma, no network — every
 * name lookup is a plain `Map`.
 */
import "./env-setup";

import assert from "node:assert/strict";
import { test, describe } from "node:test";

import { attachConversionNames } from "../src/lib/commerce/conversion-breakdown-naming";
import { enrichBrandConversionBreakdownNames } from "../src/app/api/brand/analytics/conversions/route";
import { buildConversionAnalytics } from "../src/lib/commerce/order-analytics";
import { CommerceProvider } from "@prisma/client";

describe("attachConversionNames", () => {
  test("resolves a name for every id present in the map", () => {
    const rows = attachConversionNames(
      [{ id: "a", orders: 3 }, { id: "b", orders: 1 }],
      new Map([["a", "Alpha"], ["b", "Beta"]]),
    );
    assert.deepEqual(rows, [
      { id: "a", name: "Alpha", orders: 3 },
      { id: "b", name: "Beta", orders: 1 },
    ]);
  });

  test("an id with no matching map entry keeps its count with name: null, rather than disappearing", () => {
    const rows = attachConversionNames([{ id: "unresolved", orders: 2 }], new Map());
    assert.deepEqual(rows, [{ id: "unresolved", name: null, orders: 2 }]);
  });

  test("an empty row list produces an empty result regardless of the map", () => {
    const rows = attachConversionNames([], new Map([["a", "Alpha"]]));
    assert.deepEqual(rows, []);
  });

  test("does not mutate the input rows or the map", () => {
    const inputRows = [{ id: "a", orders: 1 }];
    const names = new Map([["a", "Alpha"]]);
    attachConversionNames(inputRows, names);
    assert.deepEqual(inputRows, [{ id: "a", orders: 1 }]);
    assert.equal(names.size, 1);
  });
});

describe("enrichBrandConversionBreakdownNames", () => {
  function baseOrder(overrides: Partial<Parameters<typeof buildConversionAnalytics>[0][number]> = {}) {
    return {
      provider: CommerceProvider.SHOPIFY,
      financialStatus: "PAID" as const,
      currencyCode: "USD",
      totalMinor: BigInt(1000),
      totalRefundedMinor: BigInt(0),
      netRevenueMinor: BigInt(1000),
      attribution: {
        entryCampaignId: "campaign-1",
        productCampaignId: "campaign-2",
        experienceId: "experience-1",
        creatorProfileId: "creator-1",
        lessonId: "lesson-1",
        connectedProductId: "product-1",
      },
      lineItems: [],
      ...overrides,
    };
  }

  test("attaches a name onto every breakdown dimension while leaving counts and revenue untouched", () => {
    const conversion = buildConversionAnalytics([baseOrder()]);
    const enriched = enrichBrandConversionBreakdownNames(conversion, {
      entryCampaignNames: new Map([["campaign-1", "Spring Launch"]]),
      productCampaignNames: new Map([["campaign-2", "Product Push"]]),
      experienceNames: new Map([["experience-1", "Tasting Room"]]),
      creatorNames: new Map([["creator-1", "Jordan Rivera"]]),
      lessonNames: new Map([["lesson-1", "Intro to Terroir"]]),
      productNames: new Map([["product-1", "Estate Cabernet"]]),
    });

    // Untouched fields pass through byte-for-byte.
    assert.equal(enriched.attributedOrders, conversion.attributedOrders);
    assert.deepEqual(enriched.grossAttributedRevenueByCurrency, conversion.grossAttributedRevenueByCurrency);
    assert.deepEqual(enriched.attributedOrdersByProvider, conversion.attributedOrdersByProvider);

    // Every breakdown row now carries its resolved name alongside the count.
    assert.deepEqual(enriched.attributedOrdersByEntryCampaign, [
      { id: "campaign-1", name: "Spring Launch", orders: 1 },
    ]);
    assert.deepEqual(enriched.attributedOrdersByProductCampaign, [
      { id: "campaign-2", name: "Product Push", orders: 1 },
    ]);
    assert.deepEqual(enriched.attributedOrdersByExperience, [
      { id: "experience-1", name: "Tasting Room", orders: 1 },
    ]);
    assert.deepEqual(enriched.attributedOrdersByCreator, [
      { id: "creator-1", name: "Jordan Rivera", orders: 1 },
    ]);
    assert.deepEqual(enriched.attributedOrdersByLesson, [
      { id: "lesson-1", name: "Intro to Terroir", orders: 1 },
    ]);
    assert.deepEqual(enriched.attributedOrdersByProduct, [
      { id: "product-1", name: "Estate Cabernet", orders: 1 },
    ]);
  });

  test("an id already dropped by buildConversionAnalytics (e.g. a foreign campaign nulled by the route) never appears — enrichment cannot reintroduce a redacted dimension", () => {
    const conversion = buildConversionAnalytics([
      baseOrder({
        attribution: {
          entryCampaignId: null, // as if a foreign campaign was already nulled by ownedCampaignId()
          productCampaignId: null,
          experienceId: "experience-1",
          creatorProfileId: "creator-1",
          lessonId: "lesson-1",
          connectedProductId: "product-1",
        },
      }),
    ]);
    const enriched = enrichBrandConversionBreakdownNames(conversion, {
      // Even if a name were somehow supplied for a foreign campaign id, there
      // is no id in the breakdown to attach it to.
      entryCampaignNames: new Map([["some-other-brands-campaign", "Should never appear"]]),
      productCampaignNames: new Map(),
      experienceNames: new Map([["experience-1", "Tasting Room"]]),
      creatorNames: new Map(),
      lessonNames: new Map(),
      productNames: new Map(),
    });
    assert.deepEqual(enriched.attributedOrdersByEntryCampaign, []);
    assert.deepEqual(enriched.attributedOrdersByProductCampaign, []);
    const serialized = JSON.stringify(enriched);
    assert.ok(!serialized.includes("Should never appear"));
  });
});
