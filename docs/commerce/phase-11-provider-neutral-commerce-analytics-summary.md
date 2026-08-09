# Phase 11 — Provider-Neutral Commerce Click Analytics

## Scope boundary

Everything in this document answers questions about **outbound merchant
clicks**. Nothing in this feature answers questions about purchases,
conversions, conversion rate, sales, revenue, commission, ROAS, or order
value — those metrics do not exist anywhere in the response contracts, the
UI, or the underlying queries. See
[phase-10-click-only-attribution-analytics-foundation-summary.md](phase-10-click-only-attribution-analytics-foundation-summary.md)
for the durability foundation this phase is built on.

## Architecture

```
CommerceClickAttribution (Postgres)
        │
        ▼
src/lib/commerce/commerce-click-analytics-repository.ts   (I/O shell)
  "already-authorized scope in, safe aggregate shape out"
        │
        ▼
src/lib/commerce/commerce-click-analytics.ts               (pure core)
  date-range resolution, UTC bucketing, breakdown builders,
  Top-N ranking, cross-tenant disclosure redaction
        │
        ├──────────────────────────┬──────────────────────────┐
        ▼                          ▼
src/app/api/brand/analytics/   src/app/api/creator/analytics/
  commerce/route.ts               commerce/route.ts
        │                          │
        ▼                          ▼
dashboard/brand/analytics/     dashboard/creator/analytics/
  page.tsx (Commerce section)    page.tsx (Commerce section)
```

This mirrors the house pure-core + thin-I/O-shell pattern established by
`src/lib/campaign-context.ts` / `src/lib/campaign-context-repository.ts`.
The repository never authorizes anything itself — every method takes a
`CommerceClickAnalyticsScope`, a discriminated union carrying **only ids the
caller has already proven it owns**:

```ts
type CommerceClickAnalyticsScope =
  | { kind: "ATTRIBUTED_BRAND"; attributedBrandIds: readonly string[] }
  | { kind: "ENTRY_CAMPAIGN"; campaignIds: readonly string[] }
  | { kind: "PRODUCT_CAMPAIGN"; campaignIds: readonly string[] }
  | { kind: "EXPERIENCE"; experienceIds: readonly string[] };
```

The Brand route only ever constructs `{ kind: "ATTRIBUTED_BRAND",
attributedBrandIds: [authorizedBrandId] }`. The Creator route only ever
constructs `{ kind: "EXPERIENCE", experienceIds: <owned Experience ids> }`.
Neither route accepts a raw `brandId`/`creatorProfileId` query parameter —
the scope is always derived from the authenticated session.

## Metric definitions and formulas

| Metric | Definition |
|---|---|
| **Total clicks** | `COUNT(*)` of `CommerceClickAttribution` rows in scope + date range. No deduplication. |
| **Unique clicking sessions** | `COUNT(DISTINCT sessionId)` where `sessionId IS NOT NULL`. Never uses `ipHash` as a visitor proxy (it is a peppered abuse-control value, not a stable identifier — it both over-counts across rotating IPs and under-counts across shared NAT). |
| **Unique logged-in users** | `COUNT(DISTINCT userId)` where `userId IS NOT NULL`. Anonymous visitors are never implied to be "unique users." |
| **Campaign-entry clicks** | `COUNT(*)` where `entryCampaignContextResolved = true`. **Not** a null-check on `entryCampaignId` — the boolean is the authoritative record of a genuinely resolved campaign entry and survives a later Campaign deletion (which nulls the id but leaves the boolean `true`), while a null-check would silently drift. |
| **Direct-entry clicks** | `COUNT(*)` where `entryCampaignContextResolved = false`. |
| **Surface breakdown** | `GROUP BY surface`, with `NULL` reported as an explicit `"UNKNOWN"` bucket (pre-Phase-10 history), never inferred from live relation state. |
| **Provider breakdown** | `GROUP BY provider`, `NULL` as `"UNKNOWN"`. A dimension, never a branch — see "Provider neutrality" below. |
| **Top products / Experiences / Lessons** | `GROUP BY` the relevant id, null-id rows dropped, ranked by clicks DESC then id ASC (deterministic tiebreak — without it, equal-count rows can swap order between identical requests). Clamped to a documented Top-N ceiling (`MAX_TOP_N_LIMIT = 50`). |
| **Entry-campaign (acquisition) breakdown** | `GROUP BY entryCampaignId` — **which campaign the visitor entered through.** Subject to cross-tenant disclosure redaction (Brand side only; see below). |
| **Product-campaign (authorization) breakdown** | `GROUP BY productCampaignId` — **which campaign authorized the clicked product.** A structurally separate query and response field from the entry-campaign breakdown. |
| **Daily time series** | Per-click `createdAt` bucketed into UTC calendar days across the resolved range, gap-filled with explicit zero (never omitted — a sparse series would make a quiet week look identical to a missing one). |

