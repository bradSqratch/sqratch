/**
 * Phase 10: the pure shaping/arithmetic layer for CLICK-ONLY commerce
 * analytics.
 *
 * WHAT THIS MODULE IS. Every date-range rule, bucketing rule, ranking rule and
 * disclosure rule that Brand/Creator analytics depend on lives here, expressed
 * over plain objects. Routes load rows through
 * `src/lib/commerce/commerce-click-analytics-repository.ts` and hand them to
 * these functions; the functions decide what the numbers mean.
 *
 * IT IS DELIBERATELY PURE: no Prisma import, no I/O, no `Date.now()`, no
 * `new Date()` without an explicit caller-supplied reference time. This mirrors
 * `src/lib/campaign-context.ts`, and for the same reason: the rules stay
 * unit-testable with plain objects, and a later query change cannot silently
 * move a rule into a database `ORDER BY` or a server-local timezone.
 *
 * CLICKS ONLY. There is no purchase, conversion, revenue, sale, ROAS, order or
 * points concept anywhere in this module, and none may be added to it. A click
 * is evidence that a visitor was sent to a merchant page. SQRATCH has no
 * mechanism today to learn what happened after that, so no function here may be
 * shaped in a way that invites a caller to imply otherwise.
 *
 * THE TWO CAMPAIGN CONCEPTS ARE NEVER SUMMED.
 *   entryCampaignId   = HOW the visitor reached the Experience (acquisition)
 *   productCampaignId = WHICH campaign authorized the product they clicked
 * A single click can carry both, and they may name different campaigns owned by
 * different brands. Adding the two breakdowns together double-counts clicks and
 * produces a number that means nothing. They therefore have separate, mutually
 * incompatible row types below, and this module deliberately contains NO
 * function that combines or totals them.
 *
 * BOUNDARY RULE (adopted verbatim from
 * `src/lib/commerce/campaign-product-curation.ts`): this module speaks only in
 * SQRATCH ids and counts. Destination URLs, IP hashes, token hashes, token
 * prefixes, user agents, referrers, raw session ids, raw user ids and provider
 * ids never cross this boundary. Session and user identity appear here only as
 * pre-computed distinct COUNTS.
 */

/**
 * The three persisted surface values, restated as a local literal union so this
 * module needs no Prisma import.
 *
 * These are exactly `CommerceClickSurface` in `prisma/schema.prisma` and
 * exactly the `kind` values of the discriminated union in
 * `src/lib/commerce/click-attribution.ts`. Because the repository passes the
 * Prisma enum straight in, adding a fourth value to the schema without adding
 * it here is a COMPILE ERROR at the repository boundary rather than a silent
 * miscount. That is intentional.
 */
export type CommerceClickSurfaceValue =
  | "BRAND_STOREFRONT"
  | "CAMPAIGN_PRODUCT"
  | "LESSON";

/**
 * The honest bucket for `surface IS NULL`.
 *
 * Every click recorded before Phase 10 has no persisted surface. Its true
 * surface is frequently UNRECOVERABLE — deleting a `CampaignLessonProduct`
 * nulls `campaignLessonProductId` while leaving `lessonId`/`productCampaignId`
 * intact, and deleting a product campaign nulls `productCampaignId`. So a null
 * surface must be
 * REPORTED as unknown and must never be inferred from which optional foreign
 * keys happen to have survived.
 */
export const UNKNOWN_SURFACE_BUCKET = "UNKNOWN" as const;

export type CommerceClickSurfaceBucket =
  | CommerceClickSurfaceValue
  | typeof UNKNOWN_SURFACE_BUCKET;

export type CommerceClickSurfaceBreakdown = Record<
  CommerceClickSurfaceBucket,
  number
>;

/**
 * The persisted provider values, restated locally for the same reason as
 * `CommerceClickSurfaceValue`. `provider` is nullable on the table, so the
 * breakdown carries the same explicit unknown bucket.
 */
export type CommerceClickProviderValue = "SHOPIFY" | "COMMERCE7";

export const UNKNOWN_PROVIDER_BUCKET = "UNKNOWN" as const;

export type CommerceClickProviderBucket =
  | CommerceClickProviderValue
  | typeof UNKNOWN_PROVIDER_BUCKET;

/** Half-open in neither direction: both bounds are INCLUSIVE instants. */
export type CommerceClickAnalyticsDateRange = { start: Date; end: Date };

