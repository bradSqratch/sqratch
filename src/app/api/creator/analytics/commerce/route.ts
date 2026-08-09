/**
 * Phase 11: CREATOR-side commerce CLICK analytics.
 *
 * WHY THIS IS A SEPARATE ENDPOINT FROM `../route.ts`. The existing creator
 * analytics route has zero commerce involvement, so this is a from-scratch
 * addition rather than an extension of an existing metric. Keeping it in its
 * own endpoint leaves that route's response contract byte-for-byte stable and
 * lets this surface be authorized, cached and evolved on its own terms.
 *
 * THE AUTHORIZATION BOUNDARY IS "EXPERIENCES I OWN", NOTHING ELSE.
 * A creator owns Experiences; they do not own brands and they do not own
 * campaigns. Every read below therefore goes through exactly one scope,
 * `{ kind: "EXPERIENCE", experienceIds }`, where `experienceIds` is resolved
 * server-side from the authenticated `CreatorProfile` and NEVER from request
 * input. The `ATTRIBUTED_BRAND`, `ENTRY_CAMPAIGN` and `PRODUCT_CAMPAIGN` scope
 * kinds are deliberately unreachable from this file.
 *
 * The optional `experienceId` filter can only ever NARROW that set: it is
 * checked for membership in the owned set and rejected with a generic 404 when
 * absent, so it can neither widen the scope nor distinguish "this Experience is
 * someone else's" from "this Experience does not exist".
 *
 * BRAND/CAMPAIGN DATA IN SCOPE IS EXPECTED, NOT A LEAK. A creator's Experience
 * can be commerce-sponsored, so clicks inside the scope legitimately carry a
 * sponsoring brand's campaign ids. This route never reports those ids: there is
 * no entry-campaign or product-campaign breakdown here, only the aggregate
 * campaign-vs-direct ENTRY SPLIT, which names no campaign at all. That keeps
 * the creator side free of the cross-tenant disclosure logic the brand side
 * needs, without hiding a metric a creator legitimately owns.
 *
 * CLICKS ONLY. A click is evidence that a visitor was sent to a merchant page.
 * SQRATCH cannot observe anything downstream of that handoff, so every metric
 * below is a click count and no metric may be added or renamed in a way that
 * implies knowledge of what the visitor did next. The one-line disclaimer in
 * `CREATOR_COMMERCE_ANALYTICS_NOTE` is the only place this file names the
 * things it does NOT measure, and it says so explicitly.
 *
 * NOTHING IDENTIFYING IS READ OR RETURNED. Every click read goes through the
 * analytics repository, whose contract structurally excludes the click table's
 * abuse-control, request-forensics and destination columns. None of those
 * columns is named, selected or serialized anywhere in this file — deliberately
 * not even in a comment, so `tests/creator-commerce-analytics.test.ts` can hold
 * the whole file to a literal zero-occurrence check rather than a fuzzy one.
 * Visitor identity reaches this route only as pre-computed distinct counts.
 */
import { NextRequest, NextResponse } from "next/server";
import { getCreatorContext as defaultGetCreatorContext } from "@/lib/creator-auth";
import type { getCreatorContext as GetCreatorContext } from "@/lib/creator-auth";
import prisma from "@/lib/prisma";
import { resolveCuratedProductTitle } from "@/lib/commerce/campaign-product-curation";
import {
  buildCommerceClickTotals,
  buildDailyTimeSeries,
  buildEntrySplit,
  buildProviderBreakdown,
  buildRankableCounts,
  buildSurfaceBreakdown,
  MAX_TOP_N_LIMIT,
  resolveCommerceClickAnalyticsDateRange,
  selectTopN,
  type CommerceClickDailyPoint,
  type CommerceClickProviderBreakdownRow,
  type CommerceClickSurfaceBreakdown,
} from "@/lib/commerce/commerce-click-analytics";
import {
  buildPrismaCommerceClickAnalyticsRepository,
  isEmptyCommerceClickAnalyticsScope,
  type BoundedCount,
  type CommerceClickAnalyticsQuery,
  type CommerceClickAnalyticsRepository,
  type CommerceClickAnalyticsScope,
} from "@/lib/commerce/commerce-click-analytics-repository";

