import { NextRequest, NextResponse } from "next/server";
import { getBrandAdminContext, getBrandContextFailure } from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { resolveCommerceClickAnalyticsDateRange } from "@/lib/commerce/commerce-click-analytics";
import {
  buildConversionAnalytics,
  type ConversionAnalyticsOrder,
} from "@/lib/commerce/order-analytics";

/**
 * BRAND-side conversion analytics. Scoped through the immutable
 * `CommerceClickAttribution.attributedBrandId` snapshot, exactly like the
 * Phase 11 click-only route.
 *
 * CAMPAIGN IDS ARE DISCLOSED ONLY TO THEIR OWNER. An ENTRY campaign is the
 * acquisition campaign a visitor arrived through and may belong to a DIFFERENT
 * brand than the one that owns the clicked product (see the
 * `CommerceClickAttribution.entryCampaignId` note in `prisma/schema.prisma`),
 * so emitting it verbatim would hand one tenant another tenant's campaign
 * identifier. `src/app/api/brand/analytics/commerce/route.ts` solves this with
 * `discloseEntryCampaign`; this route applies the same rule in its narrowest
 * form — a campaign id survives only when its CURRENT owner is the requesting
 * brand, and is otherwise dropped from the breakdown entirely. Campaign
 * ownership is immutable (`Campaign.brandId`), so this check cannot be raced.
 *
 * This route reports CONVERSIONS (persisted `CommerceOrder` rows linked to an
 * exact click-token match). It is deliberately a sibling of, never merged
 * into, the click-only analytics route: the two count different things and
 * summing them would put two denominators behind one number.
 */
function ownedCampaignId(
  campaign: { id: string; brandId: string } | null,
  brandId: string,
): string | null {
  return campaign && campaign.brandId === brandId ? campaign.id : null;
}

export async function GET(request: NextRequest) {
  const context = await getBrandAdminContext();
  if (!context?.membership?.brand) {
    const failure = getBrandContextFailure(context);
    return NextResponse.json({ error: failure.error, ...(failure.code ? { code: failure.code } : {}) }, { status: failure.status });
  }
  const range = resolveCommerceClickAnalyticsDateRange({
    dateFrom: request.nextUrl.searchParams.get("dateFrom"),
    dateTo: request.nextUrl.searchParams.get("dateTo"),
    now: new Date(),
  });
  if (!range.ok) return NextResponse.json({ error: range.error }, { status: 400 });

  const brandId = context.membership.brand.id;

  const rows = await prisma.commerceOrder.findMany({
    where: {
      createdAt: { gte: range.range.start, lte: range.range.end },
      brandId,
      // A malformed cross-brand historical link is excluded entirely rather
      // than leaking its campaign/Experience dimensions into this tenant.
      OR: [
        { attribution: null },
        { attribution: { is: { attributedBrandId: brandId } } },
      ],
    },
    select: {
      provider: true, financialStatus: true, currencyCode: true, totalMinor: true, totalRefundedMinor: true, netRevenueMinor: true,
      attribution: {
        select: {
          experienceId: true,
          creatorProfileId: true,
          lessonId: true,
          connectedProductId: true,
          // The owner is read alongside the id so a foreign campaign can be
          // dropped before aggregation — never selected as a bare id.
          entryCampaign: { select: { id: true, brandId: true } },
          productCampaign: { select: { id: true, brandId: true } },
        },
      },
      lineItems: { select: { connectedProductId: true } },
    },
  });

  const scoped: ConversionAnalyticsOrder[] = rows.map((row) => ({
    provider: row.provider,
    financialStatus: row.financialStatus,
    currencyCode: row.currencyCode,
    totalMinor: row.totalMinor,
    totalRefundedMinor: row.totalRefundedMinor,
    netRevenueMinor: row.netRevenueMinor,
    lineItems: row.lineItems,
    attribution: row.attribution
      ? {
          entryCampaignId: ownedCampaignId(row.attribution.entryCampaign, brandId),
          productCampaignId: ownedCampaignId(row.attribution.productCampaign, brandId),
          experienceId: row.attribution.experienceId,
          creatorProfileId: row.attribution.creatorProfileId,
          lessonId: row.attribution.lessonId,
          connectedProductId: row.attribution.connectedProductId,
        }
      : null,
  }));

  return NextResponse.json({ data: { range: { start: range.range.start.toISOString(), end: range.range.end.toISOString() }, ...buildConversionAnalytics(scoped) } });
}
