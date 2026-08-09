import { NextRequest, NextResponse } from "next/server";
import {
  getBrandAdminContext,
  getBrandContextFailure,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { resolveCuratedProductTitle } from "@/lib/commerce/campaign-product-curation";
import {
  MAX_TOP_N_LIMIT,
  OTHER_CAMPAIGN_LABEL,
  buildCommerceClickTotals,
  buildDailyTimeSeries,
  buildEntryCampaignBreakdown,
  buildEntrySplit,
  buildProductCampaignBreakdown,
  buildProviderBreakdown,
  buildRankableCounts,
  buildSurfaceBreakdown,
  discloseEntryCampaign,
  resolveCommerceClickAnalyticsDateRange,
  selectTopN,
  type CommerceClickDailyPoint,
  type CommerceClickProviderBreakdownRow,
  type CommerceClickRankableRow,
  type CommerceClickSurfaceBreakdown,
  type DisclosedEntryCampaign,
} from "@/lib/commerce/commerce-click-analytics";
import {
  buildPrismaCommerceClickAnalyticsRepository,
  type BoundedCount,
  type CommerceClickAnalyticsQuery,
  type CommerceClickAnalyticsRepository,
  type CommerceClickAnalyticsScope,
} from "@/lib/commerce/commerce-click-analytics-repository";

/**
 * Phase 11: BRAND-side, CLICK-ONLY commerce analytics.
 *
 * WHY THIS IS A SIBLING ROUTE AND NOT AN EXTENSION OF
 * `src/app/api/brand/analytics/route.ts`.
 * That route reports campaign engagement keyed on `Campaign.id`, and its one
 * commerce number (`shopClicks`) is deliberately narrow: clicks whose TRUSTED
 * ENTRY campaign is one of the brand's own campaigns. This route answers a
 * different question on a different key — every click ATTRIBUTED to the brand
 * (`attributedBrandId`), however the visitor arrived. Folding the two into one
 * response would put two different denominators behind one word ("clicks") and
 * silently redefine an existing, pinned field. The old metric is untouched.
 *
 * SCOPED ON `attributedBrandId`, NEVER `brandId`. `brandId` participates in the
 * composite `(productCampaignId, brandId) -> Campaign(id, brandId)` foreign key,
 * so deleting a product campaign NULLS it and reassigning that campaign to
 * another Brand REWRITES it on every historical row (ON UPDATE CASCADE). A
 * brand's own click history must not be deletable or transferable by an
 * unrelated administrative action. `attributedBrandId` is the durable non-FK
 * snapshot written once at click time, so it is the only correct scope column.
 *
 * CLICKS ONLY. A click is evidence that a visitor was sent to a merchant page.
 * SQRATCH has no mechanism today to learn what happened after that, so this file
 * carries no post-click outcome concept of any kind and none may be added.
 * Reporting a zero for something we cannot measure would be worse than omitting
 * it, so every unsupported metric is omitted from the contract entirely rather
 * than serialized as a misleading 0.
 *
 * THE TWO CAMPAIGN CONCEPTS ARE NEVER SUMMED.
 *   entryCampaignBreakdown   = HOW visitors arrived (acquisition).
 *   productCampaignBreakdown = WHICH campaign authorized the clicked product.
 * One click can appear in both, so adding them double-counts. They are built by
 * two separate queries, carry two mutually incompatible `kind` discriminants,
 * and are serialized under two separate keys. There is deliberately no code path
 * here that concatenates or totals them.
 *
 * MULTI-SPONSOR PRIVACY IS THE HIGHEST-RISK PART OF THIS FILE. A visitor
 * acquired through Brand B's campaign can click Brand A's product on a shared
 * Experience. That click is legitimately Brand A's, and Brand A may see THAT it
 * happened — but must never learn Brand B's campaign id or name, which would
 * leak a competitor's campaign inventory through an analytics panel. Every
 * entry-campaign row therefore passes through `discloseEntryCampaign`, whose
 * return type structurally forces `campaignId`/`campaignName` to null for
 * anything but "OWN". All non-OWN rows are then SUMMED into a single generic
 * bucket, because returning N anonymous rows would still disclose that exactly N
 * distinct other campaigns exist.
 */

/** Top-N size when the caller does not ask for one. */
const DEFAULT_TOP_N = 10;

/**
 * The fail-closed disclosure for an entry campaign whose owner cannot be
 * resolved (for example, the Campaign row was deleted between the group-by and
 * the ownership lookup). Unknown ownership is treated as somebody else's, never
 * as the viewer's.
 */
const UNRESOLVED_ENTRY_CAMPAIGN: DisclosedEntryCampaign = {
  disclosure: "OTHER_CAMPAIGN",
  campaignId: null,
  campaignName: null,
  label: OTHER_CAMPAIGN_LABEL,
};

/** Ownership facts for one campaign id. Read server-side; never serialized as-is. */
export type BrandCommerceCampaignOwner = {
  id: string;
  name: string;
  brandId: string | null;
};

/** A ranked entity resolved to something a panel can render. */
export type BrandCommerceRankedEntity = {
  id: string;
  name: string | null;
  clicks: number;
};

export type BrandCommerceNamedEntity = { id: string; name: string | null };

/**
 * ACQUISITION row. `kind` mirrors the pure layer's discriminant so this can
 * never be concatenated with a product-authorization row by accident, and the
 * `DisclosedEntryCampaign` union makes a cross-tenant id/name unrepresentable
 * outside the "OWN" arm.
 */
export type BrandCommerceEntryCampaignRow = DisclosedEntryCampaign & {
  kind: "ENTRY_CAMPAIGN";
  clicks: number;
};

/**
 * PRODUCT-AUTHORIZATION row.
 *
 * Under normal operation the composite foreign key guarantees these campaigns
 * belong to the authorized brand. The "OTHER_CAMPAIGN" arm exists as
 * defense-in-depth for the documented admin-reassignment edge case: if a
 * campaign's CURRENT `brandId` no longer matches the viewer, showing its name
 * would be both wrong and a disclosure, so the generic bucket is used instead.
 */
export type BrandCommerceProductCampaignRow =
  | {
      kind: "PRODUCT_CAMPAIGN";
      disclosure: "OWN";
      campaignId: string;
      campaignName: string;
      clicks: number;
    }
  | {
      kind: "PRODUCT_CAMPAIGN";
      disclosure: "OTHER_CAMPAIGN";
      campaignId: null;
      campaignName: null;
      label: typeof OTHER_CAMPAIGN_LABEL;
      clicks: number;
    };

export type BrandCommerceAnalyticsData = {
  /** Inclusive UTC bounds actually applied, echoed so a client cannot guess. */
  range: { start: string; end: string };
  /** Top-N size actually applied after clamping. */
  limit: number;
  totals: {
    clicks: number;
    /** Lower bound when `truncated`; render as "at least N", never as exact. */
    uniqueSessions: BoundedCount;
    uniqueUsers: BoundedCount;
    campaignEntryClicks: number;
    directEntryClicks: number;
  };
  timeSeries: CommerceClickDailyPoint[];
  /** True when the underlying timestamp read hit its sampling ceiling. */
  timeSeriesTruncated: boolean;
  surfaceBreakdown: CommerceClickSurfaceBreakdown;
  providerBreakdown: CommerceClickProviderBreakdownRow[];
  entryCampaignBreakdown: BrandCommerceEntryCampaignRow[];
  productCampaignBreakdown: BrandCommerceProductCampaignRow[];
  topProducts: BrandCommerceRankedEntity[];
  topExperiences: BrandCommerceRankedEntity[];
  topLessons: BrandCommerceRankedEntity[];
};

export type BrandCommerceAnalyticsResponse = { data: BrandCommerceAnalyticsData };

/**
 * Injectable dependencies, following
 * `src/app/api/creator/lessons/[lessonId]/available-products/route.ts`. Tests
 * drive the real handler with plain-object doubles instead of a database.
 */
export type BrandCommerceAnalyticsDeps = {
  getBrandContext(): Promise<BrandAdminContext | null>;
  repository: CommerceClickAnalyticsRepository;
  loadCampaignOwners(
    campaignIds: readonly string[],
  ): Promise<BrandCommerceCampaignOwner[]>;
  loadBrandProducts(input: {
    ids: readonly string[];
    brandId: string;
  }): Promise<BrandCommerceNamedEntity[]>;
  loadExperiences(ids: readonly string[]): Promise<BrandCommerceNamedEntity[]>;
  loadLessons(ids: readonly string[]): Promise<BrandCommerceNamedEntity[]>;
  now(): Date;
};

const DEFAULT_DEPS: BrandCommerceAnalyticsDeps = {
  getBrandContext: () => getBrandAdminContext(),
  repository: buildPrismaCommerceClickAnalyticsRepository(),

  /**
   * Ownership lookup for entry campaigns.
   *
   * Reading `{id, name, brandId}` for a campaign id the viewer's own clicks
   * already reference is not itself a disclosure — what must never happen is
   * RETURNING that id or name to a client whose brand does not own it. That
   * decision is made below by `discloseEntryCampaign`, one layer up from this
   * read, exactly so the redaction cannot be skipped by a caller who forgets it.
   */
  async loadCampaignOwners(campaignIds) {
    if (campaignIds.length === 0) return [];
    return prisma.campaign.findMany({
      where: { id: { in: [...campaignIds] } },
      select: { id: true, name: true, brandId: true },
    });
  },

  /**
   * Product display names, read from the viewer's OWN curated catalog only.
   *
   * The `brandId` predicate is redundant with the `attributedBrandId` scope but
   * kept as a second, independent barrier: even a mis-scoped click row can only
   * ever resolve to a name the viewer already owns.
   */
  async loadBrandProducts({ ids, brandId }) {
    if (ids.length === 0) return [];
    const rows = await prisma.brandCommerceProduct.findMany({
      where: { id: { in: [...ids] }, brandId },
      select: {
        id: true,
        titleOverride: true,
        connectedProduct: { select: { title: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      name: resolveCuratedProductTitle({
        title: row.connectedProduct.title,
        titleOverride: row.titleOverride,
      }),
    }));
  },

  async loadExperiences(ids) {
    if (ids.length === 0) return [];
    const rows = await prisma.experience.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, title: true },
    });
    return rows.map((row) => ({ id: row.id, name: row.title }));
  },

  async loadLessons(ids) {
    if (ids.length === 0) return [];
    const rows = await prisma.lesson.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, title: true },
    });
    return rows.map((row) => ({ id: row.id, name: row.title }));
  },

  now: () => new Date(),
};

