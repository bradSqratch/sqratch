import { NextRequest, NextResponse } from "next/server";
import { getBrandAdminContext, getBrandContextFailure } from "@/lib/brand-auth";
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
 *
 * PHASE 24 — PART 11: every breakdown below is additionally enriched with a
 * display `name` (see `enrichBrandConversionBreakdownNames`), a pure,
 * separately-tested function. The entry/product campaign name lookups reuse
 * the SAME brand-scoped `Campaign` read `ownedCampaignId` already performs —
 * by the time an id reaches the breakdown it has already survived that
 * ownership check, so no new disclosure logic is needed, only a name
 * attachment. Experience/Lesson/product/Creator names are resolved from ids
 * that came ONLY from this brand's own attributed orders, never from client
 * input, mirroring the precedent already set by `topExperiences`/
 * `topLessons` in `src/app/api/brand/analytics/commerce/route.ts` (which
 * likewise resolves those without a redundant ownership re-check).
 */
function ownedCampaignId(
  campaign: { id: string; brandId: string } | null,
  brandId: string,
): string | null {
  return campaign && campaign.brandId === brandId ? campaign.id : null;
}

/** Distinct, non-empty id list — every name loader below is called with this. */
function distinctIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

async function loadCampaignNames(ids: readonly string[], brandId: string): Promise<Map<string, string | null>> {
  const distinct = distinctIds(ids);
  if (distinct.length === 0) return new Map();
  const rows = await prisma.campaign.findMany({
    where: { id: { in: distinct }, brandId },
    select: { id: true, name: true },
  });
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function loadExperienceNames(ids: readonly string[]): Promise<Map<string, string | null>> {
  const distinct = distinctIds(ids);
  if (distinct.length === 0) return new Map();
  const rows = await prisma.experience.findMany({
    where: { id: { in: distinct } },
    select: { id: true, title: true },
  });
  return new Map(rows.map((row) => [row.id, row.title]));
}

async function loadLessonNames(ids: readonly string[]): Promise<Map<string, string | null>> {
  const distinct = distinctIds(ids);
  if (distinct.length === 0) return new Map();
  const rows = await prisma.lesson.findMany({
    where: { id: { in: distinct } },
    select: { id: true, title: true },
  });
  return new Map(rows.map((row) => [row.id, row.title]));
}

/**
 * `CreatorProfile.displayName` for creators appearing in this brand's OWN
 * attributed conversions. Not a new disclosure boundary: a brand already
 * necessarily knows which creators are promoting its commerce (campaign
 * assignment, Experience sponsorship), and this id only ever comes from an
 * order this brand itself received — never from another tenant's data.
 */
async function loadCreatorNames(ids: readonly string[]): Promise<Map<string, string | null>> {
  const distinct = distinctIds(ids);
  if (distinct.length === 0) return new Map();
  const rows = await prisma.creatorProfile.findMany({
    where: { id: { in: distinct } },
    select: { id: true, displayName: true },
  });
  return new Map(rows.map((row) => [row.id, row.displayName]));
}

/**
 * `ConnectedCommerceProduct.title` — the CANONICAL synced title, not the
 * brand's curated `BrandCommerceProduct.titleOverride`. Order attribution
 * (`CommerceOrderLineItem.connectedProductId` /
 * `CommerceClickAttribution.connectedProductId`) references
 * `ConnectedCommerceProduct` directly, never the per-brand curated row, so
 * that is the id space this breakdown is actually keyed on. `brandId` is a
 * genuine (non-redundant) filter here: `ConnectedCommerceProduct.brandId` is
 * a real column, checked defensively even though every id in scope already
 * came from one of this brand's own orders.
 */
async function loadConnectedProductNames(
  ids: readonly string[],
  brandId: string,
): Promise<Map<string, string | null>> {
  const distinct = distinctIds(ids);
  if (distinct.length === 0) return new Map();
  const rows = await prisma.connectedCommerceProduct.findMany({
    where: { id: { in: distinct }, brandId },
    select: { id: true, title: true },
  });
  return new Map(rows.map((row) => [row.id, row.title]));
}

export type BrandConversionAnalyticsData = ReturnType<typeof buildConversionAnalytics> & {
  attributedOrdersByEntryCampaign: ConversionNamedBreakdownRow[];
  attributedOrdersByProductCampaign: ConversionNamedBreakdownRow[];
  attributedOrdersByExperience: ConversionNamedBreakdownRow[];
  attributedOrdersByCreator: ConversionNamedBreakdownRow[];
  attributedOrdersByLesson: ConversionNamedBreakdownRow[];
  attributedOrdersByProduct: ConversionNamedBreakdownRow[];
};

/**
 * PURE. Attaches a resolved display name onto every breakdown row —
 * everything else from `buildConversionAnalytics` (counts, per-currency
 * revenue, the provider breakdown) passes through unchanged. Exported and
 * unit-tested directly with plain `Map`s, no Prisma required — see
 * `tests/conversion-breakdown-naming.test.ts`.
 */
export function enrichBrandConversionBreakdownNames(
  conversion: ReturnType<typeof buildConversionAnalytics>,
  names: {
    entryCampaignNames: ReadonlyMap<string, string | null>;
    productCampaignNames: ReadonlyMap<string, string | null>;
    experienceNames: ReadonlyMap<string, string | null>;
    creatorNames: ReadonlyMap<string, string | null>;
    lessonNames: ReadonlyMap<string, string | null>;
    productNames: ReadonlyMap<string, string | null>;
  },
): BrandConversionAnalyticsData {
  return {
    ...conversion,
    attributedOrdersByEntryCampaign: attachConversionNames(
      conversion.attributedOrdersByEntryCampaign,
      names.entryCampaignNames,
    ),
    attributedOrdersByProductCampaign: attachConversionNames(
      conversion.attributedOrdersByProductCampaign,
      names.productCampaignNames,
    ),
    attributedOrdersByExperience: attachConversionNames(
      conversion.attributedOrdersByExperience,
      names.experienceNames,
    ),
    attributedOrdersByCreator: attachConversionNames(conversion.attributedOrdersByCreator, names.creatorNames),
    attributedOrdersByLesson: attachConversionNames(conversion.attributedOrdersByLesson, names.lessonNames),
    attributedOrdersByProduct: attachConversionNames(conversion.attributedOrdersByProduct, names.productNames),
  };
}

function idsOf(rows: readonly ConversionCountRow[]): string[] {
  return rows.map((row) => row.id);
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

  const conversion = buildConversionAnalytics(scoped);

  const [entryCampaignNames, productCampaignNames, experienceNames, creatorNames, lessonNames, productNames] =
    await Promise.all([
      loadCampaignNames(idsOf(conversion.attributedOrdersByEntryCampaign), brandId),
      loadCampaignNames(idsOf(conversion.attributedOrdersByProductCampaign), brandId),
      loadExperienceNames(idsOf(conversion.attributedOrdersByExperience)),
      loadCreatorNames(idsOf(conversion.attributedOrdersByCreator)),
      loadLessonNames(idsOf(conversion.attributedOrdersByLesson)),
      loadConnectedProductNames(idsOf(conversion.attributedOrdersByProduct), brandId),
    ]);

  const enriched = enrichBrandConversionBreakdownNames(conversion, {
    entryCampaignNames,
    productCampaignNames,
    experienceNames,
    creatorNames,
    lessonNames,
    productNames,
  });

  return NextResponse.json({
    data: {
      range: { start: range.range.start.toISOString(), end: range.range.end.toISOString() },
      ...enriched,
    },
  });
}