**`entryCampaignId` and `productCampaignId` are never summed, merged, or
displayed under one ambiguous "Campaign" label anywhere in this feature.**
One click can carry both, naming different campaigns owned by different
brands; adding them produces a number that means nothing. This is enforced
structurally (two separate response fields with mutually incompatible
`kind` discriminants) and verified by a source-inspection test asserting no
expression in either route combines the two breakdowns.

## Bounded/approximate values

`COUNT(DISTINCT col)` and day-truncated bucketing are not directly
expressible in Prisma without raw SQL. Rather than introduce `$queryRaw`,
both are computed with explicit, documented sampling ceilings:

- **Distinct session/user counts** (`countDistinctSessions`/
  `countDistinctUsers`): group-by-and-count-groups, capped at
  `MAX_DISTINCT_SAMPLE = 100,000`. Above the cap, the response carries
  `{ value: 100000, truncated: true }` and the UI renders it as a lower
  bound ("100,000+").
- **Daily time series** (`listClickTimestamps`, bucketed in the pure
  layer): capped at `MAX_TIME_SERIES_SAMPLE = 200,000` timestamps, ordered
  **ascending** by `createdAt` — so truncation drops the **newest** clicks,
  not the oldest. Both dashboards' truncation copy says explicitly that
  later days in the range can show `0` while still being counted in the
  headline total, to avoid a truncated series being misread as "traffic
  stopped."

No raw SQL exists anywhere in this feature — confirmed by a source
tripwire test (`$queryRaw`/`$executeRaw`/`Prisma.sql` grep, zero matches)
and independently re-confirmed by the adversarial review.

## Date/time semantics

`resolveCommerceClickAnalyticsDateRange` (pure, no `Date.now()` — a
reference `now` is always required when a bound is omitted, supplied by
each route as `new Date()`):

- `dateFrom`/`dateTo` must be strict `YYYY-MM-DD`. `new Date("2026-08-08")`
  is UTC by spec, but `new Date("2026-08-08T00:00")` is server-local — the
  parser rejects every shape but the strict calendar-date form, and
  round-trips the parsed value to reject non-existent dates like
  `2026-02-30`.
- `dateFrom` means `00:00:00.000Z`; `dateTo` means `23:59:59.999Z` of that
  date. Both bounds are **inclusive**.
- Neither supplied → last 30 UTC days ending at the end of `now`'s UTC day.
- `dateTo < dateFrom` → `400`, never silently swapped.
- A span wider than `MAX_ANALYTICS_RANGE_DAYS = 400` → `400`, never
  clamped — sized so a full year-over-year comparison (365 days + a leap
  day + a month of slack) is expressible while an unbounded/accidental
  `dateFrom=1970-01-01` cannot force a full-table scan.
- All aggregation is UTC. No tenant-timezone abstraction exists in this
  codebase (confirmed by audit; `docs/env-vars.md` has no timezone
  variable), so UTC is used throughout rather than trusting a
  client-supplied timezone string.