export async function GET(request: NextRequest) {
  return brandCommerceAnalyticsGetImpl(request);
}

export async function brandCommerceAnalyticsGetImpl(
  request: NextRequest,
  overrides: Partial<BrandCommerceAnalyticsDeps> = {},
) {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const context = await deps.getBrandContext();

    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    // The brand is ALWAYS the authenticated one. There is deliberately no
    // `brandId` query parameter: accepting one would turn a session-derived
    // tenant boundary into a client-supplied string.
    const authorizedBrandId = context.membership.brand.id;

    const params = request.nextUrl.searchParams;

    const limitResult = parseTopNLimit(params.get("limit"));
    if (!limitResult.ok) {
      return NextResponse.json({ error: limitResult.error }, { status: 400 });
    }
    const limit = limitResult.limit;

    const rangeResult = resolveCommerceClickAnalyticsDateRange({
      dateFrom: params.get("dateFrom"),
      dateTo: params.get("dateTo"),
      now: deps.now(),
    });
    if (!rangeResult.ok) {
      return NextResponse.json({ error: rangeResult.error }, { status: 400 });
    }
    const range = rangeResult.range;

    const scope: CommerceClickAnalyticsScope = {
      kind: "ATTRIBUTED_BRAND",
      attributedBrandIds: [authorizedBrandId],
    };
    const query: CommerceClickAnalyticsQuery = { scope, range };

    const [
      clicks,
      uniqueSessions,
      uniqueUsers,
      entryResolutionRows,
      surfaceRows,
      providerRows,
      entryCampaignRows,
      productCampaignRows,
      productRows,
      experienceRows,
      lessonRows,
      timestamps,
    ] = await Promise.all([
      deps.repository.countClicks(query),
      deps.repository.countDistinctSessions(query),
      deps.repository.countDistinctUsers(query),
      deps.repository.countByEntryResolution(query),
      deps.repository.groupBySurface(query),
      deps.repository.groupByProvider(query),
      deps.repository.groupByEntryCampaign(query),
      deps.repository.groupByProductCampaign(query),
      deps.repository.groupByBrandCommerceProduct(query),
      deps.repository.groupByExperience(query),
      deps.repository.groupByLesson(query),
      deps.repository.listClickTimestamps(query),
    ]);

    const totals = buildCommerceClickTotals({
      clicks,
      uniqueSessions: uniqueSessions.value,
      uniqueUsers: uniqueUsers.value,
      entrySplit: buildEntrySplit(entryResolutionRows),
    });

    // ACQUISITION. Built and disclosed entirely separately from the
    // product-authorization breakdown below; the two are never added.
    const entryCampaignBreakdown = await buildDisclosedEntryCampaignBreakdown({
      rows: buildEntryCampaignBreakdown(entryCampaignRows).map((row) => ({
        campaignId: row.campaignId,
        clicks: row.clicks,
      })),
      authorizedBrandId,
      loadCampaignOwners: deps.loadCampaignOwners,
    });

    // PRODUCT AUTHORIZATION. Same-brand by construction under the composite
    // foreign key, but re-verified against each campaign's CURRENT owner.
    const productCampaignBreakdown = await buildVerifiedProductCampaignBreakdown({
      rows: buildProductCampaignBreakdown(productCampaignRows).map((row) => ({
        campaignId: row.campaignId,
        clicks: row.clicks,
      })),
      authorizedBrandId,
      loadCampaignOwners: deps.loadCampaignOwners,
    });

    const topProductRows = rankTop(productRows, limit);
    const topExperienceRows = rankTop(experienceRows, limit);
    const topLessonRows = rankTop(lessonRows, limit);

    const [productNames, experienceNames, lessonNames] = await Promise.all([
      deps.loadBrandProducts({
        ids: topProductRows.map((row) => row.id),
        brandId: authorizedBrandId,
      }),
      deps.loadExperiences(topExperienceRows.map((row) => row.id)),
      deps.loadLessons(topLessonRows.map((row) => row.id)),
    ]);

    const data: BrandCommerceAnalyticsData = {
      range: {
        start: range.start.toISOString(),
        end: range.end.toISOString(),
      },
      limit,
      totals: {
        clicks: totals.clicks,
        // The GUARDED value, never the raw repository number: `truncated` rides
        // alongside it rather than instead of it. Serializing the raw
        // `BoundedCount` here would have quietly skipped the pure layer's
        // NaN/negative guard that every other total goes through, and would have
        // left the guarded values computed-then-discarded. Matches
        // `src/app/api/creator/analytics/commerce/route.ts` exactly.
        uniqueSessions: {
          value: totals.uniqueSessions,
          truncated: uniqueSessions.truncated,
        },
        uniqueUsers: {
          value: totals.uniqueUsers,
          truncated: uniqueUsers.truncated,
        },
        campaignEntryClicks: totals.campaignEntryClicks,
        directEntryClicks: totals.directEntryClicks,
      },
      timeSeries: buildDailyTimeSeries(timestamps.timestamps, range),
      timeSeriesTruncated: timestamps.truncated,
      surfaceBreakdown: buildSurfaceBreakdown(surfaceRows),
      providerBreakdown: buildProviderBreakdown(providerRows),
      entryCampaignBreakdown,
      productCampaignBreakdown,
      topProducts: attachNames(topProductRows, productNames),
      topExperiences: attachNames(topExperienceRows, experienceNames),
      topLessons: attachNames(topLessonRows, lessonNames),
    };

    return NextResponse.json({ data } satisfies BrandCommerceAnalyticsResponse);
  } catch (error) {
    console.error("[brand/analytics/commerce][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load brand commerce click analytics." },
      { status: 500 },
    );
  }
}

