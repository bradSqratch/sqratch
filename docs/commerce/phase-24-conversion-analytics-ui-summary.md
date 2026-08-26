# Phase 24 — Conversion & revenue analytics UI (Brand + Creator)

Phase 24 surfaces existing backend capability. It does not add a new
attribution mechanism, does not touch `click-token.ts` / `click-attribution.ts`
/ `order-ingestion.ts` / the provider webhook handlers, and requires no schema
migration. The conversion aggregator (`buildConversionAnalytics`,
`src/lib/commerce/order-analytics.ts`) and both conversion routes
(`/api/brand/analytics/conversions`, `/api/creator/analytics/conversions`)
already existed and were already exercised by `tests/order-analytics.test.ts`
— they simply had no UI consumer. This phase wires the Brand and Creator
Analytics dashboards to them, adds small, strictly-scoped name resolution so
breakdown rows show something better than a raw id, and corrects a stale
"order and revenue attribution are not enabled" sentence that was no longer
true.

## What was added

- `src/lib/commerce/conversion-breakdown-naming.ts` (new) — one pure function,
  `attachConversionNames`, that attaches a resolved display name onto a
  `{ id, orders }` breakdown row. Has no tenant identity and does no
  authorization; it exists purely so both routes share one tested
  implementation instead of two hand-rolled `Map` loops.
- `src/lib/commerce/conversion-analytics-client.ts` (new) — the shared,
  DB-free response contract for both dashboards: TypeScript types,
  `parseBrandConversionAnalytics` / `parseCreatorConversionAnalytics` (permissive
  shape-check-then-cast validators, same idiom as
  `commerce-response-validation.ts`), `providerLabel`, and `formatMoneyRows`
  (per-currency display lines, reusing `money.ts`'s exact currency-exponent
  resolution — never a hardcoded `/100`).
- `src/app/api/brand/analytics/conversions/route.ts` (modified) — every
  breakdown (`attributedOrdersByEntryCampaign`, `...ProductCampaign`,
  `...Experience`, `...Creator`, `...Lesson`, `...Product`) is now enriched
  with a `name` field. `buildConversionAnalytics` itself is untouched; the
  route resolves names AFTER calling it, via `enrichBrandConversionBreakdownNames`
  (exported, pure, unit-tested with plain `Map`s — no Prisma needed to test it).
- `src/app/api/creator/analytics/conversions/route.ts` (modified) — same
  `name`-enrichment for `attributedOrdersByExperience` / `...Lesson` /
  `...Product` (never for the campaign dimensions, which stay structurally
  empty), plus a new optional `experienceId` query parameter that narrows the
  creator's own scope, reusing the exact ownership check
  (`getOwnedExperienceForCreator`) the existing `/api/creator/analytics` route
  already uses.
- `src/app/(withSidebar)/dashboard/brand/analytics/page.tsx` (modified) — new
  "Attributed conversions & revenue" section, own loading/error/data state, own
  fetch effect, race-safe request sequencing. Stale click-only copy corrected.
- `src/app/(withSidebar)/dashboard/creator/analytics/page.tsx` (modified) —
  equivalent creator-scoped section, with the Experience filter wired through.
- Tests: `tests/conversion-breakdown-naming.test.ts`,
  `tests/conversion-analytics-client.test.ts`,
  `tests/conversion-analytics-routes-enrichment.test.ts`,
  `tests/brand-analytics-conversions.test.ts`,
  `tests/creator-analytics-conversions.test.ts` (all new). `tests/order-analytics.test.ts`
  is unmodified and still passes unchanged — proof `buildConversionAnalytics`'s
  own contract was never touched.

## Endpoints consumed

- `GET /api/brand/analytics/conversions?dateFrom=&dateTo=` — unchanged
  authentication/scoping, unchanged existing fields, `name` added to every
  breakdown row.
- `GET /api/creator/analytics/conversions?dateFrom=&dateTo=&experienceId=` —
  same, plus the new optional `experienceId` narrowing filter and a new
  `filters: { experienceId }` echo field.

Both are GET-only, read-only. Neither this phase nor the underlying routes
write anything.

## Metric meanings (exactly as the backend defines them — never reinterpreted)

- **Orders ingested** (Brand only) — every `CommerceOrder` this brand received
  in the date range, attributed or not. Omitted from the Creator dashboard: the
  creator route's Prisma query already filters to
  `attribution.creatorProfileId = <this creator>`, so every row it can ever see
  is already attributed — `totalIngestedOrders` and `attributedOrders` are
  always numerically identical in creator scope. Showing both would imply a
  creator can see a merchant's full order volume, which they cannot.
- **Attributed orders** — orders with the established, exact click-token
  attribution. Never inferred from email, IP, time proximity, campaign/product
  similarity, referrer, or user agent — see `order-analytics.ts`'s own header.