## Authorization

### Brand (`GET /api/brand/analytics/commerce`)

Reuses `getBrandAdminContext()`/`getBrandContextFailure` verbatim from the
existing `src/app/api/brand/analytics/route.ts` (403 unauthenticated/
unauthorized, 409 `ACTIVE_BRAND_REQUIRED` for a multi-brand admin with no
brand selected). No `brandId` query parameter exists at all — the scope is
always `[authorizedBrandId]` from session state.

### Creator (`GET /api/creator/analytics/commerce`)

Reuses `getCreatorContext()` from `src/lib/creator-auth.ts` — stricter than
the Brand pattern, requiring the exact `CREATOR` role (no global-`ADMIN`
bypass). Scope is the creator's own owned Experience ids
(`Experience.creatorId === creatorProfile.id`). An optional `experienceId`
filter, if supplied, is validated as a **member of the creator's own owned
set** before use; a foreign or unknown id returns a generic `404` **before
any query is issued** — never silently ignored (which would widen back to
the full owned set) and never distinguishable from a genuinely nonexistent
id.

## Multi-sponsor privacy (Brand side)

An Experience can be co-sponsored: a visitor acquired through Brand B's
campaign can click Brand A's product on the same Experience. Brand A's
entry-campaign (acquisition) breakdown legitimately contains that click —
Brand A may see that it happened — but must never learn Brand B's real
campaign id or name.

```ts
function resolveEntryCampaignDisclosure(
  entryCampaignBrandId: string | null,
  authorizedBrandId: string,
): "NONE" | "OWN" | "OTHER_CAMPAIGN" {
  if (entryCampaignBrandId === null || entryCampaignBrandId === "") return "NONE";
  if (authorizedBrandId.trim() === "") return "OTHER_CAMPAIGN"; // fails closed
  return entryCampaignBrandId === authorizedBrandId ? "OWN" : "OTHER_CAMPAIGN";
}
```

`DisclosedEntryCampaign` is a discriminated union where `campaignId`/
`campaignName` are structurally `null` on every arm except `"OWN"` — a leak
requires deliberately constructing a different object, not just forgetting
a check. An entry-campaign id that fails to resolve to any owner (e.g.
deleted between the group-by and the lookup) fails **closed** to
`OTHER_CAMPAIGN`, never `OWN`. All non-`OWN` rows are **summed into one
bucket** in the route (`buildDisclosedEntryCampaignBreakdown`) rather than
returned as N separate anonymous rows — returning N rows would still leak
that exactly N distinct competitor campaigns exist. `productCampaignId`
breakdown rows are same-brand by construction under normal operation (the
composite FK requires it), but as defense-in-depth against the admin
Campaign-reassignment hazard documented in the Phase 10 doc, each
product-campaign id's **current** `Campaign.brandId` is re-verified against
the authorized brand before its name is disclosed; on drift, it falls back
to the same generic bucket.

The independent adversarial review specifically attempted to defeat this
redaction (competitor campaign id/name via a different field, an error
message, a timing/count side channel) and found it holds. One residual,
documented, non-code limitation: a Brand re-requesting single-day ranges
can observe *when* the aggregate "other campaign" bucket was non-zero,
which narrows a competitor's campaign *schedule* on a shared Experience
without ever revealing its id, name, or count-of-distinct-campaigns. This
is inherent to exposing the bucket at all with a date filter and is
recorded as a P3/future product decision (e.g. a k-anonymity threshold),
not a defect.

## API contracts

Both endpoints return an explicit local TypeScript response type — never a
raw Prisma shape — and omit unsupported metrics entirely rather than
serializing a misleading zero for "revenue" or "conversions."

**`GET /api/brand/analytics/commerce?dateFrom&dateTo&limit`**

