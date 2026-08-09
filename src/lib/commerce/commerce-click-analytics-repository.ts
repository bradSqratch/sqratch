import type { Prisma } from "@prisma/client";
import type {
  CommerceClickAnalyticsDateRange,
  CommerceClickEntryResolutionCount,
  CommerceClickIdCount,
  CommerceClickProviderCount,
  CommerceClickSurfaceCount,
} from "@/lib/commerce/commerce-click-analytics";

/**
 * Phase 10: the I/O shell for CLICK-ONLY commerce analytics.
 *
 * THE CONTRACT IS "ALREADY-AUTHORIZED SCOPE IN, SAFE AGGREGATE SHAPE OUT".
 *
 * IN. Every method takes a `CommerceClickAnalyticsScope`: a discriminated union
 * carrying a LIST OF IDS THE CALLER HAS ALREADY PROVEN IT OWNS. This module
 * performs NO authorization and cannot. It deliberately has no method that
 * accepts a bare `brandId`, `creatorProfileId`, or `experienceSlug` and resolves
 * ownership itself, because that would place a tenant boundary in a layer with
 * no request context. Resolving "which ids may this caller see" happens exactly
 * one layer up, in a route that has the session. Passing an id list you did not
 * authorize is a caller bug this module is structurally unable to detect —
 * which is precisely why the scope type is shaped to make that bug obvious at
 * the call site rather than invisible inside a `where`.
 *
 * OUT. Only counts, ids that are already part of the caller's scope or are
 * safe-by-construction SQRATCH catalog ids, and timestamps. This module speaks
 * only in SQRATCH ids and aggregates (the boundary rule adopted verbatim from
 * `src/lib/commerce/campaign-product-curation.ts`: "Provider ids, provider
 * metadata, and connection credentials never cross this boundary").
 *
 * NO METHOD MAY EVER RETURN, AND NONE DOES RETURN:
 *   destinationUrl, destinationHost, ipHash, tokenHash, tokenPrefix, userAgent,
 *   referrer, a session id value, a user id value, or any provider-side id.
 * `sessionId` and `userId` appear in exactly one role — as the target of a
 * distinct COUNT — and their values are never returned. If a future method
 * needs to FILTER on any of the above, that is a red flag: none of Phase 10's
 * reads require it, and such a method would be reading abuse-control data
 * through an analytics door.
 *
 * CLICKS ONLY. There is no order, purchase, conversion, revenue or points
 * concept here and none may be added. A click is evidence that a visitor was
 * sent to a merchant page, nothing more.
 *
 * NO RAW SQL. Every read below is `count` / `groupBy` / `findMany(select)` with
 * structured Prisma filters. No `$queryRaw`, no `$executeRaw`, no
 * string-concatenated filter value. The two places where Prisma is genuinely
 * less efficient than hand-written SQL (`COUNT(DISTINCT ...)` and
 * `date_trunc`-style bucketing) are handled with explicit, documented BOUNDS
 * rather than by reaching for raw SQL — see `BoundedCount` and
 * `listClickTimestamps`.
 *
 * WHY A FACTORY AND A LAZY PRISMA IMPORT. This follows
 * `src/lib/commerce/campaign-product-reconciliation.ts`
 * (`buildProduction...Deps()` + `await import("@/lib/prisma")`) rather than the
 * simpler eager shape of `src/lib/campaign-context-repository.ts`. The reason is
 * testability: later agents will unit-test routes against injected doubles of
 * `CommerceClickAnalyticsRepository`, and those tests must be able to import
 * this module for its types and helpers WITHOUT instantiating a PrismaClient
 * against the blocked test DATABASE_URL. Importing this module connects to
 * nothing.
 */

/**
 * An already-authorized query scope.
 *
 * `ATTRIBUTED_BRAND` is the Phase 10 default for every Brand-side read. It
 * filters on `attributedBrandId`, the durable non-foreign-key snapshot written
 * at click time — NOT on `brandId`. `brandId` participates in the composite
 * `(productCampaignId, brandId) -> Campaign(id, brandId)` foreign key, so
 * deleting a product campaign NULLS it and an admin reassigning that campaign
 * to another Brand REWRITES it (ON UPDATE CASCADE) on every historical row.
 * A brand's own click history must not be silently deletable or transferable by
 * an unrelated administrative action, so brand analytics never key on it.
 *
 * `ENTRY_CAMPAIGN` and `PRODUCT_CAMPAIGN` are deliberately separate variants of
 * the same shape. Entry = how the visitor arrived; product = what authorized
 * the product they clicked. One click can be in both scopes, so results from
 * the two must never be added together.
 *
 * `EXPERIENCE` is the Creator-side scope: a creator owns Experiences, not
 * brands and not campaigns.
 */
