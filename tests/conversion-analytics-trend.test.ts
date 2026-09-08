/**
 * tests/conversion-analytics-trend.test.ts
 *
 * PHASE D — daily conversion/revenue trend: bucketing, zero-fill, range
 * boundaries, gross/refund/net arithmetic per financial status, multi-currency
 * separation, BigInt safety, runtime validation, and the disclosure
 * boundaries both dashboards must keep.
 *
 * All pure. No database, no network.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommerceProvider } from "@prisma/client";

import {
  buildConversionDailyTrend,
  type ConversionTrendOrder,
} from "../src/lib/commerce/order-analytics";
import {
  currenciesInTrend,
  minorForCurrency,
  parseConversionDailyTrend,
  formatMoneyRows,
} from "../src/lib/commerce/conversion-analytics-client";

const MAX_DAYS = 400;
const RANGE = { start: new Date("2026-08-01T00:00:00.000Z"), end: new Date("2026-08-05T23:59:59.999Z") };

function executableSource(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function order(overrides: Partial<ConversionTrendOrder> = {}): ConversionTrendOrder {
  return {
    provider: CommerceProvider.COMMERCE7,
    financialStatus: "PAID",
    currencyCode: "CAD",
    totalMinor: BigInt(1000),
    totalRefundedMinor: BigInt(0),
    netRevenueMinor: BigInt(1000),
    orderDate: new Date("2026-08-01T12:00:00.000Z"),
    attribution: {
      entryCampaignId: null,
      productCampaignId: null,
      experienceId: "exp-1",
      creatorProfileId: "creator-1",
      lessonId: null,
      connectedProductId: "prod-1",
    },
    lineItems: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Bucketing
// ---------------------------------------------------------------------------

describe("PHASE D — daily bucketing", () => {
  test("orders are bucketed into UTC calendar days keyed YYYY-MM-DD", () => {
    const trend = buildConversionDailyTrend(
      [order({ orderDate: new Date("2026-08-01T23:59:59.000Z") })],
      RANGE,
      MAX_DAYS,
    );
    assert.equal(trend[0].date, "2026-08-01");
    assert.equal(trend[0].attributedOrders, 1);
  });

  test("an order just past UTC midnight lands in the NEXT day's bucket", () => {
    const trend = buildConversionDailyTrend(
      [order({ orderDate: new Date("2026-08-02T00:00:00.001Z") })],
      RANGE,
      MAX_DAYS,
    );
    assert.equal(trend[0].attributedOrders, 0, "Aug 1 must be empty");
    assert.equal(trend[1].date, "2026-08-02");
    assert.equal(trend[1].attributedOrders, 1);
  });

  test("MISSING DAYS ARE ZERO-FILLED, never skipped", () => {
    const trend = buildConversionDailyTrend(
      [
        order({ orderDate: new Date("2026-08-01T10:00:00.000Z") }),
        order({ orderDate: new Date("2026-08-03T10:00:00.000Z") }),
      ],
      RANGE,
      MAX_DAYS,
    );
    assert.deepEqual(
      trend.map((p) => p.date),
      ["2026-08-01", "2026-08-02", "2026-08-03", "2026-08-04", "2026-08-05"],
    );
    assert.equal(trend[1].attributedOrders, 0, "Aug 2 must be present as an explicit zero");
    assert.deepEqual(trend[1].grossRevenueByCurrency, []);
  });

  test("every day in the range is emitted even with no orders at all", () => {
    const trend = buildConversionDailyTrend([], RANGE, MAX_DAYS);
    assert.equal(trend.length, 5);
    assert.ok(trend.every((p) => p.attributedOrders === 0));
  });

  test("orders OUTSIDE the range are excluded", () => {
    const trend = buildConversionDailyTrend(
      [
        order({ orderDate: new Date("2026-07-31T23:59:59.000Z") }),
        order({ orderDate: new Date("2026-08-06T00:00:00.000Z") }),
        order({ orderDate: new Date("2026-08-02T10:00:00.000Z") }),
      ],
      RANGE,
      MAX_DAYS,
    );
    const total = trend.reduce((sum, p) => sum + p.attributedOrders, 0);
    assert.equal(total, 1, "only the in-range order counts");
  });

  test("range boundaries are inclusive on both ends", () => {
    const trend = buildConversionDailyTrend(
      [
        order({ orderDate: RANGE.start }),
        order({ orderDate: RANGE.end }),
      ],
      RANGE,
      MAX_DAYS,
    );
    assert.equal(trend[0].attributedOrders, 1);
    assert.equal(trend[trend.length - 1].attributedOrders, 1);
  });

  test("a single-day range yields exactly one bucket", () => {
    const day = new Date("2026-08-01T00:00:00.000Z");
    const trend = buildConversionDailyTrend([order({ orderDate: day })], { start: day, end: day }, MAX_DAYS);
    assert.equal(trend.length, 1);
  });

  test("an inverted range yields an empty series rather than looping", () => {
    assert.deepEqual(
      buildConversionDailyTrend([], { start: RANGE.end, end: RANGE.start }, MAX_DAYS),
      [],
    );
  });

  test("the series is CAPPED for operational safety", () => {
    const trend = buildConversionDailyTrend(
      [],
      { start: new Date("2020-01-01T00:00:00.000Z"), end: new Date("2030-01-01T00:00:00.000Z") },
      10,
    );
    assert.equal(trend.length, 10);
  });

  test("UNATTRIBUTED orders never appear in the trend — it mirrors the headline attributed figures", () => {
    const trend = buildConversionDailyTrend(
      [order({ attribution: null }), order()],
      RANGE,
      MAX_DAYS,
    );
    assert.equal(trend[0].attributedOrders, 1);
  });

  test("an order with an unparseable date is skipped rather than crashing the series", () => {
    const trend = buildConversionDailyTrend(
      [order({ orderDate: new Date("nonsense") }), order()],
      RANGE,
      MAX_DAYS,
    );
    assert.equal(trend.reduce((s, p) => s + p.attributedOrders, 0), 1);
  });
});

// ---------------------------------------------------------------------------
// Money arithmetic across financial statuses
// ---------------------------------------------------------------------------

describe("PHASE D — gross / refunded / net arithmetic", () => {
  test("a PAID order contributes gross and net, and a KNOWN-ZERO refund", () => {
    const trend = buildConversionDailyTrend([order()], RANGE, MAX_DAYS);
    assert.deepEqual(trend[0].grossRevenueByCurrency, [{ currencyCode: "CAD", minor: "1000" }]);
    // A real `0` row, NOT an empty array — and deliberately so. The order
    // genuinely reports a refunded amount of zero, which is different from
    // "this currency had no activity at all today" (which IS the empty
    // array, see the zero-fill test above). This matches the headline
    // `refundedRevenueByCurrency` semantics exactly, because the trend
    // reuses the very same currency-grouping function.
    assert.deepEqual(trend[0].refundedRevenueByCurrency, [{ currencyCode: "CAD", minor: "0" }]);
    assert.deepEqual(trend[0].netRevenueByCurrency, [{ currencyCode: "CAD", minor: "1000" }]);
    assert.equal(trend[0].currentlyNetPositivePaidOrders, 1);
  });

  test("a day with NO attributed orders has genuinely EMPTY money arrays — distinct from a known zero", () => {
    const trend = buildConversionDailyTrend(
      [order({ orderDate: new Date("2026-08-01T10:00:00.000Z") })],
      RANGE,
      MAX_DAYS,
    );
    const emptyDay = trend[1];
    assert.equal(emptyDay.date, "2026-08-02");
    assert.deepEqual(emptyDay.grossRevenueByCurrency, []);
    assert.deepEqual(emptyDay.refundedRevenueByCurrency, []);
    assert.deepEqual(emptyDay.netRevenueByCurrency, []);
  });

  test("the real #1002 PARTIALLY_REFUNDED shape: gross 9831, refunded 3277, net 6554, still net-positive", () => {
    const trend = buildConversionDailyTrend(
      [
        order({
          financialStatus: "PARTIALLY_REFUNDED",
          totalMinor: BigInt(9831),
          totalRefundedMinor: BigInt(3277),
          netRevenueMinor: BigInt(6554),
        }),
      ],
      RANGE,
      MAX_DAYS,
    );
    assert.deepEqual(trend[0].grossRevenueByCurrency, [{ currencyCode: "CAD", minor: "9831" }]);
    assert.deepEqual(trend[0].refundedRevenueByCurrency, [{ currencyCode: "CAD", minor: "3277" }]);
    assert.deepEqual(trend[0].netRevenueByCurrency, [{ currencyCode: "CAD", minor: "6554" }]);
    assert.equal(trend[0].currentlyNetPositivePaidOrders, 1);
  });

  test("a FULLY REFUNDED order keeps gross and refund but contributes NO net, and is not net-positive", () => {
    const trend = buildConversionDailyTrend(
      [
        order({
          financialStatus: "REFUNDED",
          totalMinor: BigInt(9831),
          totalRefundedMinor: BigInt(9831),
          netRevenueMinor: BigInt(0),
        }),
      ],
      RANGE,
      MAX_DAYS,
    );
    assert.deepEqual(trend[0].grossRevenueByCurrency, [{ currencyCode: "CAD", minor: "9831" }]);
    assert.deepEqual(trend[0].refundedRevenueByCurrency, [{ currencyCode: "CAD", minor: "9831" }]);
    assert.deepEqual(trend[0].netRevenueByCurrency, [], "a fully refunded order is not currently net-positive");
    assert.equal(trend[0].currentlyNetPositivePaidOrders, 0);
    assert.equal(trend[0].attributedOrders, 1, "it is still an attributed order");
  });

  test("PENDING / AUTHORIZED / VOIDED orders count as attributed but never as current paid conversions", () => {
    for (const status of ["PENDING", "AUTHORIZED", "VOIDED"] as const) {
      const trend = buildConversionDailyTrend(
        [order({ financialStatus: status })],
        RANGE,
        MAX_DAYS,
      );
      assert.equal(trend[0].attributedOrders, 1, status);
      assert.equal(trend[0].currentlyNetPositivePaidOrders, 0, status);
      assert.deepEqual(trend[0].netRevenueByCurrency, [], status);
    }
  });

  test("multiple orders on the SAME day and currency sum together", () => {
    const trend = buildConversionDailyTrend(
      [order({ totalMinor: BigInt(1000), netRevenueMinor: BigInt(1000) }),
       order({ totalMinor: BigInt(2500), netRevenueMinor: BigInt(2500) })],
      RANGE,
      MAX_DAYS,
    );
    assert.deepEqual(trend[0].grossRevenueByCurrency, [{ currencyCode: "CAD", minor: "3500" }]);
    assert.equal(trend[0].attributedOrders, 2);
  });
});

// ---------------------------------------------------------------------------
// Currency separation
// ---------------------------------------------------------------------------

describe("PHASE D — currencies are never combined", () => {
  test("CAD and USD on the SAME day stay two separate rows — never one summed number", () => {
    const trend = buildConversionDailyTrend(
      [
        order({ currencyCode: "CAD", totalMinor: BigInt(10000), netRevenueMinor: BigInt(10000) }),
        order({ currencyCode: "USD", totalMinor: BigInt(20000), netRevenueMinor: BigInt(20000) }),
      ],
      RANGE,
      MAX_DAYS,
    );
    assert.deepEqual(trend[0].grossRevenueByCurrency, [
      { currencyCode: "CAD", minor: "10000" },
      { currencyCode: "USD", minor: "20000" },
    ]);
    const serialized = JSON.stringify(trend);
    assert.ok(!serialized.includes("30000"), "CAD + USD must never be summed");
  });

  test("a trend point has NO combined-total field at all — the shape makes the mistake unrepresentable", () => {
    const trend = buildConversionDailyTrend([order()], RANGE, MAX_DAYS);
    const keys = Object.keys(trend[0]);
    assert.deepEqual(keys.sort(), [
      "attributedOrders",
      "currentlyNetPositivePaidOrders",
      "date",
      "grossRevenueByCurrency",
      "netRevenueByCurrency",
      "refundedRevenueByCurrency",
    ]);
    for (const forbidden of ["totalRevenue", "revenue", "grossRevenue", "combined"]) {
      assert.ok(!keys.includes(forbidden));
    }
  });

  test("an UNKNOWN currency stays its own bucket, never folded into a real currency", () => {
    const trend = buildConversionDailyTrend(
      [
        order({ currencyCode: "CAD", totalMinor: BigInt(1000), netRevenueMinor: BigInt(1000) }),
        order({ currencyCode: null, totalMinor: BigInt(500), netRevenueMinor: BigInt(500) }),
      ],
      RANGE,
      MAX_DAYS,
    );
    assert.deepEqual(trend[0].grossRevenueByCurrency, [
      { currencyCode: "CAD", minor: "1000" },
      { currencyCode: "UNKNOWN", minor: "500" },
    ]);
  });

  test("JPY (exponent 0), CAD (2) and a 3-decimal currency each render at their OWN exponent", () => {
    assert.equal(formatMoneyRows([{ currencyCode: "JPY", minor: "5000" }])[0], "JPY 5,000");
    assert.equal(formatMoneyRows([{ currencyCode: "CAD", minor: "9831" }])[0], "CAD 98.31");
    assert.equal(formatMoneyRows([{ currencyCode: "KWD", minor: "12345" }])[0], "KWD 12.345");
  });

  test("UNKNOWN renders as an explicit minor-unit count — never a fabricated symbol or exponent", () => {
    const rendered = formatMoneyRows([{ currencyCode: "UNKNOWN", minor: "9831" }])[0];
    assert.match(rendered, /unknown currency/i);
    assert.match(rendered, /9831/);
    assert.doesNotMatch(rendered, /\$|98\.31/);
  });

  test("currenciesInTrend lists every currency present, with UNKNOWN last", () => {
    const trend = buildConversionDailyTrend(
      [
        order({ currencyCode: "USD" }),
        order({ currencyCode: "CAD" }),
        order({ currencyCode: null }),
      ],
      RANGE,
      MAX_DAYS,
    );
    assert.deepEqual(currenciesInTrend(trend), ["CAD", "USD", "UNKNOWN"]);
  });

  test("minorForCurrency returns null for a currency absent that day — distinct from a real zero", () => {
    const trend = buildConversionDailyTrend([order({ currencyCode: "CAD" })], RANGE, MAX_DAYS);
    assert.equal(minorForCurrency(trend[0].grossRevenueByCurrency, "CAD"), "1000");
    assert.equal(minorForCurrency(trend[0].grossRevenueByCurrency, "USD"), null);
  });
});

// ---------------------------------------------------------------------------
// BigInt safety
// ---------------------------------------------------------------------------

describe("PHASE D — BigInt safety", () => {
  test("amounts beyond Number.MAX_SAFE_INTEGER are exact decimal strings, never floats", () => {
    const huge = BigInt("9007199254740993"); // 2^53 + 1
    const trend = buildConversionDailyTrend(
      [order({ totalMinor: huge, netRevenueMinor: huge })],
      RANGE,
      MAX_DAYS,
    );
    assert.equal(trend[0].grossRevenueByCurrency[0].minor, "9007199254740993");
    assert.equal(typeof trend[0].grossRevenueByCurrency[0].minor, "string");
  });

  test("the trend builder never converts money through Number()", () => {
    const source = executableSource(
      readFileSync(join(process.cwd(), "src/lib/commerce/order-analytics.ts"), "utf8"),
    );
    assert.doesNotMatch(source, /Number\((?:row|amount|minor|total)/);
    assert.doesNotMatch(source, /parseFloat/);
    assert.doesNotMatch(source, /\/\s*100\b/);
  });
});

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

describe("PHASE D — runtime trend validation", () => {
  function point(overrides: Record<string, unknown> = {}) {
    return {
      date: "2026-08-01",
      attributedOrders: 1,
      currentlyNetPositivePaidOrders: 1,
      grossRevenueByCurrency: [{ currencyCode: "CAD", minor: "1000" }],
      refundedRevenueByCurrency: [],
      netRevenueByCurrency: [{ currencyCode: "CAD", minor: "1000" }],
      ...overrides,
    };
  }

  test("a valid trend parses", () => {
    assert.deepEqual(parseConversionDailyTrend([point()])?.length, 1);
  });

  test("an ABSENT trend is [] (an older server is not an error), but a MALFORMED one is null", () => {
    assert.deepEqual(parseConversionDailyTrend(undefined), []);
    assert.deepEqual(parseConversionDailyTrend(null), []);
    assert.equal(parseConversionDailyTrend("nope"), null);
    assert.equal(parseConversionDailyTrend({}), null);
  });

  test("a malformed bucket key is rejected — it would silently mis-order the series", () => {
    assert.equal(parseConversionDailyTrend([point({ date: "2026-8-1" })]), null);
    assert.equal(parseConversionDailyTrend([point({ date: "not-a-date" })]), null);
  });

  test("a malformed money row or count is rejected", () => {
    assert.equal(parseConversionDailyTrend([point({ attributedOrders: "one" })]), null);
    assert.equal(
      parseConversionDailyTrend([point({ grossRevenueByCurrency: [{ currencyCode: "CAD", minor: 1000 }] })]),
      null,
    );
    assert.equal(parseConversionDailyTrend([point({ netRevenueByCurrency: "nope" })]), null);
  });

  test("ONE malformed point rejects the whole trend", () => {
    assert.equal(parseConversionDailyTrend([point(), point({ date: "bad" })]), null);
  });
});

// ---------------------------------------------------------------------------
// Dashboard wiring / disclosure boundaries
// ---------------------------------------------------------------------------

describe("PHASE D — dashboard wiring and boundaries", () => {
  const brand = readFileSync(
    join(process.cwd(), "src/app/(withSidebar)/dashboard/brand/analytics/page.tsx"),
    "utf8",
  );
  const creator = readFileSync(
    join(process.cwd(), "src/app/(withSidebar)/dashboard/creator/analytics/page.tsx"),
    "utf8",
  );

  test("both dashboards render the trend", () => {
    assert.match(brand, /<ConversionTrendSection data=\{data\} \/>/);
    assert.match(creator, /<CreatorConversionTrendSection trend=\{data\.dailyTrend\} \/>/);
  });

  test("both render ONE table per currency, never a combined revenue column", () => {
    for (const source of [brand, creator]) {
      assert.match(source, /currenciesInTrend\(trend\)/);
      assert.match(source, /never added together/i);
    }
  });

  test("NO fake conversion rate is introduced on either dashboard", () => {
    for (const source of [executableSource(brand), executableSource(creator)]) {
      assert.doesNotMatch(source, /conversionRate/i);
      assert.doesNotMatch(source, /attributedOrders\s*\/\s*[a-zA-Z_.]*clicks/i);
      assert.doesNotMatch(source, /clicks\s*\/\s*[a-zA-Z_.]*attributedOrders/i);
    }
  });

  test("no chart library was added for this — the trend reuses the existing table idiom", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const charting of ["recharts", "chart.js", "d3", "victory", "nivo", "@nivo/core", "apexcharts"]) {
      assert.ok(!(charting in deps), `no chart dependency should be added: ${charting}`);
    }
  });

  test("Analytics stays READ-ONLY — no reconciliation/webhook controls leak in", () => {
    for (const source of [executableSource(brand), executableSource(creator)]) {
      assert.doesNotMatch(source, /Catch up orders/i);
      assert.doesNotMatch(source, /orders\/catch-up/);
      assert.doesNotMatch(source, /orders\/reconcile-range/);
    }
  });

  test("Brand deep-links to the order explorer filtered to attributed orders", () => {
    // ADVERSARIAL REVIEW ROUND 1 fixed this link: it originally used
    // `attribution=`, which is NOT the parameter the orders API or the
    // explorer toolbar understands, so the link navigated but applied no
    // filter at all. It must use `attributed=`.
    assert.match(brand, /\/dashboard\/brand\/commerce\/orders\?attributed=attributed/);
    assert.doesNotMatch(brand, /orders\?attribution=/);
    assert.match(brand, /View attributed orders/);
  });

  test("the CREATOR dashboard still exposes no campaign dimension anywhere", () => {
    const executable = executableSource(creator);
    assert.doesNotMatch(executable, /attributedOrdersByEntryCampaign/);
    assert.doesNotMatch(executable, /attributedOrdersByProductCampaign/);
    assert.doesNotMatch(executable, /campaignId/);
    assert.doesNotMatch(executable, /campaignName/);
  });

  test("neither dashboard introduces customer PII vocabulary", () => {
    for (const source of [executableSource(brand), executableSource(creator)]) {
      for (const forbidden of [/\bemail\b/i, /\bphone\b/i, /billingAddress/i, /shippingAddress/i, /cardNumber/i]) {
        assert.doesNotMatch(source, forbidden);
      }
    }
  });

  test("wide money tables scroll inside their own container so the page never overflows horizontally", () => {
    for (const source of [brand, creator]) {
      assert.match(source, /max-h-80 overflow-auto/);
      assert.match(source, /min-w-\[420px\]/);
    }
  });

  test("trend tables use scoped table headers for accessibility", () => {
    for (const source of [brand, creator]) {
      assert.match(source, /<th scope="col"/);
    }
  });
});

// ---------------------------------------------------------------------------
// Route wiring — the trend must bucket on the SAME field the range filters on
// ---------------------------------------------------------------------------

describe("PHASE D — route wiring", () => {
  for (const [label, path] of [
    ["brand", "src/app/api/brand/analytics/conversions/route.ts"],
    ["creator", "src/app/api/creator/analytics/conversions/route.ts"],
  ] as const) {
    test(`${label} route selects createdAt and buckets the trend on it — the same column its range filters on`, () => {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      assert.match(source, /createdAt: true/);
      assert.match(source, /orderDate: row\.createdAt/);
      assert.match(source, /createdAt: \{ gte: range\.range\.start, lte: range\.range\.end \}/);
      assert.match(source, /buildConversionDailyTrend\(/);
      assert.match(source, /start: range\.range\.start, end: range\.range\.end/);
      assert.match(source, /dailyTrend,/);
    });
  }

  test("the trend range is capped by the SAME constant the click analytics use", () => {
    for (const path of [
      "src/app/api/brand/analytics/conversions/route.ts",
      "src/app/api/creator/analytics/conversions/route.ts",
    ]) {
      assert.match(readFileSync(join(process.cwd(), path), "utf8"), /MAX_ANALYTICS_RANGE_DAYS/);
    }
  });

  test("the creator route STILL selects no campaign id and no line item", () => {
    const executable = executableSource(
      readFileSync(join(process.cwd(), "src/app/api/creator/analytics/conversions/route.ts"), "utf8"),
    );
    assert.doesNotMatch(executable, /entryCampaignId:\s*true/);
    assert.doesNotMatch(executable, /productCampaignId:\s*true/);
    assert.doesNotMatch(executable, /lineItems:\s*\{/);
    assert.match(executable, /creatorProfileId:\s*context\.creatorProfile\.id/);
  });
});