```ts
type BrandCommerceAnalyticsData = {
  range: { start: string; end: string };            // ISO, UTC
  limit: number;                                     // post-clamp
  totals: {
    clicks: number;
    uniqueSessions: { value: number; truncated: boolean };
    uniqueUsers: { value: number; truncated: boolean };
    campaignEntryClicks: number;
    directEntryClicks: number;
  };
  timeSeries: { date: string; clicks: number }[];
  timeSeriesTruncated: boolean;
  surfaceBreakdown: Record<"BRAND_STOREFRONT"|"CAMPAIGN_PRODUCT"|"LESSON"|"UNKNOWN", number>;
  providerBreakdown: { provider: string; clicks: number }[];
  entryCampaignBreakdown: /* disclosure-redacted rows, OTHER_CAMPAIGN collapsed */ [];
  productCampaignBreakdown: /* drift-verified rows, OTHER_CAMPAIGN collapsed */ [];
  topProducts: { id: string; name: string | null; clicks: number }[];
  topExperiences: { id: string; name: string | null; clicks: number }[];
  topLessons: { id: string; name: string | null; clicks: number }[];
};
```

**`GET /api/creator/analytics/commerce?dateFrom&dateTo&limit&experienceId`**

```ts
type CreatorCommerceAnalyticsData = {
  range: { start: string; end: string };
  filters: { experienceId: string | null; limit: number };
  totals: { clicks; uniqueSessions; uniqueUsers; campaignEntryClicks; directEntryClicks };
  timeSeries: { date: string; clicks: number }[];
  timeSeriesTruncated: boolean;
  surfaceBreakdown: Record<"BRAND_STOREFRONT"|"CAMPAIGN_PRODUCT"|"LESSON"|"UNKNOWN", number>;
  providerBreakdown: { provider: string; clicks: number }[];
  topProducts: { id: string; name: string | null; clicks: number }[];
  topLessons: { id: string; title: string | null; clicks: number }[];
  topExperiences?: { id: string; title: string | null; clicks: number }[]; // omitted when narrowed to one experienceId
  note: string; // the mandated click-only disclaimer
};
```

Both: `400` for a malformed/inverted/oversized date range or a malformed
`limit`; a brand/creator with zero clicks (or zero owned Experiences, on
the creator side) gets a clean all-zero response, never `404`/`500`; every
filter id is reauthorized server-side, never trusted from the client.
Neither route calls `groupByEntryCampaign`/`groupByProductCampaign`
outside their intended single call site, so the creator side never needs
its own version of the disclosure logic — a creator's queries are already
scoped to Experiences it owns, and it never surfaces a raw "top campaigns"
breakdown the way the brand side does.

**Deliberately omitted, not guessed at:** brand-side "top creators."
`groupByCreatorProfile` exists in the repository but is not called by
either route — no brand-facing surface today exposes creator identity, and
establishing that disclosure is a product decision left for a future,
purely additive change.

## Brand Analytics UI

`src/app/(withSidebar)/dashboard/brand/analytics/page.tsx` — a new
"Product clicks" section appended after the existing "By campaign" table,
using its own parallel fetch effect (the existing campaign-scoped effect
and its `shopClicks` metric are untouched). Cards: Product clicks, Clicking
sessions, Signed-in clickers, Campaign-entry clicks, Direct-entry clicks
(via the existing `MetricCard`, widened to accept a bounded/truncated
hint). Tables: daily series (inline CSS bars, no new chart dependency),
surface breakdown, provider breakdown, **Entry campaign** / **Product
campaign** breakdowns (never labelled bare "Campaign"), top products/
Experiences/Lessons. One-line disclaimer, verbatim:

> Commerce analytics currently measures outbound product clicks. Order and
> revenue attribution are not enabled.

## Creator Analytics UI

`src/app/(withSidebar)/dashboard/creator/analytics/page.tsx` — same
pattern (own effect, existing `MetricCard`), a from-scratch "Product
clicks" section since the pre-existing creator analytics route had zero
commerce involvement. Same five metric cards, daily series, surface/
provider breakdowns, top products/Lessons, and (when not narrowed to one
Experience) a breakdown by Experience. Same one-line disclaimer.