/**
 * `limit` is validated, then clamped rather than rejected when it is merely too
 * large: a caller asking for more rows than a panel can show has made a harmless
 * mistake, while a caller sending `limit=abc` has made a real one and deserves a
 * 400 instead of a silent default.
 */
function parseTopNLimit(
  raw: string | null,
): { ok: true; limit: number } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") {
    return { ok: true, limit: DEFAULT_TOP_N };
  }

  if (!/^\d+$/.test(raw.trim())) {
    return { ok: false, error: "limit must be a positive whole number." };
  }

  const parsed = Number(raw.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { ok: false, error: "limit must be a positive whole number." };
  }

  return { ok: true, limit: Math.min(parsed, MAX_TOP_N_LIMIT) };
}

/**
 * Cross-tenant redaction for the acquisition breakdown.
 *
 * Three things happen here, in this sequence, and none may be reordered:
 *  1. Every raw campaign id is resolved to its CURRENT owning brand.
 *  2. Every row passes through `discloseEntryCampaign`, whose return type makes
 *     a cross-tenant id or name unrepresentable outside the "OWN" arm.
 *  3. Every non-OWN row is SUMMED into ONE bucket per disclosure kind. Returning
 *     N separate anonymous rows would leak that exactly N distinct other
 *     campaigns sent traffic — a weaker disclosure, but a real one.
 */
