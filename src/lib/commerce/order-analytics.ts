import type { CommerceOrderFinancialStatus, CommerceProvider } from "@prisma/client";

export type ConversionAnalyticsOrder = {
  provider: CommerceProvider;
  financialStatus: CommerceOrderFinancialStatus | null;
  /**
   * ALWAYS the shop's own currency (never a presentment/buyer-facing
   * currency — see the normalizer's file header in
   * `providers/shopify-order-normalizer.ts` for why), and always the SAME
   * currency `totalMinor`/`totalRefundedMinor`/`netRevenueMinor` are
   * denominated in for this one row. `null` only when the source order
   * itself could not resolve a currency (a defensive edge case — every real
   * Shopify order carries one) — such rows are money-labeled `"UNKNOWN"`
   * below, NEVER silently folded into a real currency's total.
   */
  currencyCode: string | null;
  totalMinor: bigint | null;
  totalRefundedMinor: bigint | null;
  netRevenueMinor: bigint | null;
  attribution: {
    entryCampaignId: string | null;
    productCampaignId: string | null;
    experienceId: string;
    creatorProfileId: string | null;
    lessonId: string | null;
    connectedProductId: string | null;
  } | null;
  lineItems: Array<{ connectedProductId: string | null }>;
};

type CountRow = { id: string; orders: number };

/** The honest bucket for a row whose own currency could not be resolved. */
const UNKNOWN_CURRENCY_BUCKET = "UNKNOWN" as const;

export type MinorByCurrencyRow = { currencyCode: string; minor: string };

/**
 * Sums a money field GROUPED BY the row's own currency — the single
 * mechanism that makes cross-currency mixing structurally impossible. Every
 * plain BigInt sum in this module MUST go through this function; a bare
 * `reduce` across rows of potentially different currencies would silently
 * produce a number denominated in nothing (see this module's history: an
 * earlier version summed `totalMinor` directly across all attributed
 * orders, which is meaningless the moment a brand's orders span more than
 * one currency — plausible for any multi-market Shopify setup, or a store
 * that has changed its currency over time).
 *
 * A `null` per-row currency is grouped under `"UNKNOWN"`, never coalesced
 * into a real currency and never dropped silently — the row's amount still
 * counts toward SOME total, visibly flagged as currency-unresolved, so a
 * caller cannot lose track of it.
 *
 * Deterministic order: currency code ascending, `"UNKNOWN"` last.
 */
function sumMinorByCurrency(
  rows: ConversionAnalyticsOrder[],
  key: "totalMinor" | "totalRefundedMinor" | "netRevenueMinor",
  filter?: (row: ConversionAnalyticsOrder) => boolean,
): MinorByCurrencyRow[] {
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    if (filter && !filter(row)) continue;
    const amount = row[key];
    if (amount === null || amount === undefined) continue;
    const currency = row.currencyCode ?? UNKNOWN_CURRENCY_BUCKET;
    totals.set(currency, (totals.get(currency) ?? BigInt(0)) + amount);
  }
  return [...totals.entries()]
    .map(([currencyCode, minor]) => ({ currencyCode, minor: minor.toString() }))
    .sort((a, b) => {
      if (a.currencyCode === UNKNOWN_CURRENCY_BUCKET) return 1;
      if (b.currencyCode === UNKNOWN_CURRENCY_BUCKET) return -1;
      return a.currencyCode.localeCompare(b.currencyCode);
    });
}

function isCurrentNetPositive(row: ConversionAnalyticsOrder): boolean {
  return (
    (row.financialStatus === "PAID" ||
      row.financialStatus === "PARTIALLY_PAID" ||
      row.financialStatus === "PARTIALLY_REFUNDED") &&
    (row.netRevenueMinor ?? BigInt(0)) > BigInt(0)
  );
}

function group(ids: Array<string | null>): CountRow[] {
  const counts = new Map<string, number>();
  for (const id of ids) {
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([id, orders]) => ({ id, orders }))
    .sort((a, b) => b.orders - a.orders || a.id.localeCompare(b.id));
}

type AttributedConversionOrder = ConversionAnalyticsOrder & {
  attribution: NonNullable<ConversionAnalyticsOrder["attribution"]>;
};