/**
 * Default window when the caller supplies no bounds: the last 30 UTC days,
 * inclusive of today.
 */
export const DEFAULT_ANALYTICS_RANGE_DAYS = 30;

/**
 * Hard cap on how wide a requested range may be, in whole UTC days inclusive.
 *
 * 400 is chosen so a full year-over-year comparison (365 days plus a leap day
 * plus a month of slack) is expressible, while an unbounded or accidental
 * `dateFrom=1970-01-01` cannot force a full-table scan and a multi-hundred-
 * thousand-bucket time series out of an indexed range query.
 */
export const MAX_ANALYTICS_RANGE_DAYS = 400;

/**
 * Hard cap on any Top-N request. A larger `limit` is clamped, never honored:
 * these lists are rendered in a UI panel, and an unbounded N is a cheap way to
 * make an analytics endpoint expensive.
 */
export const MAX_TOP_N_LIMIT = 50;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The stable machine label used for any campaign the viewer may not see. */
export const OTHER_CAMPAIGN_LABEL = "OTHER_CAMPAIGN" as const;

/**
 * `YYYY-MM-DD` in UTC. Used as the time-series bucket key everywhere, so a
 * bucket never shifts because the server happens to run in a different zone.
 */
export function toUtcDateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** UTC midnight (00:00:00.000Z) of the day `value` falls in. */
export function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
}

/** UTC end-of-day (23:59:59.999Z) of the day `value` falls in. */
export function endOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate(),
      23,
      59,
      59,
      999,
    ),
  );
}

/**
 * Parses a strict `YYYY-MM-DD` calendar date as UTC midnight.
 *
 * Deliberately strict. `new Date("2026-08-08")` is UTC by spec but
 * `new Date("2026-08-08T00:00")` is SERVER-LOCAL, and the two differ by up to a
 * day at the boundary — which is exactly how an analytics range silently
 * includes or excludes a day depending on where the process runs. Rejecting
 * every other shape removes that class of bug rather than trying to guess.
 *
 * Also rejects a well-formed but non-existent calendar date (`2026-02-30`),
 * which `Date.UTC` would otherwise roll forward into March.
 */