export type CommerceClickAnalyticsScope =
  | { kind: "ATTRIBUTED_BRAND"; attributedBrandIds: readonly string[] }
  | { kind: "ENTRY_CAMPAIGN"; campaignIds: readonly string[] }
  | { kind: "PRODUCT_CAMPAIGN"; campaignIds: readonly string[] }
  | { kind: "EXPERIENCE"; experienceIds: readonly string[] };

export type CommerceClickAnalyticsQuery = {
  scope: CommerceClickAnalyticsScope;
  /** Inclusive on both ends; produced by `resolveCommerceClickAnalyticsDateRange`. */
  range: CommerceClickAnalyticsDateRange;
};

/**
 * A count that may have hit its sampling ceiling.
 *
 * Prisma cannot express `COUNT(DISTINCT col)` directly; the only non-raw way is
 * to group by the column and count the groups, which transfers one row per
 * distinct value. Rather than either (a) doing that unbounded, or (b)
 * introducing `$queryRaw` for a reporting number, the distinct counts below are
 * capped: when `truncated` is true, `value` is the cap and the honest reading
 * is "at least `value`". A caller rendering this MUST label it as a lower bound
 * (e.g. "50,000+"), never as an exact figure.
 */
export type BoundedCount = { value: number; truncated: boolean };

/**
 * Ceiling for distinct-value sampling. Well above any realistic single-tenant
 * range read, low enough that a pathological range cannot pull an unbounded
 * number of identifiers into process memory.
 */
export const MAX_DISTINCT_SAMPLE = 100_000;

/**
 * Ceiling for the raw-timestamp read backing the daily time series.
 *
 * Prisma cannot group by a date-truncated column, so day bucketing happens in
 * the pure layer (`buildDailyTimeSeries`) over per-click timestamps. Only
 * `createdAt` is selected — no other column of the row is read — and the read
 * is capped. When `truncated` is true the series is incomplete and must be
 * labelled as such, not silently charted.
 *
 * THE SHAPE OF THE LOSS MATTERS, AND CALLERS MUST LABEL IT PRECISELY. The read
 * is ordered `createdAt: "asc"`, so truncation drops the NEWEST clicks: the
 * series is exact for the early part of the range and then reads as a run of
 * literal zeroes, which a reader will mistake for traffic stopping. "At least N"
 * is therefore NOT a sufficient label on its own; a caller must say that only
 * the earliest clicks in the range are charted while the headline total still
 * counts the rest. An exact full-range series needs database-side day bucketing
 * (a rollup table or a materialized view), not a bigger ceiling.
 */
export const MAX_TIME_SERIES_SAMPLE = 200_000;

export type BoundedTimestamps = {
  timestamps: Array<{ createdAt: Date }>;
  truncated: boolean;
};

/**
 * The explicit, named-method repository contract (the pattern used by
 * `CampaignCurationRepository`). Routes depend on this type, never on Prisma,
 * so a test can supply a plain object.
 *
 * Every method returns a zeroed/empty result for an EMPTY scope WITHOUT issuing
 * a query. That is not an optimization: an empty `in: []` list must never be
 * allowed to degrade into an unfiltered read, and short-circuiting before the
 * query makes that structurally impossible. It mirrors the guard already used
 * by `src/app/api/brand/analytics/route.ts` (`campaignIds.length ? … : []`).
 */