/**
 * PURE. Aggregates only persisted, exact-token conversions. Minor-unit sums
 * are ALWAYS grouped by currency (`MinorByCurrencyRow[]`, decimal strings so
 * routes can safely serialize PostgreSQL BigInt values) — never a single
 * flat number, so a brand/creator whose orders span more than one currency
 * can never have those amounts silently added together into one unlabeled
 * total. A caller displaying these MUST render each currency's total
 * separately (e.g. "$1,322.57 CAD" and "$412.00 USD"), never sum the
 * `minor` values across rows itself.
 *
 * DISCLOSURE IS THE CALLER'S JOB, NOT THIS FUNCTION'S. Every id handed in is
 * grouped and returned verbatim; this layer has no tenant identity to check
 * one against. A route must therefore null out any dimension its caller is
 * not entitled to BEFORE calling — a nulled id is dropped by `group`. The
 * two conversion routes do exactly that for campaign ids (and, on the
 * creator side, for line items): see
 * `src/app/api/brand/analytics/conversions/route.ts` and
 * `src/app/api/creator/analytics/conversions/route.ts`.
 *
 * `attributedOrdersByProduct` counts ORDERS, not lines: an order carrying
 * the same connected product on several line items contributes ONE to that
 * product's count. When an order has no line items at all (or the caller
 * withheld them), it falls back to the click's own connected product.
 */
// ---------------------------------------------------------------------------
// PHASE D — DAILY CONVERSION / REVENUE TREND
// ---------------------------------------------------------------------------

/**
 * A trend row is an ordinary conversion row plus the date it is bucketed on.
 *
 * Kept as a SEPARATE type rather than widening `ConversionAnalyticsOrder`
 * so the existing aggregate's contract (and every test pinned to it) is
 * untouched, while the trend builder still REQUIRES a date at its own
 * boundary — a caller cannot silently forget to supply one and get an empty
 * series.
 */
export type ConversionTrendOrder = ConversionAnalyticsOrder & { orderDate: Date };

export type ConversionDailyPoint = {
  /** `YYYY-MM-DD`, UTC. */
  date: string;
  attributedOrders: number;
  currentlyNetPositivePaidOrders: number;
  /**
   * Per-currency money, exactly like the headline figures. There is
   * deliberately NO combined "total revenue" field on a trend point: adding
   * CAD to USD produces a number denominated in nothing. `UNKNOWN` stays
   * `UNKNOWN`.
   */
  grossRevenueByCurrency: MinorByCurrencyRow[];
  refundedRevenueByCurrency: MinorByCurrencyRow[];
  netRevenueByCurrency: MinorByCurrencyRow[];
};

export type ConversionTrendRange = { start: Date; end: Date };

/**
 * PURE. Daily conversion/revenue trend over an inclusive date range.
 *
 * BUCKET SEMANTICS — deliberately the SAME convention the existing click
 * analytics already use (`buildDailyTimeSeries` in
 * `./commerce-click-analytics.ts`), so the two trend surfaces on the same
 * dashboard cannot disagree about what "a day" means:
 *   - buckets are UTC calendar days, keyed `YYYY-MM-DD`;
 *   - every day in the range is emitted, INCLUDING days with no
 *     conversions (zeroed) — a skipped day would read as missing data
 *     rather than as genuine zero activity;
 *   - the series is capped at `MAX_ANALYTICS_RANGE_DAYS` for operational
 *     safety, matching the click series' own ceiling.
 *
 * WHICH DATE IS BUCKETED. `orderDate` is whatever the CALLING ROUTE also
 * FILTERED its range on. That agreement is not incidental — it is what makes
 * the daily series sum back to the headline totals. Bucketing on a different
 * field than the range filter would produce points outside the requested
 * window and a trend that silently disagrees with the summary above it.
 *
 * Only ATTRIBUTED orders contribute, exactly like the headline figures:
 * unattributed orders are counted in `totalIngestedOrders` and nowhere else.
 */