async function buildDisclosedEntryCampaignBreakdown(input: {
  rows: ReadonlyArray<{ campaignId: string; clicks: number }>;
  authorizedBrandId: string;
  loadCampaignOwners(
    campaignIds: readonly string[],
  ): Promise<BrandCommerceCampaignOwner[]>;
}): Promise<BrandCommerceEntryCampaignRow[]> {
  if (input.rows.length === 0) return [];

  const owners = await loadOwnerMap(
    input.rows.map((row) => row.campaignId),
    input.loadCampaignOwners,
  );

  const own = new Map<string, BrandCommerceEntryCampaignRow>();
  let otherClicks = 0;
  let noneClicks = 0;

  for (const row of input.rows) {
    const owner = owners.get(row.campaignId);
    const disclosed: DisclosedEntryCampaign = owner
      ? discloseEntryCampaign({
          campaignId: row.campaignId,
          campaignName: owner.name,
          entryCampaignBrandId: owner.brandId,
          authorizedBrandId: input.authorizedBrandId,
        })
      : UNRESOLVED_ENTRY_CAMPAIGN;

    if (disclosed.disclosure === "OWN") {
      const existing = own.get(disclosed.campaignId);
      own.set(disclosed.campaignId, {
        ...disclosed,
        kind: "ENTRY_CAMPAIGN",
        clicks: (existing?.clicks ?? 0) + row.clicks,
      });
      continue;
    }

    if (disclosed.disclosure === "OTHER_CAMPAIGN") {
      otherClicks += row.clicks;
      continue;
    }

    noneClicks += row.clicks;
  }

  const breakdown: BrandCommerceEntryCampaignRow[] = [...own.values()];

  if (otherClicks > 0) {
    breakdown.push({
      kind: "ENTRY_CAMPAIGN",
      disclosure: "OTHER_CAMPAIGN",
      campaignId: null,
      campaignName: null,
      label: OTHER_CAMPAIGN_LABEL,
      clicks: otherClicks,
    });
  }

  if (noneClicks > 0) {
    breakdown.push({
      kind: "ENTRY_CAMPAIGN",
      disclosure: "NONE",
      campaignId: null,
      campaignName: null,
      label: null,
      clicks: noneClicks,
    });
  }

  return breakdown.sort(
    (a, b) => b.clicks - a.clicks || sortKey(a).localeCompare(sortKey(b)),
  );
}

