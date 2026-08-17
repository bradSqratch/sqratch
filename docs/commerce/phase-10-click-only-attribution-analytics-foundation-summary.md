# Phase 10 — Durable Click-Only Attribution Analytics Foundation

> **Superseded rollout status:** Phase 12 adds exact-token order conversion
> attribution. Click analytics remain click-only; conversion metrics are exposed
> separately and do not turn a click count into an inferred purchase.

## Click-only decision

Phase 10 tracks exactly one fact: **a visitor was redirected from a SQRATCH
commerce surface to a merchant page.** It does not track, imply, or make
answerable: purchases, conversions, conversion rate, sales, revenue,
attributed revenue, affiliate commissions, ROAS, order value, purchase-based
points, click-to-order matching, or buyer identity. **As of Phase 10/11**,
`CommerceOrder`, `CommerceOrderLineItem`, and `CommerceOrderEvent` (Phase 7)
remained fully dormant — nothing added in Phase 10 or Phase 11 read them, and
no Shopify `read_orders` scope or order/refund webhook topic had been added
yet. **Phase 12 has since added `read_orders` and the order/refund webhook
topics** (see
[phase-12-live-order-ingestion-and-conversion-attribution-summary.md](phase-12-live-order-ingestion-and-conversion-attribution-summary.md)) —
click analytics themselves are unaffected and remain click-only; conversion
metrics are a separate, additive surface (`/api/brand/analytics/conversions`,
`/api/creator/analytics/conversions`) that does not turn a click count into
an inferred purchase. See
[phase-7-order-normalization-summary.md](phase-7-order-normalization-summary.md)
and the "Why Phase 7 stays dormant" section below for the Phase 10/11-era
reasoning, which still explains why click analytics and order/conversion
analytics are architecturally separate.

This document covers the durability foundation (schema + pure/repository
layers). API and UI consumption is covered in
[phase-11-provider-neutral-commerce-analytics-summary.md](phase-11-provider-neutral-commerce-analytics-summary.md).

## The problem this phase solves

Before Phase 10, `CommerceClickAttribution` recorded a click's context
entirely through optional foreign keys (`campaignLessonProductId`,
`productCampaignId`, `brandId`, etc.) plus an in-memory-only
`CommerceClickSurface` discriminated union
(`src/lib/commerce/click-attribution.ts`) that was never persisted. Two
independent decay paths meant a click's *true* surface and brand ownership
could silently change after the fact:

1. Deleting a `CampaignLessonProduct` row nulls `campaignLessonProductId`
   (`onDelete: SetNull`) but leaves `lessonId`/`productCampaignId` intact —
   a `LESSON` click would start looking like a `CAMPAIGN_PRODUCT` click.
2. Deleting the `Campaign` referenced by `productCampaignId` fires the
   composite foreign key `(productCampaignId, brandId) → Campaign(id,
   brandId)` with `onDelete: SetNull`. PostgreSQL nulls **both**
   `productCampaignId` and `brandId` together — a `CAMPAIGN_PRODUCT` click
   degrades toward `BRAND_STOREFRONT` *and* simultaneously loses brand
   attribution.

A third, previously undocumented hazard: the same composite foreign key
also carries `onUpdate: Cascade`. An admin reassigning a `Campaign`'s
`brandId` (`src/app/api/admin/campaigns/[id]/route.ts`, validated only for
existence, not "same brand as before") causes PostgreSQL to **rewrite**
`CommerceClickAttribution.(productCampaignId, brandId)` on every historical
click row from the old brand to the new one — silently reassigning
historical click evidence to a different tenant. Phase 10 does not change
that admin route or the foreign key's cascade behavior (out of scope, and
the task explicitly ruled out "redesign the entire database"); it instead
makes Brand analytics immune to it.

## Durable surface strategy

Two new nullable columns were added to `CommerceClickAttribution`
(`prisma/migrations/20260808150000_add_commerce_click_analytics_durability/migration.sql`):

```prisma
enum CommerceClickSurface {
  BRAND_STOREFRONT
  CAMPAIGN_PRODUCT
  LESSON
}

model CommerceClickAttribution {
  // ...
  surface           CommerceClickSurface?
  attributedBrandId String?
  // ...
}
```