- **Current paid conversions** (`currentlyNetPositivePaidOrders`) — the
  backend's existing definition (`PAID`/`PARTIALLY_PAID`/`PARTIALLY_REFUNDED`
  with positive `netRevenueMinor`), rendered as-is. The UI does not compute a
  different notion of "paid" from `financialStatus` or from revenue itself.
- **Pending / authorized**, **Partially refunded**, **Fully refunded** — server
  counts, rendered verbatim. A fully refunded order is guaranteed to be
  excluded from "current paid conversions" by the backend's own filter, not by
  any client-side re-check.
- **Gross / Refunded / Net attributed revenue** — three separate per-currency
  arrays, never merged into one card or one number.

## Date-window semantics and why no conversion-rate is shown

Click analytics (`/api/*/analytics/commerce`) are scoped by **click time**.
Conversion analytics are scoped by **order time** (`CommerceOrder.createdAt`).
An order can land in a different date window than the click that produced it
— the same visitor's click might fall on one side of a `dateTo` boundary and
their order on the other. Dividing `attributedOrders` by the click count from
the sibling endpoint would therefore not merely be imprecise, it would be
**analytically invalid**: the two numbers are not drawn from the same cohort.
No such percentage is computed anywhere in this phase. There is currently no
conversion time-series in `buildConversionAnalytics` either, so none was
fabricated — the click-analytics daily chart and the conversion analytics
section remain visually and conceptually distinct.

## Cross-currency handling

Every money figure (`grossAttributedRevenueByCurrency`,
`refundedRevenueByCurrency`, `netAttributedRevenueByCurrency`) is an array of
`{ currencyCode, minor }`, one row per currency actually present. `minor` is a
decimal string (never a parsed `number`), so a value beyond
`Number.MAX_SAFE_INTEGER` is never silently corrupted crossing the network.
`formatMoneyRows` renders each row as its own independent line
(`"CAD 98.31"`, `"USD 42.00"`); nothing in the client ever sums two rows'
`minor` values. A row with `currencyCode === "UNKNOWN"` (the aggregator's
bucket for an order whose own currency could not be resolved) renders as
`"Unknown currency — <n> minor units"` — never a fabricated `$`/CAD/USD symbol
or a guessed decimal exponent. An empty array renders "No attributed revenue in
this range." rather than `$0.00`, since an empty array is not evidence of a
known currency sitting at zero.

## Brand disclosure boundary

- **Entry/product campaign**: the route already drops (never buckets) a
  foreign brand's campaign id before calling `buildConversionAnalytics`
  (`ownedCampaignId`, unchanged this phase) — so every id this phase's name
  lookup ever sees is already brand-owned. The UI additionally explains, in the
  breakdown's own subtext, that a foreign acquisition campaign's orders still
  count in the totals above but have nothing to name in this table (no
  regression from the click-analytics precedent, which buckets foreign
  campaigns into a generic row instead of dropping them — conversions keep
  their pre-existing, stricter drop behavior; this phase did not change it).
- **Experience / Lesson / connected product / Creator names**: resolved from
  ids that came ONLY from this brand's own already-scoped attributed orders,
  never from client input — the same trust boundary
  `src/app/api/brand/analytics/commerce/route.ts` already relies on for its
  `topExperiences`/`topLessons`. The product name lookup additionally applies a
  real `brandId` filter (`ConnectedCommerceProduct.brandId`) as defense in
  depth. Creator `displayName` resolution is not a new disclosure: a brand
  necessarily already knows which creators are promoting its commerce (through
  campaign/Experience assignment elsewhere in the app), and the only creator
  ids ever looked up are ones that appear in this brand's own received orders.

## Creator disclosure boundary

- No campaign id or name of any kind is ever selected, computed, or rendered.
  The route nulls both campaign dimensions before aggregation (unchanged), so
  `attributedOrdersByEntryCampaign`/`...ProductCampaign` are always empty; the
  Creator page has no UI section for them at all, so an empty array can never
  be mistaken for "0 campaign performance."
- No whole-order basket composition: `lineItems` is passed to the aggregator
  as `[]` (unchanged), so the product breakdown falls back to the click's own
  `connectedProductId` — the one product this creator actually drove traffic
  to.
- Experience and Lesson name lookups are re-scoped to this creator's ownership
  on every read (`creatorId: creatorProfileId` / `course.experience.creatorId:
  creatorProfileId`), not resolved from a bare id.
- The new `experienceId` filter can only ever **narrow** the existing
  `creatorProfileId` scope (it is appended into the same `attribution.is`
  object, never a replacement of it), and a foreign or unknown Experience id
  is rejected with the exact same generic 404
  (`getOwnedExperienceForCreator`) the pre-existing `/api/creator/analytics`
  and `/api/creator/analytics/commerce` routes already use — indistinguishable
  from "does not exist."
- No customer PII of any kind (name, email, phone, address, IP, session id,
  payment data) is read, selected, or rendered anywhere in this phase.

