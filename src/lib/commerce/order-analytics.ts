import type { CommerceOrderFinancialStatus, CommerceProvider } from "@prisma/client";

export type ConversionAnalyticsOrder = {
  provider: CommerceProvider;
  financialStatus: CommerceOrderFinancialStatus | null;
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

function sumMinor(rows: ConversionAnalyticsOrder[], key: "totalMinor" | "totalRefundedMinor" | "netRevenueMinor"): string {
  return rows.reduce((sum, row) => sum + (row[key] ?? BigInt(0)), BigInt(0)).toString();
}

function sumCurrentNetRevenue(rows: ConversionAnalyticsOrder[]): string {
  return rows.reduce((sum, row) => {
    const contributes =
      row.financialStatus === "PAID" ||
      row.financialStatus === "PARTIALLY_PAID" ||
      row.financialStatus === "PARTIALLY_REFUNDED";
    const net = row.netRevenueMinor ?? BigInt(0);
    return sum + (contributes && net > BigInt(0) ? net : BigInt(0));
  }, BigInt(0)).toString();
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
 * PURE. Aggregates only persisted, exact-token conversions. Minor-unit sums are
 * decimal strings so routes can safely serialize PostgreSQL BigInt values.
 *
 * DISCLOSURE IS THE CALLER'S JOB, NOT THIS FUNCTION'S. Every id handed in is
 * grouped and returned verbatim; this layer has no tenant identity to check one
 * against. A route must therefore null out any dimension its caller is not
 * entitled to BEFORE calling — a nulled id is dropped by `group`. The two
 * conversion routes do exactly that for campaign ids (and, on the creator side,
 * for line items): see `src/app/api/brand/analytics/conversions/route.ts` and
 * `src/app/api/creator/analytics/conversions/route.ts`.
 *
 * `attributedOrdersByProduct` counts ORDERS, not lines: an order carrying the
 * same connected product on several line items contributes ONE to that
 * product's count. When an order has no line items at all (or the caller
 * withheld them), it falls back to the click's own connected product.
 */
export function buildConversionAnalytics(rows: ConversionAnalyticsOrder[]) {
  const attributed = rows.filter(
    (row): row is AttributedConversionOrder => row.attribution !== null,
  );
  const currentNetPositive = attributed.filter(
    (row) =>
      (row.financialStatus === "PAID" ||
        row.financialStatus === "PARTIALLY_PAID" ||
        row.financialStatus === "PARTIALLY_REFUNDED") &&
      (row.netRevenueMinor ?? BigInt(0)) > BigInt(0),
  );
  const pendingOrAuthorized = attributed.filter(
    (row) => row.financialStatus === "PENDING" || row.financialStatus === "AUTHORIZED",
  );
  const grossAttributedRevenueMinor = sumMinor(attributed, "totalMinor");
  const refundedRevenueMinor = sumMinor(attributed, "totalRefundedMinor");
  const netAttributedRevenueMinor = sumCurrentNetRevenue(attributed);
  return {
    totalIngestedOrders: rows.length,
    attributedOrders: attributed.length,
    currentlyNetPositivePaidOrders: currentNetPositive.length,
    pendingOrAuthorizedOrders: pendingOrAuthorized.length,
    partiallyRefundedOrders: attributed.filter((row) => row.financialStatus === "PARTIALLY_REFUNDED").length,
    fullyRefundedOrders: attributed.filter((row) => row.financialStatus === "REFUNDED").length,
    grossAttributedRevenueMinor,
    refundedRevenueMinor,
    netAttributedRevenueMinor,
    // Backward-compatible aliases for existing dashboard consumers.
    paidAttributedOrders: currentNetPositive.length,
    attributedOrderValueMinor: grossAttributedRevenueMinor,
    attributedRefundedValueMinor: refundedRevenueMinor,
    attributedNetRevenueMinor: netAttributedRevenueMinor,
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
