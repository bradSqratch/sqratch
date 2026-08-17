import { NextRequest, NextResponse } from "next/server";
import { getCreatorContext } from "@/lib/creator-auth";
import prisma from "@/lib/prisma";
import { resolveCommerceClickAnalyticsDateRange } from "@/lib/commerce/commerce-click-analytics";
import {
  buildConversionAnalytics,
  type ConversionAnalyticsOrder,
} from "@/lib/commerce/order-analytics";

/**
 * CREATOR-side conversion analytics. Scoped solely through clicks this creator
 * produced (`CommerceClickAttribution.creatorProfileId`), never through a
 * brand, a campaign, or request input.
 *
 * WHAT THIS ROUTE DELIBERATELY DOES NOT DISCLOSE, and why — the same boundary
 * `src/app/api/creator/analytics/commerce/route.ts` already draws for clicks:
 *
 *   - CAMPAIGN IDS. A creator's Experience can be commerce-sponsored, so the
 *     clicks in scope legitimately carry a sponsoring brand's entry/product
 *     campaign ids. Those belong to the brand, not the creator, so both are
 *     nulled before aggregation and the two campaign breakdowns are therefore
 *     always empty here. The brand-side sibling route discloses a campaign id
 *     only to the brand that owns it.
 *   - ORDER BASKET COMPOSITION. `CommerceOrderLineItem` rows describe the
 *     WHOLE order, including the merchant's other products that this creator
 *     never promoted. Passing an empty line-item set makes the product
 *     breakdown fall back to the click's own `connectedProductId` — the
 *     product the creator actually drove traffic to, which is the only product
 *     dimension a creator has a claim to.
 *
 * This route reports CONVERSIONS (persisted `CommerceOrder` rows linked by an
 * exact click-token match). It is a sibling of, never merged into, the
 * click-only analytics route: clicks and conversions are separate counts and
 * are never summed into one number.
 */
export async function GET(request: NextRequest) {
  const context = await getCreatorContext();
  if (!context) return NextResponse.json({ error: "Creator access required." }, { status: 403 });
  const range = resolveCommerceClickAnalyticsDateRange({
    dateFrom: request.nextUrl.searchParams.get("dateFrom"),
    dateTo: request.nextUrl.searchParams.get("dateTo"),
    now: new Date(),
  });
  if (!range.ok) return NextResponse.json({ error: range.error }, { status: 400 });

  const rows = await prisma.commerceOrder.findMany({
    where: {
      createdAt: { gte: range.range.start, lte: range.range.end },
      attribution: { is: { creatorProfileId: context.creatorProfile.id } },
    },
    select: {
      provider: true, financialStatus: true, currencyCode: true, totalMinor: true, totalRefundedMinor: true, netRevenueMinor: true,
      // No campaign id and no line item is selected at all: a column that is
      // never read cannot be leaked by a later refactor of the shared builder.
      attribution: { select: { experienceId: true, creatorProfileId: true, lessonId: true, connectedProductId: true } },
    },
  });

  const scoped: ConversionAnalyticsOrder[] = rows.map((row) => ({
    provider: row.provider,
    financialStatus: row.financialStatus,
    currencyCode: row.currencyCode,
    totalMinor: row.totalMinor,
    totalRefundedMinor: row.totalRefundedMinor,
    netRevenueMinor: row.netRevenueMinor,
    lineItems: [],
    attribution: row.attribution
      ? {
          entryCampaignId: null,
          productCampaignId: null,
          experienceId: row.attribution.experienceId,
          creatorProfileId: row.attribution.creatorProfileId,
          lessonId: row.attribution.lessonId,
          connectedProductId: row.attribution.connectedProductId,
        }
      : null,
  }));

  return NextResponse.json({ data: { range: { start: range.range.start.toISOString(), end: range.range.end.toISOString() }, ...buildConversionAnalytics(scoped) } });
}