export type CommerceClickAnalyticsRepository = {
  /** Total clicks in scope and range. */
  countClicks(query: CommerceClickAnalyticsQuery): Promise<number>;

  /**
   * Distinct NON-NULL `sessionId` values in scope and range.
   *
   * A null session id is not a visitor and is never counted. `ipHash` is NEVER
   * used as a visitor proxy: it is a peppered abuse-control value, it rotates
   * with the network, and it is shared across everyone behind one NAT, so it
   * both over- and under-counts. No session id value is returned.
   */
  countDistinctSessions(
    query: CommerceClickAnalyticsQuery,
  ): Promise<BoundedCount>;

  /** Distinct NON-NULL `userId` values. No user id value is returned. */
  countDistinctUsers(query: CommerceClickAnalyticsQuery): Promise<BoundedCount>;

  /**
   * Clicks split by `entryCampaignContextResolved`.
   *
   * This boolean, not `entryCampaignId IS NULL`, is the authoritative record of
   * a genuinely resolved campaign entry. The id can be nulled by a later
   * Campaign deletion while the boolean stays true, so the two answers diverge.
   */
  countByEntryResolution(
    query: CommerceClickAnalyticsQuery,
  ): Promise<CommerceClickEntryResolutionCount[]>;

  /**
   * Clicks grouped by the durable `surface` column.
   *
   * `null` is returned as its own group — the honest "recorded before Phase 10"
   * bucket. It is never coalesced into a real surface and never inferred from
   * which optional foreign keys survived.
   */
  groupBySurface(
    query: CommerceClickAnalyticsQuery,
  ): Promise<CommerceClickSurfaceCount[]>;

  /** Clicks grouped by commerce provider; `null` is its own group. */
  groupByProvider(
    query: CommerceClickAnalyticsQuery,
  ): Promise<CommerceClickProviderCount[]>;

  /**
   * ACQUISITION breakdown: clicks grouped by `entryCampaignId`.
   *
   * Under an `ATTRIBUTED_BRAND` scope this legitimately returns campaign ids
   * belonging to OTHER tenants (a visitor acquired by Brand B's campaign can
   * click Brand A's product). The caller MUST run every returned id through
   * `resolveEntryCampaignDisclosure` before serializing, or it leaks a
   * competitor's campaign inventory.
   *
   * Never combine this result with `groupByProductCampaign`.
   */
  groupByEntryCampaign(
    query: CommerceClickAnalyticsQuery,
  ): Promise<CommerceClickIdCount[]>;

  /**
   * PRODUCT-AUTHORIZATION breakdown: clicks grouped by `productCampaignId`.
   * A separate query and a separate result from the entry breakdown on purpose:
   * one click can appear in both, so summing them double-counts.
   */
  groupByProductCampaign(
    query: CommerceClickAnalyticsQuery,
  ): Promise<CommerceClickIdCount[]>;

  /** Top-products input, by SQRATCH catalog id. Unranked; rank with `selectTopN`. */
  groupByBrandCommerceProduct(
    query: CommerceClickAnalyticsQuery,
  ): Promise<CommerceClickIdCount[]>;

  /**
   * Top-products input, by synchronized `ConnectedCommerceProduct` id. This is
   * a SQRATCH row id, NOT the provider's product id, which never crosses this
   * boundary.
   */
  groupByConnectedProduct(
    query: CommerceClickAnalyticsQuery,
  ): Promise<CommerceClickIdCount[]>;

  /** Top-Experiences input. */
  groupByExperience(
    query: CommerceClickAnalyticsQuery,
  ): Promise<CommerceClickIdCount[]>;

  /** Top-Lessons input. */
  groupByLesson(
    query: CommerceClickAnalyticsQuery,
  ): Promise<CommerceClickIdCount[]>;

  /**
   * Top-creators input, for the brand side.
   *
   * The repository just executes the scoped query. Whether the caller is
   * ALLOWED to disclose creator identity is a policy decision that belongs to
   * the route, which must resolve names only for creators it may name.
   */
  groupByCreatorProfile(
    query: CommerceClickAnalyticsQuery,
  ): Promise<CommerceClickIdCount[]>;

  /** Clicks grouped by the QR code that started the visitor's session. */
  groupByQrCode(
    query: CommerceClickAnalyticsQuery,
  ): Promise<CommerceClickIdCount[]>;

  /**
   * Per-click `createdAt` timestamps for daily bucketing, ascending. ONLY
   * `createdAt` is selected. Bounded by `MAX_TIME_SERIES_SAMPLE`.
   */
  listClickTimestamps(
    query: CommerceClickAnalyticsQuery,
  ): Promise<BoundedTimestamps>;
};