/** Default Top-N size when the caller supplies no `limit`. */
const DEFAULT_TOP_N = 10;

/**
 * The informational note rendered once by the creator dashboard. Defined here
 * so the API and the UI cannot drift into implying more than clicks.
 */
export const CREATOR_COMMERCE_ANALYTICS_NOTE =
  "Commerce analytics currently measures outbound product clicks. Order and revenue attribution are not enabled.";

export type CreatorCommerceExperienceRow = {
  id: string;
  title: string | null;
  clicks: number;
};

export type CreatorCommerceLessonRow = {
  id: string;
  title: string | null;
  clicks: number;
};

export type CreatorCommerceProductRow = {
  id: string;
  name: string | null;
  clicks: number;
};

/**
 * The explicit response contract. Deliberately hand-written rather than a
 * Prisma shape: nothing reaches a client that is not named here.
 */
export type CreatorCommerceAnalyticsResponse = {
  data: {
    /** Inclusive UTC instants, as ISO strings. */
    range: { start: string; end: string };
    filters: {
      /** Echoes the validated narrowing filter, never raw input. */
      experienceId: string | null;
      limit: number;
    };
    totals: {
      clicks: number;
      /** Distinct non-null session ids. `truncated` means "at least value". */
      uniqueSessions: BoundedCount;
      /** Distinct non-null user ids. `truncated` means "at least value". */
      uniqueUsers: BoundedCount;
      /** Driven by `entryCampaignContextResolved`, never by an id null-check. */
      campaignEntryClicks: number;
      directEntryClicks: number;
    };
    timeSeries: CommerceClickDailyPoint[];
    /** True when the timestamp read hit its cap, so the series is incomplete. */
    timeSeriesTruncated: boolean;
    surfaceBreakdown: CommerceClickSurfaceBreakdown;
    providerBreakdown: CommerceClickProviderBreakdownRow[];
    topProducts: CreatorCommerceProductRow[];
    topLessons: CreatorCommerceLessonRow[];
    /** Omitted entirely when the request is narrowed to a single Experience. */
    topExperiences?: CreatorCommerceExperienceRow[];
    note: string;
  };
};

type OwnedExperience = { id: string; title: string };

export type CreatorCommerceAnalyticsDeps = {
  getCreatorContext: typeof GetCreatorContext;
  repository: CommerceClickAnalyticsRepository;
  /** Experiences owned by this CreatorProfile. The ONLY source of scope ids. */
  listOwnedExperiences: (creatorProfileId: string) => Promise<OwnedExperience[]>;
  /**
   * Lesson titles, re-scoped to the owned Experiences. The ids already come
   * from in-scope clicks; the second predicate is belt-and-braces so a future
   * repository change cannot turn this into an unscoped title lookup.
   */
  listLessonTitles: (input: {
    lessonIds: readonly string[];
    experienceIds: readonly string[];
  }) => Promise<Array<{ id: string; title: string }>>;
  /** Display titles for curated brand products the creator's visitors clicked. */
  listProductTitles: (
    brandCommerceProductIds: readonly string[],
  ) => Promise<Array<{ id: string; title: string }>>;
  now: () => Date;
};

const DEFAULT_DEPS: CreatorCommerceAnalyticsDeps = {
  getCreatorContext: defaultGetCreatorContext,
  repository: buildPrismaCommerceClickAnalyticsRepository(),

  listOwnedExperiences: (creatorProfileId) =>
    prisma.experience.findMany({
      // Same ownership predicate the existing creator analytics route uses:
      // `Experience.creatorId` is the CreatorProfile id.
      where: { creatorId: creatorProfileId },
      orderBy: { title: "asc" },
      select: { id: true, title: true },
    }),

  listLessonTitles: ({ lessonIds, experienceIds }) =>
    prisma.lesson.findMany({
      where: {
        id: { in: [...lessonIds] },
        course: { experienceId: { in: [...experienceIds] } },
      },
      select: { id: true, title: true },
    }),

  listProductTitles: async (brandCommerceProductIds) => {
    const rows = await prisma.brandCommerceProduct.findMany({
      where: { id: { in: [...brandCommerceProductIds] } },
      select: {
        id: true,
        titleOverride: true,
        connectedProduct: { select: { title: true } },
      },
    });

    return rows.map((row) => ({
      id: row.id,
      // Same precedence as every other curated-product surface, so the creator
      // sees the brand's chosen title rather than a raw provider title.
      title: resolveCuratedProductTitle({
        title: row.connectedProduct.title,
        titleOverride: row.titleOverride,
      }),
    }));
  },

  now: () => new Date(),
};