## Empty states

- Zero orders ingested (Brand): "No commerce orders were recorded in this date
  range."
- Orders ingested, none attributed yet (Brand): "Orders have been ingested, but
  none in this range have exact SQRATCH attribution yet." — the explicit case
  called out for while Commerce7's webhook delivery remains unresolved (see
  below); Commerce7 orders currently reach SQRATCH only through reconciliation,
  which does not carry click-token attribution.
- Zero attributed orders (Creator): a single equivalent message, since the
  creator route only ever sees already-attributed rows.
- Empty revenue array: "No attributed revenue in this range." (never `$0.00`).
- Large breakdowns (e.g. many distinct products) are capped to the top 10 rows
  client-side (already sorted by order count, descending, by the backend) with
  a "+N more not shown" note, rather than an unbounded table.

## Provider neutrality

`attributedOrdersByProvider` is rendered through a small label map
(`SHOPIFY` → "Shopify", `COMMERCE7` → "Commerce7") with a safe fallback to the
raw value for any future provider — no `if (provider === "SHOPIFY")` branching
exists anywhere in the metric logic itself, which is already provider-neutral
at the `CommerceOrder`/`CommerceOrderEvent` model level. A connection whose
orders are all currently unattributed (true for the sandbox Commerce7
connection today, given the open webhook-auth issue) shows that honestly via
the empty-attribution state above — it is never hidden or special-cased.

## Reconciliation vs. webhook — analytics does not care

Conversion analytics reads only the canonical `CommerceOrder` /
`CommerceClickAttribution` relation. It never filters by
`CommerceOrderEvent.topic`, so it is indifferent to whether an order reached
SQRATCH via a live webhook or via trusted reconciliation/backfill — that
distinction is Order Operations' concern (`/dashboard/brand/commerce/orders`,
linked from the new section via a small "View order operations" button), not
Analytics'. An order is counted as **attributed** only when the canonical
attribution relation exists; reconciliation finding an order never implies
attribution.

## Schema

No Prisma schema change. No migration. Every field this phase reads already
existed on `CommerceOrder` / `CommerceOrderLineItem` / `CommerceClickAttribution`
/ `Campaign` / `Experience` / `Lesson` / `CreatorProfile` /
`ConnectedCommerceProduct`.

## Manual verification

1. **Brand, no orders**: pick a date range with zero orders. Expect "No
   commerce orders were recorded in this date range."
2. **Brand, unattributed orders only** (current Commerce7 sandbox state):
   expect the 6 count cards (all attributed-derived counts at 0, "Orders
   ingested" > 0) plus the "ingested, but none... attributed yet" banner.
3. **Brand, attributed orders**: expect all 6 cards populated truthfully, three
   revenue cards each showing one line per currency, and all 7 breakdowns
   (provider, entry campaign, product campaign, Experience, Creator, Lesson,
   Product) populated with names where resolvable.
4. **Partial/full refund**: an order refunded in full must show under "Fully
   refunded" and contribute to "Refunded attributed revenue," never to
   "Current paid conversions" or "Net attributed revenue."
5. **Multiple currencies**: a brand/creator with orders in more than one
   currency must show one line per currency in every revenue card, never a
   combined figure.
6. **Creator Analytics privacy**: open `/dashboard/creator/analytics` as a
   creator with attributed orders. Confirm no campaign name/id appears
   anywhere in the conversion section, and that selecting a different
   Experience in the filter narrows the conversion section too (not just
   engagement/click sections).
7. **Mobile/responsive**: at a narrow viewport, confirm the breakdown tables
   scroll horizontally within their own container rather than breaking page
   layout, and every card remains readable.

## Remaining limitations (explicit, not hidden)

- Commerce7 exact conversion attribution is not currently observed in
  production: the live Commerce7 webhook Basic-Auth issue (tracked and
  diagnosed separately — see `commerce7-order-webhook-auth.ts`, untouched by
  this phase) means Commerce7 orders currently reach SQRATCH only via
  reconciliation, which never carries click-token attribution. This shows
  honestly as the "ingested, but not attributed" empty state rather than being
  hidden.
- Click analytics and conversion analytics windows are not cohort-aligned (see
  above), so no conversion-rate percentage is shown — this is a deliberate,
  permanent property of the two endpoints' different time bases, not a gap to
  be filled later without a real cohort-aligned backend definition.
- The Brand-side product breakdown names use `ConnectedCommerceProduct.title`
  (the canonical synced title), not the brand's curated
  `BrandCommerceProduct.titleOverride`: order/click attribution stores the
  canonical `connectedProductId` directly, not the per-brand curated row, so
  resolving the override would require an additional join this phase judged
  unnecessary for a breakdown label.
- Breakdown tables cap at 10 rows client-side; there is no pagination or
  "view all" affordance for a brand with more than 10 distinct entries in one
  dimension.