## Provider neutrality

Neither `commerce-click-analytics.ts` nor
`commerce-click-analytics-repository.ts` contains an `if (provider ===
"SHOPIFY")`-style branch anywhere — confirmed by a dedicated source
tripwire test and independently by the adversarial review. `provider` is
purely a `GROUP BY` dimension. When a Commerce7 adapter exists, its clicks
flow through the exact same repository methods, pure-layer builders, API
routes, and UI with zero code change — only new data.

## AnalyticsEvent vs. CommerceClickAttribution boundary

Commerce clicks are recorded exclusively in `CommerceClickAttribution`;
`AnalyticsEvent` remains the store for non-commerce telemetry (`qr_scan`,
`lesson_started`, `lesson_completed`, etc.). No code path in this feature
reads or writes `AnalyticsEvent`, and no `shop_click`/`lesson_product_click`
beacon was reintroduced — confirmed by source tripwire tests in
`tests/brand-analytics-commerce-clicks.test.ts` and
`tests/dashboard-commerce-click-analytics.test.ts` (both pre-existing,
unmodified and still passing) plus a new tripwire covering the analytics
core/repository files specifically.

## Unsupported metrics (explicitly not implemented)

Revenue, sales, conversions, conversion rate, ROAS, order value,
commission, purchase-based points, click-to-order matching, buyer identity.
None of these fields exist anywhere in either response contract — they are
omitted entirely, not serialized as a misleading zero.

## Manual test plan

Setup for all scenarios: a Brand with an active `CommerceConnection`, at
least one campaign-curated product (`CampaignCommerceProduct`) and one
lesson product (`CampaignLessonProduct`), and a second Brand sharing at
least one Experience for the multi-sponsor scenario.

| # | Scenario | Action | Expected UI | Expected DB effect |
|---|---|---|---|---|
| A | Campaign entry → Brand storefront product | Visit `/c/<slug>` for Campaign A, then click a generic (non-curated) product on the Experience's shop page | Redirect to merchant URL | New `CommerceClickAttribution` row: `entryCampaignId=A`, `productCampaignId=null`, `surface=BRAND_STOREFRONT`, `attributedBrandId=<brand>` |
| B | Campaign entry → Campaign product | Same entry, click a product curated for Campaign A | Redirect | `entryCampaignId=A`, `productCampaignId=A`, `surface=CAMPAIGN_PRODUCT` |
| C | Direct entry → Campaign product | Visit `/x/<experienceSlug>` directly (no campaign landing/QR), click a Campaign-A-curated product | Redirect | `entryCampaignId=null`, `entryCampaignContextResolved=false`, `productCampaignId=A`, `surface=CAMPAIGN_PRODUCT` |
| D | Lesson product click | From a lesson page, click an attached product | Redirect | `surface=LESSON`, `campaignLessonProductId` set, `lessonId` set |
| E | Brand Analytics | Load `/dashboard/brand/analytics` as Brand A after A/B/C/D | "Product clicks" section shows non-zero totals, correct surface breakdown, correct entry/product campaign breakdowns | — |
| F | Creator Analytics | Load `/dashboard/creator/analytics` as the Experience's creator | "Product clicks" section shows the same underlying clicks scoped to owned Experiences | — |
| G | Date filters | Set a `dateFrom`/`dateTo` bracketing only some of the above clicks | Totals/series reflect only the bracketed clicks; boundary days included | — |
| H | Multi-brand Experience isolation | As Brand B (co-sponsor of the same Experience, entry via Brand B's campaign, clicking Brand A's product), then view Brand A's analytics | Brand A sees the click counted, with acquisition source shown as a generic "Other campaign" — never Brand B's real campaign name/id | `entryCampaignId` on that row belongs to Brand B; `attributedBrandId` belongs to Brand A |
| I | Empty state | View analytics for a brand-new Brand/Creator with no clicks | All-zero tiles, empty tables, no error, no 404 | — |
| J | Provider breakdown | (Single-provider environment today) | Provider breakdown shows `SHOPIFY` only, no other-provider branch anywhere in the UI/response | — |