/**
 * The scope's authorized id list, deduplicated.
 *
 * Deduplication is defensive only: a repeated id in an `IN (...)` list changes
 * no result but makes a pathological caller expensive.
 */
function scopeIds(scope: CommerceClickAnalyticsScope): string[] {
  const raw =
    scope.kind === "ATTRIBUTED_BRAND"
      ? scope.attributedBrandIds
      : scope.kind === "EXPERIENCE"
        ? scope.experienceIds
        : scope.campaignIds;

  return [...new Set(raw.filter((id) => id !== ""))];
}

/** True when the scope authorizes nothing, so no query may be issued. */
export function isEmptyCommerceClickAnalyticsScope(
  scope: CommerceClickAnalyticsScope,
): boolean {
  return scopeIds(scope).length === 0;
}

/**
 * The structured Prisma filter for one query.
 *
 * The scope column is chosen by the union's discriminant, so there is no code
 * path that produces a `where` without a scope predicate, and no caller-
 * supplied string ever reaches a column name.
 */
function buildWhere(
  query: CommerceClickAnalyticsQuery,
): Prisma.CommerceClickAttributionWhereInput {
  const ids = scopeIds(query.scope);
  const createdAt = { gte: query.range.start, lte: query.range.end };

  switch (query.scope.kind) {
    case "ATTRIBUTED_BRAND":
      return { attributedBrandId: { in: ids }, createdAt };
    case "ENTRY_CAMPAIGN":
      return { entryCampaignId: { in: ids }, createdAt };
    case "PRODUCT_CAMPAIGN":
      return { productCampaignId: { in: ids }, createdAt };
    case "EXPERIENCE":
      return { experienceId: { in: ids }, createdAt };
  }
}

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

/**
 * Distinct non-null count for one nullable id column, via group-by-and-count.
 *
 * The grouped values live only inside this function and are never returned;
 * only the group COUNT escapes. `take` bounds the transfer, and `orderBy` is
 * required by Prisma whenever `take` is used with `groupBy` (it also makes the
 * truncation point deterministic rather than plan-dependent).
 */
async function countDistinctColumn(
  query: CommerceClickAnalyticsQuery,
  column: "sessionId" | "userId",
): Promise<BoundedCount> {
  if (isEmptyCommerceClickAnalyticsScope(query.scope)) {
    return { value: 0, truncated: false };
  }

  const prisma = await getPrisma();
  const where = { ...buildWhere(query), [column]: { not: null } };

  const groups =
    column === "sessionId"
      ? await prisma.commerceClickAttribution.groupBy({
          by: ["sessionId"],
          where,
          orderBy: { sessionId: "asc" },
          take: MAX_DISTINCT_SAMPLE + 1,
        })
      : await prisma.commerceClickAttribution.groupBy({
          by: ["userId"],
          where,
          orderBy: { userId: "asc" },
          take: MAX_DISTINCT_SAMPLE + 1,
        });

  // Only the length is read. No identifier value leaves this scope.
  if (groups.length > MAX_DISTINCT_SAMPLE) {
    return { value: MAX_DISTINCT_SAMPLE, truncated: true };
  }
  return { value: groups.length, truncated: false };
}

/**
 * The real Prisma-backed repository. Calling this builds the method table;
 * importing this module does not connect to a database.
 */