export function buildConversionDailyTrend(
  rows: readonly ConversionTrendOrder[],
  range: ConversionTrendRange,
  maxDays: number,
): ConversionDailyPoint[] {
  const firstBucket = startOfUtcDayMs(range.start);
  const lastBucket = startOfUtcDayMs(range.end);
  if (firstBucket === null || lastBucket === null || lastBucket < firstBucket) {
    return [];
  }

  const attributed = rows.filter(
    (row): row is ConversionTrendOrder & AttributedConversionOrder => row.attribution !== null,
  );

  // Group once, then aggregate per bucket — never a scan of every row per day.
  const byDay = new Map<string, ConversionTrendOrder[]>();
  for (const row of attributed) {
    const at = row.orderDate?.getTime();
    if (at === undefined || Number.isNaN(at)) continue;
    if (at < range.start.getTime() || at > range.end.getTime()) continue;
    const key = toUtcDayKey(row.orderDate);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(row);
    else byDay.set(key, [row]);
  }

  const series: ConversionDailyPoint[] = [];
  for (
    let bucket = firstBucket;
    bucket <= lastBucket && series.length < maxDays;
    bucket += MS_PER_DAY
  ) {
    const key = toUtcDayKey(new Date(bucket));
    const dayRows = byDay.get(key) ?? [];
    series.push({
      date: key,
      attributedOrders: dayRows.length,
      currentlyNetPositivePaidOrders: dayRows.filter(isCurrentNetPositive).length,
      // The SAME currency-grouping function the headline figures use, so a
      // trend point can never diverge from the summary's currency semantics.
      grossRevenueByCurrency: sumMinorByCurrency(dayRows, "totalMinor"),
      refundedRevenueByCurrency: sumMinorByCurrency(dayRows, "totalRefundedMinor"),
      netRevenueByCurrency: sumMinorByCurrency(dayRows, "netRevenueMinor", isCurrentNetPositive),
    });
  }

  return series;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** `YYYY-MM-DD` in UTC — the bucket key, matching the click analytics' own. */
function toUtcDayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** UTC midnight of the day `value` falls in, or `null` for an invalid date. */
function startOfUtcDayMs(value: Date): number | null {
  const time = value.getTime();
  if (Number.isNaN(time)) return null;
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

export function buildConversionAnalytics(rows: ConversionAnalyticsOrder[]) {
  const attributed = rows.filter(
    (row): row is AttributedConversionOrder => row.attribution !== null,
  );
  const currentNetPositive = attributed.filter(isCurrentNetPositive);
  const pendingOrAuthorized = attributed.filter(
    (row) => row.financialStatus === "PENDING" || row.financialStatus === "AUTHORIZED",
  );

  return {
    totalIngestedOrders: rows.length,
    attributedOrders: attributed.length,
    currentlyNetPositivePaidOrders: currentNetPositive.length,
    pendingOrAuthorizedOrders: pendingOrAuthorized.length,
    partiallyRefundedOrders: attributed.filter((row) => row.financialStatus === "PARTIALLY_REFUNDED").length,
    fullyRefundedOrders: attributed.filter((row) => row.financialStatus === "REFUNDED").length,
    // Every money figure below is an ARRAY, one entry per currency present
    // in the underlying rows — see sumMinorByCurrency's doc comment for why
    // this can never be a single flat number.
    grossAttributedRevenueByCurrency: sumMinorByCurrency(attributed, "totalMinor"),
    refundedRevenueByCurrency: sumMinorByCurrency(attributed, "totalRefundedMinor"),
    netAttributedRevenueByCurrency: sumMinorByCurrency(attributed, "netRevenueMinor", isCurrentNetPositive),
    attributedOrdersByProvider: group(attributed.map((row) => row.provider)),
    attributedOrdersByEntryCampaign: group(attributed.map((row) => row.attribution.entryCampaignId)),
    attributedOrdersByProductCampaign: group(attributed.map((row) => row.attribution.productCampaignId)),
    attributedOrdersByExperience: group(attributed.map((row) => row.attribution.experienceId)),
    attributedOrdersByCreator: group(attributed.map((row) => row.attribution.creatorProfileId)),
    attributedOrdersByLesson: group(attributed.map((row) => row.attribution.lessonId)),
    attributedOrdersByProduct: group(
      attributed.flatMap((row) => {
        const lineProducts = row.lineItems.map((item) => item.connectedProductId);
        return lineProducts.length > 0
          ? [...new Set(lineProducts)]
          : [row.attribution.connectedProductId];
      }),
    ),
  };
}
