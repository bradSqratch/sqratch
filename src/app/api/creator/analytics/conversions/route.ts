import { NextRequest, NextResponse } from "next/server";
import { getCreatorContext, getOwnedExperienceForCreator } from "@/lib/creator-auth";
import prisma from "@/lib/prisma";
import { resolveCommerceClickAnalyticsDateRange } from "@/lib/commerce/commerce-click-analytics";
import {
  buildConversionAnalytics,
  type ConversionAnalyticsOrder,
} from "@/lib/commerce/order-analytics";
import {
  attachConversionNames,
  type ConversionCountRow,
  type ConversionNamedBreakdownRow,
} from "@/lib/commerce/conversion-breakdown-naming";

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
 *
 * PHASE 24 — PART 12/13/14:
 *
 *  - Experience/Lesson/product breakdown rows are enriched with a display
 *    `name`, re-scoped to this creator's OWNERSHIP on every read (see the
 *    loaders below) — never resolved from a bare id alone. There is
 *    deliberately no campaign name lookup of any kind: the two campaign
 *    breakdowns are always empty (both ids are nulled above), so there is
 *    nothing to name.
 *  - An optional `experienceId` filter narrows the scope to one owned
 *    Experience, reusing `getOwnedExperienceForCreator` — the EXACT
 *    ownership check `src/app/api/creator/analytics/route.ts` already uses —
 *    so a foreign or unknown Experience id is rejected identically (a
 *    generic 404) before any query runs. This can only ever NARROW the
 *    `creatorProfileId` scope already enforced above; it can never widen or
 *    replace it.
 */
async function loadOwnedExperienceNames(
  ids: readonly string[],
  creatorProfileId: string,
): Promise<Map<string, string | null>> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return new Map();
  const rows = await prisma.experience.findMany({
    where: { id: { in: distinct }, creatorId: creatorProfileId },
    select: { id: true, title: true },
  });
  return new Map(rows.map((row) => [row.id, row.title]));
}

async function loadOwnedLessonNames(
  ids: readonly string[],
  creatorProfileId: string,
): Promise<Map<string, string | null>> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return new Map();
  const rows = await prisma.lesson.findMany({
    where: { id: { in: distinct }, course: { experience: { creatorId: creatorProfileId } } },
    select: { id: true, title: true },
  });
  return new Map(rows.map((row) => [row.id, row.title]));
}

/**
 * `ConnectedCommerceProduct.title` for the product the creator's OWN click
 * actually drove traffic to. Not scoped to a brand: a product's title is
 * public storefront content (see `ConnectedCommerceProduct.productUrl`), and
 * every id here already came only from this creator's own attributed
 * orders, never from another creator's data or from client input.
 */
async function loadPromotedProductNames(ids: readonly string[]): Promise<Map<string, string | null>> {
  const distinct = [...new Set(ids)];
  if (distinct.length === 0) return new Map();
  const rows = await prisma.connectedCommerceProduct.findMany({
    where: { id: { in: distinct } },
    select: { id: true, title: true },
  });
  return new Map(rows.map((row) => [row.id, row.title]));
}

export type CreatorConversionAnalyticsData = ReturnType<typeof buildConversionAnalytics> & {
  attributedOrdersByExperience: ConversionNamedBreakdownRow[];
  attributedOrdersByLesson: ConversionNamedBreakdownRow[];
  attributedOrdersByProduct: ConversionNamedBreakdownRow[];
};

function idsOf(rows: readonly ConversionCountRow[]): string[] {
  return rows.map((row) => row.id);
}

export async function GET(request: NextRequest) {
  const context = await getCreatorContext();
  if (!context) return NextResponse.json({ error: "Creator access required." }, { status: 403 });
  const range = resolveCommerceClickAnalyticsDateRange({
    dateFrom: request.nextUrl.searchParams.get("dateFrom"),
    dateTo: request.nextUrl.searchParams.get("dateTo"),
    now: new Date(),
  });
  if (!range.ok) return NextResponse.json({ error: range.error }, { status: 400 });

  // THE NARROWING CHECK, identical in shape to the click-only creator route:
  // a requested Experience id must be one this creator owns, or the request
  // fails closed with the same generic 404 an unknown id would get — a
  // foreign creator's Experience id is never distinguishable from one that
  // does not exist.
  const requestedExperienceId = request.nextUrl.searchParams.get("experienceId")?.trim() || null;
  if (requestedExperienceId !== null) {
    const owned = await getOwnedExperienceForCreator(requestedExperienceId, context.userId);
    if (!owned) {
      return NextResponse.json({ error: "Experience not found." }, { status: 404 });
    }
  }

  const rows = await prisma.commerceOrder.findMany({
    where: {
      createdAt: { gte: range.range.start, lte: range.range.end },
      attribution: {
        is: {
          creatorProfileId: context.creatorProfile.id,
          ...(requestedExperienceId ? { experienceId: requestedExperienceId } : {}),
        },
      },
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

  const conversion = buildConversionAnalytics(scoped);
  const creatorProfileId = context.creatorProfile.id;

  const [experienceNames, lessonNames, productNames] = await Promise.all([
    loadOwnedExperienceNames(idsOf(conversion.attributedOrdersByExperience), creatorProfileId),
    loadOwnedLessonNames(idsOf(conversion.attributedOrdersByLesson), creatorProfileId),
    loadPromotedProductNames(idsOf(conversion.attributedOrdersByProduct)),
  ]);

  const data: CreatorConversionAnalyticsData = {
    ...conversion,
    attributedOrdersByExperience: attachConversionNames(conversion.attributedOrdersByExperience, experienceNames),
    attributedOrdersByLesson: attachConversionNames(conversion.attributedOrdersByLesson, lessonNames),
    attributedOrdersByProduct: attachConversionNames(conversion.attributedOrdersByProduct, productNames),
  };

  return NextResponse.json({
    data: {
      range: { start: range.range.start.toISOString(), end: range.range.end.toISOString() },
      filters: { experienceId: requestedExperienceId },
      ...data,
    },
  });
}