/**
 * Defense-in-depth for the product-authorization breakdown.
 *
 * These campaigns are same-brand by construction: the composite
 * `(campaignId, brandId)` foreign key on `CampaignCommerceProduct` cannot
 * express a cross-brand assignment. The re-verification exists only for the
 * documented drift case where an administrator reassigns a Campaign to another
 * Brand after the clicks were recorded, at which point the stored name is both
 * stale and no longer the viewer's to see.
 */
async function buildVerifiedProductCampaignBreakdown(input: {
  rows: ReadonlyArray<{ campaignId: string; clicks: number }>;
  authorizedBrandId: string;
  loadCampaignOwners(
    campaignIds: readonly string[],
  ): Promise<BrandCommerceCampaignOwner[]>;
}): Promise<BrandCommerceProductCampaignRow[]> {
  if (input.rows.length === 0) return [];

  const owners = await loadOwnerMap(
    input.rows.map((row) => row.campaignId),
    input.loadCampaignOwners,
  );

  const breakdown: BrandCommerceProductCampaignRow[] = [];
  let driftedClicks = 0;

  for (const row of input.rows) {
    const owner = owners.get(row.campaignId);

    if (owner && owner.brandId === input.authorizedBrandId) {
      breakdown.push({
        kind: "PRODUCT_CAMPAIGN",
        disclosure: "OWN",
        campaignId: row.campaignId,
        campaignName: owner.name,
        clicks: row.clicks,
      });
      continue;
    }

    driftedClicks += row.clicks;
  }

  if (driftedClicks > 0) {
    breakdown.push({
      kind: "PRODUCT_CAMPAIGN",
      disclosure: "OTHER_CAMPAIGN",
      campaignId: null,
      campaignName: null,
      label: OTHER_CAMPAIGN_LABEL,
      clicks: driftedClicks,
    });
  }

  return breakdown.sort(
    (a, b) =>
      b.clicks - a.clicks ||
      (a.campaignId ?? OTHER_CAMPAIGN_LABEL).localeCompare(
        b.campaignId ?? OTHER_CAMPAIGN_LABEL,
      ),
  );
}