export function buildPrismaCommerceClickAnalyticsRepository(): CommerceClickAnalyticsRepository {
  return {
    async countClicks(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) return 0;
      const prisma = await getPrisma();
      return prisma.commerceClickAttribution.count({ where: buildWhere(query) });
    },

    async countDistinctSessions(query) {
      return countDistinctColumn(query, "sessionId");
    },

    async countDistinctUsers(query) {
      return countDistinctColumn(query, "userId");
    },

    async countByEntryResolution(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) return [];
      const prisma = await getPrisma();
      const rows = await prisma.commerceClickAttribution.groupBy({
        by: ["entryCampaignContextResolved"],
        where: buildWhere(query),
        _count: { _all: true },
      });
      return rows.map((row) => ({
        entryCampaignContextResolved: row.entryCampaignContextResolved,
        count: row._count._all,
      }));
    },

    async groupBySurface(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) return [];
      const prisma = await getPrisma();
      const rows = await prisma.commerceClickAttribution.groupBy({
        by: ["surface"],
        where: buildWhere(query),
        _count: { _all: true },
      });
      // `row.surface` is null for every pre-Phase-10 click. Carried through
      // untouched; the pure layer buckets it as UNKNOWN.
      return rows.map((row) => ({ surface: row.surface, count: row._count._all }));
    },

    async groupByProvider(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) return [];
      const prisma = await getPrisma();
      const rows = await prisma.commerceClickAttribution.groupBy({
        by: ["provider"],
        where: buildWhere(query),
        _count: { _all: true },
      });
      return rows.map((row) => ({ provider: row.provider, count: row._count._all }));
    },

    async groupByEntryCampaign(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) return [];
      const prisma = await getPrisma();
      const rows = await prisma.commerceClickAttribution.groupBy({
        by: ["entryCampaignId"],
        where: buildWhere(query),
        _count: { _all: true },
      });
      return rows.map((row) => ({ id: row.entryCampaignId, count: row._count._all }));
    },

    async groupByProductCampaign(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) return [];
      const prisma = await getPrisma();
      const rows = await prisma.commerceClickAttribution.groupBy({
        by: ["productCampaignId"],
        where: buildWhere(query),
        _count: { _all: true },
      });
      return rows.map((row) => ({ id: row.productCampaignId, count: row._count._all }));
    },

    async groupByBrandCommerceProduct(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) return [];
      const prisma = await getPrisma();
      const rows = await prisma.commerceClickAttribution.groupBy({
        by: ["brandCommerceProductId"],
        where: buildWhere(query),
        _count: { _all: true },
      });
      return rows.map((row) => ({
        id: row.brandCommerceProductId,
        count: row._count._all,
      }));
    },

    async groupByConnectedProduct(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) return [];
      const prisma = await getPrisma();
      const rows = await prisma.commerceClickAttribution.groupBy({
        by: ["connectedProductId"],
        where: buildWhere(query),
        _count: { _all: true },
      });
      return rows.map((row) => ({
        id: row.connectedProductId,
        count: row._count._all,
      }));
    },

    async groupByExperience(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) return [];
      const prisma = await getPrisma();
      const rows = await prisma.commerceClickAttribution.groupBy({
        by: ["experienceId"],
        where: buildWhere(query),
        _count: { _all: true },
      });
      return rows.map((row) => ({ id: row.experienceId, count: row._count._all }));
    },

    async groupByLesson(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) return [];
      const prisma = await getPrisma();
      const rows = await prisma.commerceClickAttribution.groupBy({
        by: ["lessonId"],
        where: buildWhere(query),
        _count: { _all: true },
      });
      return rows.map((row) => ({ id: row.lessonId, count: row._count._all }));
    },

    async groupByCreatorProfile(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) return [];
      const prisma = await getPrisma();
      const rows = await prisma.commerceClickAttribution.groupBy({
        by: ["creatorProfileId"],
        where: buildWhere(query),
        _count: { _all: true },
      });
      return rows.map((row) => ({ id: row.creatorProfileId, count: row._count._all }));
    },

    async groupByQrCode(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) return [];
      const prisma = await getPrisma();
      const rows = await prisma.commerceClickAttribution.groupBy({
        by: ["qrCodeId"],
        where: buildWhere(query),
        _count: { _all: true },
      });
      return rows.map((row) => ({ id: row.qrCodeId, count: row._count._all }));
    },

    async listClickTimestamps(query) {
      if (isEmptyCommerceClickAnalyticsScope(query.scope)) {
        return { timestamps: [], truncated: false };
      }
      const prisma = await getPrisma();
      // `select` is exactly one column. Nothing identifying is read at all.
      const rows = await prisma.commerceClickAttribution.findMany({
        where: buildWhere(query),
        select: { createdAt: true },
        orderBy: { createdAt: "asc" },
        take: MAX_TIME_SERIES_SAMPLE + 1,
      });

      if (rows.length > MAX_TIME_SERIES_SAMPLE) {
        return {
          timestamps: rows.slice(0, MAX_TIME_SERIES_SAMPLE),
          truncated: true,
        };
      }
      return { timestamps: rows, truncated: false };
    },
  };
}