**`surface`** — captured once, at click time, from the same
`CommerceClickSurface["kind"]` discriminated union that was already being
constructed per-request in `click-attribution.ts`. The three enum values
are exactly the three existing `kind` values (`BRAND_STOREFRONT`,
`CAMPAIGN_PRODUCT`, `LESSON` — deliberately matching the real code, not the
task prompt's example naming of `LESSON_PRODUCT`). Nullable, no default,
never updated after insert.

**`attributedBrandId`** — an immutable snapshot of the click's resolved
brand, written once from the same value used for `brandId`. It is
deliberately **not** a foreign key: `brandId` is jointly owned by two FKs (a
plain FK to `Brand`, and the composite `(productCampaignId, brandId)` FK to
`Campaign` described above), so it can be nulled by a Campaign deletion or
silently rewritten by an admin's Campaign-brand reassignment.
`attributedBrandId` has no relation, no `onDelete`, no `onUpdate` — nothing
in the schema can touch it after insert. **This is the column Brand
analytics scopes on, never `brandId`.**

Both columns are **nullable with no backfill**. Every click recorded before
this migration has `surface = NULL` and `attributedBrandId = NULL`. That is
the deliberately honest state: a pre-Phase-10 click's true surface is
frequently unrecoverable (see the two decay paths above), so a migration-time
`UPDATE` attempting to reconstruct it from current relation state would
itself commit the same inference-from-topology mistake this phase exists to
eliminate. The analytics layer treats `surface IS NULL` as an explicit
`"UNKNOWN"` bucket, never a guess.

## Why nullable, not NOT NULL

`recordAttribution`'s entire call is wrapped in a fail-open try/catch (see
[phase-6-commerce-click-attribution-summary.md](phase-6-commerce-click-attribution-summary.md)'s
"Fail-open design" section) — losing one attribution row is a reporting gap,
but blocking the merchant redirect on an analytics-write failure is an
outage on the revenue path. A `NOT NULL` constraint on either new column
would turn a caller that omits it into a hard failure inside that fail-open
path. Both columns are optional on `AttributionInput`
(`src/lib/commerce/click-attribution.ts`) for the same reason: production
always supplies both, but the type does not require it, so existing and
future test doubles keep compiling and no caller can accidentally turn a
missing value into a thrown error.

## Write-once durability (verified, not just claimed)

`tests/commerce-click-attribution.test.ts` — describe block "Phase 10
write-once durability: no code path rewrites surface or attributedBrandId"
— walks the entire `src/` tree and asserts:

- The only mutating Prisma method ever called on `commerceClickAttribution`
  across the whole codebase is `create` (exactly one call site, in
  `click-attribution.ts`) and `updateMany` (exactly one call site, in
  `src/lib/commerce/order-ingestion.ts`, writing only `consumedAt`/
  `consumedByOrderRef` for the dormant order-claim seam — it never touches
  `surface` or `attributedBrandId`).
- No file anywhere assigns `.surface =` or `.attributedBrandId =` on a
  fetched row.
- No `$queryRaw`/`$executeRaw`/`Prisma.sql` exists anywhere in `src/`, so no
  raw SQL can bypass the above.
- The analytics layer never re-derives a surface from live relation state:
  neither `commerce-click-analytics.ts` nor
  `commerce-click-analytics-repository.ts` references
  `campaignLessonProductId` in executable code, and the repository groups by
  the literal persisted `surface` column.