async function loadOwnerMap(
  campaignIds: readonly string[],
  load: (ids: readonly string[]) => Promise<BrandCommerceCampaignOwner[]>,
): Promise<Map<string, BrandCommerceCampaignOwner>> {
  const distinct = [...new Set(campaignIds)];
  if (distinct.length === 0) return new Map();
  const owners = await load(distinct);
  return new Map(owners.map((owner) => [owner.id, owner]));
}

/** Deterministic tiebreak so equal-count rows never swap between requests. */
function sortKey(row: BrandCommerceEntryCampaignRow): string {
  return row.campaignId ?? row.label ?? row.disclosure;
}

function rankTop(
  rows: ReadonlyArray<{ id: string | null; count: number }>,
  limit: number,
): CommerceClickRankableRow[] {
  return selectTopN(buildRankableCounts(rows), {
    limit,
    maxLimit: MAX_TOP_N_LIMIT,
    getMetric: (row) => row.clicks,
    getId: (row) => row.id,
  });
}

/**
 * Joins resolved display names onto ranked rows. A row whose entity could not be
 * resolved keeps its count with a null name rather than disappearing: the click
 * happened, and dropping it would make the panel disagree with the total.
 */
function attachNames(
  rows: readonly CommerceClickRankableRow[],
  named: readonly BrandCommerceNamedEntity[],
): BrandCommerceRankedEntity[] {
  const names = new Map(named.map((entity) => [entity.id, entity.name]));
  return rows.map((row) => ({
    id: row.id,
    name: names.get(row.id) ?? null,
    clicks: row.clicks,
  }));
}