## SQL verification (read-only)

Run against a **non-production** database only, via the existing safe
tooling. All queries below are read-only.

```sql
-- Total clicks in the last 30 days
SELECT COUNT(*) FROM "CommerceClickAttribution"
WHERE "createdAt" >= now() - interval '30 days';

-- Surface breakdown, including the honest UNKNOWN (null) bucket
SELECT COALESCE(surface::text, 'UNKNOWN') AS surface, COUNT(*)
FROM "CommerceClickAttribution"
GROUP BY 1 ORDER BY 2 DESC;

-- Direct vs. campaign-entry split (uses the durable boolean, not a null-check)
SELECT "entryCampaignContextResolved", COUNT(*)
FROM "CommerceClickAttribution"
GROUP BY 1;

-- Unique sessions / unique users
SELECT COUNT(DISTINCT "sessionId") AS unique_sessions,
       COUNT(DISTINCT "userId")    AS unique_users
FROM "CommerceClickAttribution";

-- Top products (brand-curated catalog id)
SELECT "brandCommerceProductId", COUNT(*) AS clicks
FROM "CommerceClickAttribution"
WHERE "brandCommerceProductId" IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;

-- Top Experiences / Lessons
SELECT "experienceId", COUNT(*) FROM "CommerceClickAttribution"
GROUP BY 1 ORDER BY 2 DESC LIMIT 10;
SELECT "lessonId", COUNT(*) FROM "CommerceClickAttribution"
WHERE "lessonId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 10;

-- Entry-campaign (acquisition) breakdown
SELECT "entryCampaignId", COUNT(*) FROM "CommerceClickAttribution"
WHERE "entryCampaignId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;

-- Product-campaign (authorization) breakdown — NEVER add this to the query above
SELECT "productCampaignId", COUNT(*) FROM "CommerceClickAttribution"
WHERE "productCampaignId" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC;

-- Provider breakdown
SELECT COALESCE(provider::text, 'UNKNOWN'), COUNT(*)
FROM "CommerceClickAttribution" GROUP BY 1;

-- Cross-brand integrity: attributedBrandId should never equal an entry
-- campaign's brand when that brand differs from the click's own brand
-- (spot-check a known multi-sponsor row by id)
SELECT id, "attributedBrandId", "entryCampaignId", "productCampaignId", surface
FROM "CommerceClickAttribution" WHERE id = '<row id>';

-- Confirm the new columns exist and are nullable, no FK
SELECT column_name, is_nullable, data_type
FROM information_schema.columns
WHERE table_name = 'CommerceClickAttribution'
  AND column_name IN ('surface', 'attributedBrandId');

SELECT constraint_name FROM information_schema.table_constraints
WHERE table_name = 'CommerceClickAttribution' AND constraint_type = 'FOREIGN KEY';
-- attributedBrandId must not appear in the FK column list of any row above

-- Confirm CommerceOrder tables remain unused (row count should reflect only
-- whatever pre-existing dormant-phase testing occurred, never live traffic)
SELECT COUNT(*) FROM "CommerceOrder";
```

## Verification summary

`npx prisma format/validate/generate` clean; `npm run typecheck` clean;
`npm run lint` clean; full test suite (blocked DB URL) **1355 tests, 1353
pass, 0 fail, 2 skipped**; `npm run build` (blocked DB URL) succeeds,
including both new routes in the manifest; `git diff --check` clean;
`git diff -- shopify.app.toml shopify.app.custom.toml` empty; independent
adversarial review found **0 P0, 0 P1** (four P2 fixes applied and
re-verified — see the final report for detail).