A companion describe block ("Phase 10 durable capture: surface and
attributedBrandId per surface kind") exercises all three surface kinds
end-to-end through `handleCommerceClick`/`recordAttribution` and asserts the
exact persisted values, including a case where the entry campaign's brand
and the clicked product's brand differ, proving `attributedBrandId` tracks
the *product's* resolved brand, not the entry campaign's.

## Indexes

Eight new indexes were added
(`prisma/schema.prisma`, `CommerceClickAttribution`):

```
@@index([attributedBrandId, createdAt])
@@index([attributedBrandId, surface, createdAt])
@@index([surface, createdAt])
@@index([creatorProfileId, createdAt])
@@index([lessonId, createdAt])
@@index([brandCommerceProductId, createdAt])
@@index([connectedProductId, createdAt])
@@index([qrCodeId, createdAt])
```

The first three serve the durable-brand analytics path directly (every
Brand-side query filters on `attributedBrandId`, and the surface breakdown
is the flagship query). The independent adversarial review (see Phase 11
doc) found that the migration's own comment overstates the justification for
the remaining five: they do not, in fact, serve any Phase 10 group-by as a
*filter* index (each Phase 10 query filters on `attributedBrandId` or
`experienceId` and groups by the other column, which Postgres serves from
the brand/experience index and aggregates). Their real justification —
correct, and sufficient on its own — is that all five were previously
**completely unindexed** FK columns, each the target of an `ON DELETE
SET NULL` cascade, so every deletion of a referenced Lesson/Product/QRCode/
CreatorProfile row was forcing a full sequential scan of this table. Fixing
the migration comment is left as a follow-up (editing an applied migration
file's checksummed SQL is unsafe without direct database access, which this
work was never permitted to have); `prisma/schema.prisma`'s mirrored comment
should be corrected in the commit that applies this migration.

## Relation-deletion / historical-ownership review

Reviewed for `Campaign`, `Brand`, `BrandCommerceProduct`,
`ConnectedCommerceProduct`, and `CampaignLessonProduct` deletion:

- **Brand ownership**: now durable via `attributedBrandId` (non-FK,
  never cascaded).
- **Surface identity**: now durable via `surface` (non-FK-adjacent enum,
  never cascaded).
- **Campaign acquisition identity** (`entryCampaignId`) and **product
  authorization identity** (`productCampaignId`): intentionally left as
  plain `SetNull` FKs, not snapshotted. These two remain genuinely
  best-effort historical facts — a deleted Campaign's name/id becomes
  unavailable for that click going forward, which is accepted as a known
  limitation (see below) rather than solved with a further snapshot column,
  per the phase's explicit "do not redesign the entire database" and
  "document every denormalized field and why it is required" constraints.
  No PII, raw merchant payload, or user identity is snapshotted anywhere.

## Privacy

No new PII is stored. The two new columns are SQRATCH-internal catalog ids
and an enum — no email, name, IP, session id, or provider payload. The
existing Phase 6 privacy posture (`ipHash`, `userAgent`, `userId`,
no-referrer-persistence, 30-day `expiresAt`) is unchanged; see
[phase-6-commerce-click-attribution-summary.md](phase-6-commerce-click-attribution-summary.md).

## Why Phase 7 stayed dormant through Phase 10/11 (superseded by Phase 12)

**As of Phase 10/11**, Phase 7's `CommerceOrder`/`CommerceOrderLineItem`/
`CommerceOrderEvent` models and Shopify order-webhook normalizer existed but
were not referenced by any live route, not wired into `shopify.app.toml`,
and required no `read_orders` scope. Phase 10/11's own click-analytics code
never imported, queried, or wrote to any of these three models — confirmed
at the time by a whole-tree grep tripwire test and an independent adversarial
review. Activating order tracking was deliberately left as a separate, later,
independently-scoped and independently-reviewed decision; this phase's
analytics foundation was architected so that decision, whenever it happened,
would not require touching `CommerceClickAttribution`'s schema again — and it
didn't (Phase 12 added `surface`-adjacent columns to nothing; it consumes
`CommerceClickAttribution` read-only through the same `tokenHash` lookup
path Phase 6 always intended, see
[phase-12-live-order-ingestion-and-conversion-attribution-summary.md](phase-12-live-order-ingestion-and-conversion-attribution-summary.md)).

**Phase 12 has since activated order tracking.** The click-analytics
code paths described throughout this document remain unchanged and remain
click-only — they still never read `CommerceOrder`/`CommerceOrderLineItem`/
`CommerceOrderEvent`. Conversion/order analytics now exists as an
architecturally SEPARATE surface (`/api/brand/analytics/conversions`,
`/api/creator/analytics/conversions`, `src/lib/commerce/order-analytics.ts`),
so a click total and a conversion total are never silently combined into one
number by either surface.

## Future Commerce7 compatibility

`surface` and `attributedBrandId` are both provider-neutral: neither
references a Shopify-specific concept, and the existing `provider
CommerceProvider?` column (already `SHOPIFY | COMMERCE7`) continues to be a
plain dimension on every new query, never a branch. When a Commerce7
adapter eventually mints clicks, no schema or analytics-core change is
required — the same columns, the same repository methods, and the same pure
shaping functions apply unchanged.

## Limitations

- Pre-Phase-10 clicks report `surface: null` / `attributedBrandId: null`
  forever; analytics buckets them as `"UNKNOWN"` rather than guessing. This
  will look like a step-change in a "clicks by surface" chart at the
  deploy boundary — that is correct and should be labelled in the UI, not
  treated as data loss.
- `entryCampaignId`/`productCampaignId` are not snapshotted; a deleted
  Campaign's name becomes permanently unavailable for clicks that reference
  it, even though the click count itself remains intact.
- The pre-existing `ON UPDATE CASCADE` hazard on the
  `(productCampaignId, brandId) → Campaign` composite FK (an admin
  reassigning a Campaign's brand rewrites historical `brandId` values) is
  documented, not fixed, in this phase. `attributedBrandId` is the
  mitigation for analytics; the underlying admin-route gap remains a
  candidate for a future, separately-scoped fix.