/**
 * Parses the optional Top-N size.
 *
 * A malformed value is a 400 rather than a silent default: the caller asked for
 * something specific and deserves to learn it was not honored. A value above
 * the ceiling is CLAMPED, which is the documented contract of `selectTopN`.
 */
function parseLimit(
  raw: string | null,
): { ok: true; limit: number } | { ok: false; error: string } {
  if (raw === null || raw.trim() === "") {
    return { ok: true, limit: DEFAULT_TOP_N };
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return { ok: false, error: "limit must be a positive integer." };
  }

  return { ok: true, limit: Math.min(parsed, MAX_TOP_N_LIMIT) };
}

/** The zero-state body, used whenever the authorized scope contains no ids. */
function emptyResponse(input: {
  range: { start: Date; end: Date };
  experienceId: string | null;
  limit: number;
  includeExperiences: boolean;
}): CreatorCommerceAnalyticsResponse {
  return {
    data: {
      range: {
        start: input.range.start.toISOString(),
        end: input.range.end.toISOString(),
      },
      filters: { experienceId: input.experienceId, limit: input.limit },
      totals: {
        clicks: 0,
        uniqueSessions: { value: 0, truncated: false },
        uniqueUsers: { value: 0, truncated: false },
        campaignEntryClicks: 0,
        directEntryClicks: 0,
      },
      timeSeries: buildDailyTimeSeries([], input.range),
      timeSeriesTruncated: false,
      surfaceBreakdown: buildSurfaceBreakdown([]),
      providerBreakdown: [],
      topProducts: [],
      topLessons: [],
      ...(input.includeExperiences ? { topExperiences: [] } : {}),
      note: CREATOR_COMMERCE_ANALYTICS_NOTE,
    },
  };
}