function parseUtcCalendarDate(value: string): Date | null {
  if (!DATE_ONLY_PATTERN.test(value)) {
    return null;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const parsed = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

  // Round-trip check: catches 2026-02-30, 2026-13-01, 2026-00-10, and any other
  // value Date.UTC would silently normalize.
  if (toUtcDateKey(parsed) !== value) {
    return null;
  }

  return parsed;
}

/** Whole UTC days spanned by an inclusive range (a single day spans 1). */
export function countUtcDaysInclusive(
  range: CommerceClickAnalyticsDateRange,
): number {
  const first = startOfUtcDay(range.start).getTime();
  const last = startOfUtcDay(range.end).getTime();
  return Math.floor((last - first) / MS_PER_DAY) + 1;
}

export type CommerceClickAnalyticsDateRangeResult =
  | { ok: true; range: CommerceClickAnalyticsDateRange }
  | { ok: false; error: string };

/**
 * Resolves an untrusted `dateFrom`/`dateTo` pair into an inclusive UTC range.
 *
 * RULES, all UTC, none server-local:
 *  - `dateFrom` = `YYYY-MM-DD` means 00:00:00.000Z of that date.
 *  - `dateTo`   = `YYYY-MM-DD` means 23:59:59.999Z of that date.
 *  - Neither supplied: the last `DEFAULT_ANALYTICS_RANGE_DAYS` UTC days ending
 *    at the end of `now`'s UTC day (so "30 days" includes today).
 *  - Only `dateFrom`: ends at the end of `now`'s UTC day.
 *  - Only `dateTo`: starts `DEFAULT_ANALYTICS_RANGE_DAYS - 1` days before it.
 *  - `end < start` is rejected. It is a caller bug, not something to swap
 *    silently: swapping would return data for a window nobody asked for.
 *  - A span wider than `MAX_ANALYTICS_RANGE_DAYS` is rejected rather than
 *    clamped, so the caller learns their range was not honored.
 *
 * `now` IS REQUIRED WHENEVER A BOUND IS OMITTED. This module may not read the
 * clock, so a defaulted bound has no reference point without it. Omitting both
 * a bound and `now` returns an error instead of quietly making the module
 * impure. Routes pass `now: new Date()`.
 *
 * Returns a result union rather than throwing: callers are HTTP routes that
 * must turn a bad range into a 400, not a 500.
 */
export function resolveCommerceClickAnalyticsDateRange(input: {
  dateFrom?: string | null;
  dateTo?: string | null;
  now?: Date;
}): CommerceClickAnalyticsDateRangeResult {
  const rawFrom = input.dateFrom?.trim() || null;
  const rawTo = input.dateTo?.trim() || null;

  const parsedFrom = rawFrom === null ? null : parseUtcCalendarDate(rawFrom);
  if (rawFrom !== null && parsedFrom === null) {
    return { ok: false, error: "dateFrom must be a valid YYYY-MM-DD date." };
  }

  const parsedTo = rawTo === null ? null : parseUtcCalendarDate(rawTo);
  if (rawTo !== null && parsedTo === null) {
    return { ok: false, error: "dateTo must be a valid YYYY-MM-DD date." };
  }

  const now = input.now ?? null;
  if ((parsedFrom === null || parsedTo === null) && now === null) {
    return {
      ok: false,
      error:
        "A reference time (now) is required when dateFrom or dateTo is omitted.",
    };
  }

  if (now !== null && Number.isNaN(now.getTime())) {
    return { ok: false, error: "The supplied reference time is not a valid date." };
  }

  // `now` is non-null on every branch that reads it; the checks above are what
  // establish that, so no non-null assertion is needed.
  const end =
    parsedTo !== null
      ? endOfUtcDay(parsedTo)
      : now !== null
        ? endOfUtcDay(now)
        : null;

  if (end === null) {
    return {
      ok: false,
      error:
        "A reference time (now) is required when dateFrom or dateTo is omitted.",
    };
  }

  const start =
    parsedFrom !== null
      ? startOfUtcDay(parsedFrom)
      : new Date(
          startOfUtcDay(end).getTime() -
            (DEFAULT_ANALYTICS_RANGE_DAYS - 1) * MS_PER_DAY,
        );

  if (end.getTime() < start.getTime()) {
    // The message must name a parameter the CALLER actually sent. When `dateTo`
    // was omitted, `end` is the end of `now`'s UTC day, so the only way to reach
    // this branch is a `dateFrom` in the future — and blaming a `dateTo` the
    // caller never supplied sends them looking for a bug that is not there.
    return {
      ok: false,
      error:
        parsedTo !== null
          ? "dateTo must not be earlier than dateFrom."
          : "dateFrom must not be later than the current UTC date.",
    };
  }

  const span = countUtcDaysInclusive({ start, end });
  if (span > MAX_ANALYTICS_RANGE_DAYS) {
    return {
      ok: false,
      error: `The requested range spans ${span} days; the maximum is ${MAX_ANALYTICS_RANGE_DAYS}.`,
    };
  }

  return { ok: true, range: { start, end } };
}

/**
 * Repository-shaped surface counts. `surface: null` is the pre-Phase-10
 * population and is carried through as its own bucket, never coalesced.
 */
export type CommerceClickSurfaceCount = {
  surface: CommerceClickSurfaceValue | null;
  count: number;
};

/**
 * Folds group-by rows into a fully-populated breakdown.
 *
 * Every bucket is present with an explicit 0 rather than omitted, so a client
 * chart cannot mistake "no clicks on this surface" for "this surface does not
 * exist". Duplicate rows for the same surface are summed (a repository is free
 * to return them across several scoped queries).
 */
export function buildSurfaceBreakdown(
  rows: readonly CommerceClickSurfaceCount[],
): CommerceClickSurfaceBreakdown {
  const breakdown: CommerceClickSurfaceBreakdown = {
    BRAND_STOREFRONT: 0,
    CAMPAIGN_PRODUCT: 0,
    LESSON: 0,
    UNKNOWN: 0,
  };

  for (const row of rows) {
    const bucket: CommerceClickSurfaceBucket =
      row.surface ?? UNKNOWN_SURFACE_BUCKET;
    breakdown[bucket] += normalizeCount(row.count);
  }

  return breakdown;
}

export type CommerceClickProviderCount = {
  provider: CommerceClickProviderValue | null;
  count: number;
};

export type CommerceClickProviderBreakdownRow = {
  provider: CommerceClickProviderBucket;
  clicks: number;
};

/**
 * Folds provider group-by rows into a deterministic, descending list.
 *
 * An array rather than a Record: the provider set grows (SHOPIFY, COMMERCE7,
 * and whatever comes next), and a chart wants an ordered list. Providers with
 * no clicks in range are simply absent — unlike surfaces, an unused provider is
 * not a meaningful zero.
 */
export function buildProviderBreakdown(
  rows: readonly CommerceClickProviderCount[],
): CommerceClickProviderBreakdownRow[] {
  const totals = new Map<CommerceClickProviderBucket, number>();

  for (const row of rows) {
    const bucket: CommerceClickProviderBucket =
      row.provider ?? UNKNOWN_PROVIDER_BUCKET;
    totals.set(bucket, (totals.get(bucket) ?? 0) + normalizeCount(row.count));
  }

  return [...totals.entries()]
    .map(([provider, clicks]) => ({ provider, clicks }))
    .sort((a, b) => b.clicks - a.clicks || a.provider.localeCompare(b.provider));
}

/**
 * Campaign-entry vs direct-entry split.
 *
 * DRIVEN BY `entryCampaignContextResolved`, NEVER BY `entryCampaignId != null`.
 * The boolean is the authoritative record of "the server actually resolved a
 * trusted campaign entry context for this visitor"; it is written true only
 * when the entry context was CAMPAIGN *and* that campaign resolved against the
 * Experience. A null-check on `entryCampaignId` is a different, weaker question
 * and will drift from the boolean the moment the referenced Campaign is
 * deleted (ON DELETE SET NULL nulls the id while the boolean stays true).
 */
export type CommerceClickEntrySplit = {
  campaignEntryClicks: number;
  directEntryClicks: number;
};

export type CommerceClickEntryResolutionCount = {
  entryCampaignContextResolved: boolean;
  count: number;
};

export function buildEntrySplit(
  rows: readonly CommerceClickEntryResolutionCount[],
): CommerceClickEntrySplit {
  const split: CommerceClickEntrySplit = {
    campaignEntryClicks: 0,
    directEntryClicks: 0,
  };

  for (const row of rows) {
    if (row.entryCampaignContextResolved) {
      split.campaignEntryClicks += normalizeCount(row.count);
    } else {
      split.directEntryClicks += normalizeCount(row.count);
    }
  }

  return split;
}

/**
 * The headline numbers for one scope + range.
 *
 * `uniqueSessions`/`uniqueUsers` are DISTINCT COUNTS OF NON-NULL IDS, computed
 * by the repository. They are counts, never identities: no session id or user
 * id reaches this module. A null id is not a visitor and is never counted, and
 * `ipHash` is never used as a visitor proxy — it is a peppered abuse-control
 * value, not a stable identifier, and treating it as one would both overcount
 * (rotating IPs) and undercount (shared NAT).
 */
export type CommerceClickTotals = {
  clicks: number;
  uniqueSessions: number;
  uniqueUsers: number;
  campaignEntryClicks: number;
  directEntryClicks: number;
};

export function buildCommerceClickTotals(input: {
  clicks: number;
  uniqueSessions: number;
  uniqueUsers: number;
  entrySplit: CommerceClickEntrySplit;
}): CommerceClickTotals {
  return {
    clicks: normalizeCount(input.clicks),
    uniqueSessions: normalizeCount(input.uniqueSessions),
    uniqueUsers: normalizeCount(input.uniqueUsers),
    campaignEntryClicks: normalizeCount(input.entrySplit.campaignEntryClicks),
    directEntryClicks: normalizeCount(input.entrySplit.directEntryClicks),
  };
}

/**
 * A generic "id -> clicks" row, after nulls are dropped and duplicates summed.
 * The input shape matches what a Prisma `groupBy` on a nullable id column
 * returns once `_count._all` is unwrapped.
 */
export type CommerceClickIdCount = { id: string | null; count: number };

export type CommerceClickRankableRow = { id: string; clicks: number };

/**
 * Normalizes group-by rows for ranking: drops the null-id group, sums repeats,
 * and orders deterministically (clicks DESC, then id ASC).
 *
 * The null-id group is dropped rather than bucketed because these lists are
 * "top lessons"/"top products"/"top creators" — a row with no id names nothing
 * and cannot be rendered. Callers that need to report how many clicks had no id
 * should read the scope total and subtract, so the omission is explicit at the
 * call site rather than hidden in a fake row.
 */
export function buildRankableCounts(
  rows: readonly CommerceClickIdCount[],
): CommerceClickRankableRow[] {
  const totals = new Map<string, number>();

  for (const row of rows) {
    if (row.id === null || row.id === "") continue;
    totals.set(row.id, (totals.get(row.id) ?? 0) + normalizeCount(row.count));
  }

  return [...totals.entries()]
    .map(([id, clicks]) => ({ id, clicks }))
    .sort((a, b) => b.clicks - a.clicks || a.id.localeCompare(b.id));
}

/**
 * ACQUISITION breakdown row: clicks grouped by the campaign the visitor ENTERED
 * through. Structurally distinct from the product-authorization row below, and
 * carrying a `kind` discriminant, so the two cannot be concatenated or summed
 * without it being obvious in the type.
 */
export type CommerceClickEntryCampaignCount = {
  kind: "ENTRY_CAMPAIGN";
  campaignId: string;
  clicks: number;
};

/**
 * PRODUCT-AUTHORIZATION breakdown row: clicks grouped by the campaign that
 * authorized the clicked product. NEVER add these to entry-campaign counts —
 * one click can appear in both breakdowns, so a sum double-counts.
 */
export type CommerceClickProductCampaignCount = {
  kind: "PRODUCT_CAMPAIGN";
  campaignId: string;
  clicks: number;
};

export function buildEntryCampaignBreakdown(
  rows: readonly CommerceClickIdCount[],
): CommerceClickEntryCampaignCount[] {
  return buildRankableCounts(rows).map((row) => ({
    kind: "ENTRY_CAMPAIGN",
    campaignId: row.id,
    clicks: row.clicks,
  }));
}

export function buildProductCampaignBreakdown(
  rows: readonly CommerceClickIdCount[],
): CommerceClickProductCampaignCount[] {
  return buildRankableCounts(rows).map((row) => ({
    kind: "PRODUCT_CAMPAIGN",
    campaignId: row.id,
    clicks: row.clicks,
  }));
}

// There is deliberately NO function here that merges, totals, or zips the two
// breakdowns above. If a future surface needs both, it must render them as two
// clearly separated lists with two clearly separated labels.

export type CommerceClickTopNOptions<T> = {
  limit: number;
  getMetric: (row: T) => number;
  getId: (row: T) => string;
  maxLimit?: number;
};

/**
 * Deterministic Top-N: metric DESC, then id ASC as a total-order tiebreak.
 *
 * The id tiebreak is not cosmetic. Without it, two rows with equal counts can
 * swap places between two identical requests (and across Postgres plans), which
 * makes a "top products" panel flicker and makes any test of it flaky.
 *
 * `limit` is CLAMPED, never trusted: `[0, maxLimit]`, `maxLimit` itself clamped
 * to `MAX_TOP_N_LIMIT`. A non-finite or negative limit yields an empty list —
 * callers are responsible for supplying their own default before calling, so
 * this function never invents one.
 */
export function selectTopN<T>(
  rows: readonly T[],
  opts: CommerceClickTopNOptions<T>,
): T[] {
  const ceiling = clampLimit(opts.maxLimit ?? MAX_TOP_N_LIMIT, MAX_TOP_N_LIMIT);
  const limit = clampLimit(opts.limit, ceiling);

  if (limit === 0) return [];

  return [...rows]
    .sort((a, b) => {
      const metricDelta = normalizeCount(opts.getMetric(b)) - normalizeCount(opts.getMetric(a));
      if (metricDelta !== 0) return metricDelta;
      return opts.getId(a).localeCompare(opts.getId(b));
    })
    .slice(0, limit);
}

export type CommerceClickDailyPoint = { date: string; clicks: number };

/**
 * Bucket clicks into inclusive UTC day buckets across the whole range.
 *
 * GAPS ARE FILLED WITH ZERO, not omitted. A sparse series makes a line chart
 * interpolate across missing days and makes a quiet week look like a busy one.
 *
 * Clicks outside the range are ignored rather than clamped into an edge bucket:
 * a caller passing rows it did not filter has a query bug, and silently folding
 * them into day 1 would hide it.
 *
 * Bucket count is bounded by `MAX_ANALYTICS_RANGE_DAYS`, which
 * `resolveCommerceClickAnalyticsDateRange` already guarantees; the bound is
 * re-applied here because this function also accepts a hand-built range.
 */
export function buildDailyTimeSeries(
  clicks: readonly { createdAt: Date }[],
  range: CommerceClickAnalyticsDateRange,
): CommerceClickDailyPoint[] {
  const firstBucket = startOfUtcDay(range.start).getTime();
  const lastBucket = startOfUtcDay(range.end).getTime();

  if (Number.isNaN(firstBucket) || Number.isNaN(lastBucket)) return [];
  if (lastBucket < firstBucket) return [];

  const counts = new Map<string, number>();
  for (const click of clicks) {
    const at = click.createdAt.getTime();
    if (Number.isNaN(at)) continue;
    if (at < range.start.getTime() || at > range.end.getTime()) continue;
    const key = toUtcDateKey(click.createdAt);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const series: CommerceClickDailyPoint[] = [];
  for (
    let bucket = firstBucket;
    bucket <= lastBucket && series.length < MAX_ANALYTICS_RANGE_DAYS;
    bucket += MS_PER_DAY
  ) {
    const key = toUtcDateKey(new Date(bucket));
    series.push({ date: key, clicks: counts.get(key) ?? 0 });
  }

  return series;
}

/**
 * Cross-tenant disclosure decision for an ENTRY campaign.
 *
 * A visitor acquired through Brand B's campaign can click Brand A's product, so
 * Brand A's acquisition breakdown legitimately contains rows whose entry
 * campaign belongs to somebody else. Brand A may see THAT it happened — that is
 * their own click — but must never learn the other tenant's campaign name or
 * id, which would leak a competitor's campaign inventory through an analytics
 * panel.
 *
 *   "NONE"           no entry campaign to disclose (direct entry, or a
 *                    malformed historical campaign context).
 *   "OWN"            the entry campaign belongs to the authorized brand; the
 *                    real id and name may be shown.
 *   "OTHER_CAMPAIGN" a different tenant's campaign; show the generic bucket
 *                    ONLY — never the id, never the name.
 *
 * FAILS CLOSED: a blank authorized brand id never matches anything, so a
 * mis-wired caller gets the generic bucket rather than accidental disclosure.
 *
 * This is a per-row decision and must be applied by the route BEFORE
 * serializing, not by the UI.
 */
export type EntryCampaignDisclosure = "NONE" | "OWN" | "OTHER_CAMPAIGN";

export function resolveEntryCampaignDisclosure(
  entryCampaignBrandId: string | null,
  authorizedBrandId: string,
): EntryCampaignDisclosure {
  if (entryCampaignBrandId === null || entryCampaignBrandId === "") {
    return "NONE";
  }
  if (authorizedBrandId === "" || authorizedBrandId.trim() === "") {
    return "OTHER_CAMPAIGN";
  }
  return entryCampaignBrandId === authorizedBrandId ? "OWN" : "OTHER_CAMPAIGN";
}

/**
 * The safe, serializable shape of one entry-campaign row.
 *
 * Provided so routes cannot hand-roll the redaction: for anything but "OWN",
 * `campaignId` and `campaignName` are structurally forced to null by the type,
 * so a leak requires deliberately building a different object.
 */
export type DisclosedEntryCampaign =
  | {
      disclosure: "OWN";
      campaignId: string;
      campaignName: string | null;
      label: string | null;
    }
  | {
      disclosure: "OTHER_CAMPAIGN";
      campaignId: null;
      campaignName: null;
      label: typeof OTHER_CAMPAIGN_LABEL;
    }
  | {
      disclosure: "NONE";
      campaignId: null;
      campaignName: null;
      label: null;
    };

export function discloseEntryCampaign(input: {
  campaignId: string;
  campaignName: string | null;
  entryCampaignBrandId: string | null;
  authorizedBrandId: string;
}): DisclosedEntryCampaign {
  const disclosure = resolveEntryCampaignDisclosure(
    input.entryCampaignBrandId,
    input.authorizedBrandId,
  );

  if (disclosure === "OWN") {
    return {
      disclosure,
      campaignId: input.campaignId,
      campaignName: input.campaignName,
      label: input.campaignName,
    };
  }

  if (disclosure === "OTHER_CAMPAIGN") {
    return {
      disclosure,
      campaignId: null,
      campaignName: null,
      label: OTHER_CAMPAIGN_LABEL,
    };
  }

  return { disclosure, campaignId: null, campaignName: null, label: null };
}

/**
 * Guards every arithmetic entry point against a NaN/Infinity/negative count
 * leaking into a total. A count is a non-negative integer or it is 0; there is
 * no meaningful "partially known" click count.
 */
function normalizeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function clampLimit(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), Math.max(0, Math.floor(ceiling)));
}