export async function creatorCommerceAnalyticsGetImpl(
  request: NextRequest,
  overrides?: Partial<CreatorCommerceAnalyticsDeps>,
): Promise<Response> {
  const deps: CreatorCommerceAnalyticsDeps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const creator = await deps.getCreatorContext();

    // Identical rejection to the existing creator analytics route: strict
    // CREATOR role, no global-ADMIN bypass, and an unauthenticated request is
    // indistinguishable from a wrong-role one.
    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const params = request.nextUrl.searchParams;

    const limitResult = parseLimit(params.get("limit"));
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

    const ownedExperiences = await deps.listOwnedExperiences(
      creator.creatorProfile.id,
    );
    const ownedIds = new Set(ownedExperiences.map((row) => row.id));

    const requestedExperienceId = params.get("experienceId")?.trim() || null;

    // THE NARROWING CHECK. A requested id must be one the creator owns. It is
    // never ignored (which would silently widen the answer to every owned
    // Experience) and the 404 is generic, so an id belonging to another creator
    // is indistinguishable from an id that does not exist.
    if (requestedExperienceId !== null && !ownedIds.has(requestedExperienceId)) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const includeExperiences = requestedExperienceId === null;
    const scopedExperiences =
      requestedExperienceId === null
        ? ownedExperiences
        : ownedExperiences.filter((row) => row.id === requestedExperienceId);
    const experienceIds = scopedExperiences.map((row) => row.id);

    const scope: CommerceClickAnalyticsScope = {
      kind: "EXPERIENCE",
      experienceIds,
    };

    // A creator with no Experiences (or a narrowing filter that somehow left
    // nothing) gets a clean zero state. The repository already short-circuits
    // an empty scope, but an empty `in: []` must never reach a query at all, so
    // the check is explicit here too.
    if (isEmptyCommerceClickAnalyticsScope(scope)) {
      return NextResponse.json(
        emptyResponse({
          range,
          experienceId: requestedExperienceId,
          limit,
          includeExperiences,
        }),
      );
    }

    const query: CommerceClickAnalyticsQuery = { scope, range };

    const [
      clicks,
      uniqueSessions,
      uniqueUsers,
      entryResolutionRows,
      surfaceRows,
      providerRows,
      productRows,
      lessonRows,
      experienceRows,
      timestamps,
    ] = await Promise.all([
      deps.repository.countClicks(query),
      deps.repository.countDistinctSessions(query),
      deps.repository.countDistinctUsers(query),
      deps.repository.countByEntryResolution(query),
      deps.repository.groupBySurface(query),
      deps.repository.groupByProvider(query),
      // `brandCommerceProductId` rather than `connectedProductId`: it is the
      // curated catalog row, so it resolves to the brand's chosen display
      // title through the same precedence every other product surface uses.
      deps.repository.groupByBrandCommerceProduct(query),
      deps.repository.groupByLesson(query),
      // Meaningless once narrowed to a single Experience — every click would
      // land in one row that already equals `totals.clicks`.
      includeExperiences
        ? deps.repository.groupByExperience(query)
        : Promise.resolve([]),
      deps.repository.listClickTimestamps(query),
    ]);

    const entrySplit = buildEntrySplit(entryResolutionRows);

    const topProductCounts = selectTopN(buildRankableCounts(productRows), {
      limit,
      maxLimit: MAX_TOP_N_LIMIT,
      getMetric: (row) => row.clicks,
      getId: (row) => row.id,
    });
    const topLessonCounts = selectTopN(buildRankableCounts(lessonRows), {
      limit,
      maxLimit: MAX_TOP_N_LIMIT,
      getMetric: (row) => row.clicks,
      getId: (row) => row.id,
    });
    const topExperienceCounts = includeExperiences
      ? selectTopN(buildRankableCounts(experienceRows), {
          limit,
          maxLimit: MAX_TOP_N_LIMIT,
          getMetric: (row) => row.clicks,
          getId: (row) => row.id,
        })
      : [];

    // Names are resolved only for the ids that survived Top-N, and only for
    // entities already inside the authorized scope.
    const [lessonTitles, productTitles] = await Promise.all([
      topLessonCounts.length
        ? deps.listLessonTitles({
            lessonIds: topLessonCounts.map((row) => row.id),
            experienceIds,
          })
        : Promise.resolve([]),
      topProductCounts.length
        ? deps.listProductTitles(topProductCounts.map((row) => row.id))
        : Promise.resolve([]),
    ]);

    const lessonTitleById = new Map(
      lessonTitles.map((row) => [row.id, row.title]),
    );
    const productTitleById = new Map(
      productTitles.map((row) => [row.id, row.title]),
    );
    const experienceTitleById = new Map(
      scopedExperiences.map((row) => [row.id, row.title]),
    );

    // Every number goes through the pure layer's guard, so a NaN/negative count
    // from any source becomes 0 rather than a nonsense total. The `truncated`
    // flags ride alongside the guarded values, never instead of them.
    const totals = buildCommerceClickTotals({
      clicks,
      uniqueSessions: uniqueSessions.value,
      uniqueUsers: uniqueUsers.value,
      entrySplit,
    });

    const body: CreatorCommerceAnalyticsResponse = {
      data: {
        range: {
          start: range.start.toISOString(),
          end: range.end.toISOString(),
        },
        filters: { experienceId: requestedExperienceId, limit },
        totals: {
          clicks: totals.clicks,
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
        topProducts: topProductCounts.map((row) => ({
          id: row.id,
          name: productTitleById.get(row.id) ?? null,
          clicks: row.clicks,
        })),
        topLessons: topLessonCounts.map((row) => ({
          id: row.id,
          title: lessonTitleById.get(row.id) ?? null,
          clicks: row.clicks,
        })),
        ...(includeExperiences
          ? {
              topExperiences: topExperienceCounts.map((row) => ({
                id: row.id,
                title: experienceTitleById.get(row.id) ?? null,
                clicks: row.clicks,
              })),
            }
          : {}),
        note: CREATOR_COMMERCE_ANALYTICS_NOTE,
      },
    };

    return NextResponse.json(body);
  } catch (error) {
    console.error("[creator/analytics/commerce][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load creator commerce analytics." },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  return creatorCommerceAnalyticsGetImpl(request);
}
