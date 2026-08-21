# Phase 8 — Canonical Commerce, Legacy Elimination

## The one operational thing you must not miss

**A full product resync for every connected brand is a required deploy step,
not a follow-up.**

`20260808120000_add_connected_product_storefront_availability` added
`ConnectedCommerceProduct.hasPublicStorefrontUrl` with `DEFAULT false`, and this
phase now gates **both** public rendering **and** the click/redirect path on that
column being `true`. So the moment this phase deploys, every already-synced
product is treated as having no public storefront destination: it will not render
on any public lesson or shop surface, and it will not be clickable, until its
brand re-runs a product sync.

That is deliberate fail-closed behavior and is precisely the fix for the
storefront-404 bug described in
[The storefront-availability fix](#the-storefront-availability-fix). It is also
a temporary outage of public commerce if the resync is skipped. Deploy runbook
order:

1. Operator manually clears the legacy product-link rows (preflight below).
2. `npx prisma migrate deploy`.
3. Product sync for **every** connected brand.
4. Spot-check that one public lesson product renders and redirects.

## What this phase is

Before Phase 8, a product attached to a lesson could be represented **two
different ways** — a canonical `CampaignLessonProduct` row, or a free-form
`LessonProductLink` snapshot row that a creator had typed by hand — and the
public render path would fall back to live Shopify if neither resolved. Three
representations of the same fact, with different authorization properties.

Phase 8 removes the legacy two, leaving exactly one. It is a
deletion-and-consolidation phase; it adds no product capability.

## What was removed

### Schema (dropped by `20260808130000_remove_legacy_product_link_snapshots`)

| Object | Kind |
|---|---|
| `ExperienceProductLink` | table |
| `LessonProductLink` | table |
| `CampaignLessonProduct.legacyLessonProductLinkId` | column (+ its unique index and `SET NULL` FK) |
| `CommerceClickAttribution.lessonProductLinkId` | column |
| `CommerceClickAttribution.experienceProductLinkId` | column |
| `Campaign.commerceProductCurationEnabled` | column |

Plus the back-relations that pointed at the two removed models
(`Brand.experienceProductLinks`, `Brand.lessonProductLinks`,
`Experience.shopLinks`, `Lesson.productLinks`, and the two
`commerceClickAttributions` reverse relations).

### Code

- **Creator attach** is now fully canonical: it writes `CampaignLessonProduct`
  only. The legacy creator picker's live-Shopify branch is gone, and
  `src/lib/lesson-product-links.ts` is reduced to canonical helpers.
  `upsertCampaignLessonProductScope` / `deactivateCampaignLessonProduct` key on
  `@@unique([campaignId, lessonId, brandCommerceProductId])` and no longer read
  or write the bridge. The creator route segment is
  `[campaignLessonProductId]`, not `[productLinkId]`.
- **Public lesson render and click** are now canonical: the query root is
  `CampaignLessonProduct`.
- **Every `ExperienceProductLink` read** is gone, along with the
  `EXPERIENCE_SHOP` click surface, the public live-Shopify fallback, and
  `src/lib/product-link-compatibility.ts` (deleted).
- **Every reader of `commerceProductCurationEnabled`** is gone — all five
  authorization sites — and with them the whole LEGACY/CURATED mode concept.
- **`shop/redact`** no longer scrubs `sourceShopDomain` on the two removed
  tables. See [Redaction coverage](#redaction-coverage) for why nothing is lost.

## The canonical data flow

```
Brand
  -> CommerceConnection            (one per connected store; provider-neutral)
    -> ConnectedCommerceProduct    (mirrored merchant catalog; sync-owned)
      -> BrandCommerceProduct      (brand curation: visibility, eligibility, overrides)
        -> CampaignCommerceProduct (campaign-scoped catalog assignment)
        -> CampaignLessonProduct   (campaign-scoped LESSON attachment)
```

`CampaignLessonProduct` is now **the** canonical lesson product attachment and
the only one. It carries no display data of its own: title, image, price,
currency and the outbound URL all derive from
`BrandCommerceProduct -> ConnectedCommerceProduct`, i.e. from provider-verified
catalog data that a sync owns and refreshes. That is the whole point — a snapshot
row could go stale, or be wrong on the day it was typed, and nothing would ever
correct it.

`@@unique([campaignId, lessonId, brandCommerceProductId])` is the reversible
lifecycle key. Attach and detach toggle `isActive` on the same row, so a
duplicate active attachment is structurally impossible and detach/reattach
preserves the row identity that attribution is keyed to.

Both composite foreign keys on `CampaignLessonProduct` include `brandId`, so
Postgres itself rejects a cross-brand attachment even if a caller bypasses the
application service.

## Public visibility rules

`isPublicCampaignScopedContentVisible` (`src/lib/campaign-context.ts`) is now the
single decision point, and it fails closed:

- **A campaign entry** sees a scope only when `scope.campaignId` equals the
  campaign the server independently resolved and validated against that
  Experience. Campaign A's entry therefore never renders Campaign B's product on
  a co-sponsored Experience.
- **A direct (non-campaign) entry** sees the **union** of every active,
  currently-linked campaign scope. This is deliberate: a direct visitor should
  still see the products on the page, and unioning avoids fabricating
  acquisition attribution that does not exist. The click still records
  `productCampaignId` (the product's authorization context) with
  `entryCampaignId = null`.
- **An inactive scope row is an explicit revocation**, never a downgrade to
  global visibility.
- **There is no global fallback.** The `scope` parameter is non-nullable and the
  old `!scope -> visible` branch is deleted. Previously, a product whose scoping
  row was missing became visible to *everyone* — the failure mode was
  fail-**open**, on the exact code path that decides cross-brand exposure.
- **Campaign ownership is now required and immutable.** The Phase 11.1
  migration fails closed when a legacy `Campaign.brandId IS NULL` row remains;
  malformed historical input is still denied defensively by public resolvers.

## The storefront-availability fix

**The original bug.** Shopify's `Product.onlineStoreUrl` can be `null` when a
product is not published to the Online Store sales channel. The original Shopify
normalizer collapsed that signal:

```ts
productUrl: product.onlineStoreUrl || `https://<shop>/products/<handle>`
```

The fallback **fabricates** a URL that 404s, and the sync then persisted it with
`isAvailable: true` — because `isAvailable` encodes Shopify `status === ACTIVE`,
which is orthogonal to publication. Public visitors were sent to 404 pages.

**Why URL validation alone could not catch it.** A synthesized URL uses the
brand's expected shop domain, so it is structurally valid even when the product
is unpublished. Conversely, Shopify may return a primary custom-domain URL for
a real storefront. The click route pins synthesized URLs to the connection host
and accepts a custom domain only when sanitized server metadata records that
Shopify supplied that exact URL; neither condition is publication evidence.

**Phase 8.2 correction.** `onlineStoreUrl` is navigation data, not sufficient
publication evidence: Shopify returns it as `null` for every product on a
password-protected development store, even when a product is published to the
Online Store. The persisted `ConnectedCommerceProduct.hasPublicStorefrontUrl`
therefore records the provider-confirmed Online Store publication fact from a
complete, separately paginated Shopify `products(query:
"published_status:published")` scan. The normal catalog query still uses
Shopify's actual URL when available, otherwise its canonical shop-domain and
handle URL; the fallback URL is never evidence by itself.

The publication scan is a prerequisite for a persisted Shopify catalog sync.
If it fails, loops, lacks a cursor, exceeds its bounds, or is cancelled, the
run fails before product writes. This preserves prior trustworthy publication
facts instead of mass-clearing them from an incomplete set. Both the render
path and click/redirect path require this column and `isAvailable` to be true.

The column name remains intentionally unchanged to avoid an unnecessary
migration. Its canonical meaning is now "provider confirmed this product is
published/usable on the merchant's Online Store", not merely "provider
returned a non-null URL". It remains deliberately separate from
`isAvailable`; neither may be derived from or substituted for the other.

The default is `false`, which is why the resync at the top of this document is
mandatory.

## The `commerceProductCurationEnabled` removal

This column was `BOOLEAN NOT NULL DEFAULT false`, added by
`20260807120000_add_campaign_commerce_product_curation`, and **never backfilled**.

That is a landmine, not a feature switch. Every campaign that existed before the
column was added read `false`. Any authorization site that gated on it would
therefore have denied curated commerce for **every pre-existing campaign**, and
the failure would have looked like "curation just doesn't work" rather than
"a boolean defaulted wrong". Phase 8 Step 5 removed all five readers, making
curation unconditional; Step 6 dropped the column.

Dropping it is irreversible in a specific way worth stating plainly: re-adding
the column re-defaults **every** campaign to `false`, so the per-campaign choice
is unrecoverable from the database once dropped. Informational query (4) in the
migration header exports it first if anyone wants the record.

## The migration and its fail-closed preflight

`prisma/migrations/20260808130000_remove_legacy_product_link_snapshots/migration.sql`.

Six dropped objects: four `DROP COLUMN`, two `DROP TABLE`. No `DELETE`, no
`TRUNCATE`, no `UPDATE`, no `ALTER COLUMN`, no `CASCADE`. `ALTER TABLE ... DROP
COLUMN` removes a column, never a tuple, so **no row is deleted from any
surviving table** — `Campaign`, `CampaignLessonProduct`,
`CommerceClickAttribution`, `Brand`, `Experience`, `Course`, `Lesson`, `User`,
`QRCode`, `QRCodeBatch`, `CampaignUnlock`, `PointTransaction`,
`UserPointAccount`, `ShopifyRewardRedemption`, `BrandRewardOffer`,
`CommerceConnection`, `ConnectedCommerceProduct`, `BrandCommerceProduct`,
`CampaignCommerceProduct`, `CommerceOrder`, `CommerceOrderLineItem` and
`CommerceOrderEvent` all keep every row they had.

`DROP TABLE` is plain, never `CASCADE`. If a dependency this migration did not
anticipate still exists, the deploy must **fail loudly and name it** rather than
silently dropping it as collateral.

### Three preflight gates, all before any destructive statement

1. `ExperienceProductLink` contains any row → abort.
2. `LessonProductLink` contains any row → abort.
3. Any **active** `CampaignLessonProduct` whose canonical chain is broken or
   cross-brand → abort. Specifically:
   `brandCommerceProductId` must resolve to a `BrandCommerceProduct`, which must
   resolve to a `ConnectedCommerceProduct`, and **both** must have `brandId`
   equal to the attachment's `brandId`.

Gates 1 and 2 deliberately do **not** delete the rows they find. Unexpected rows
mean the operator's assumption about production was wrong, and the correct
response to that is a loud non-destructive abort, not silent data destruction
inside a schema migration.

Gate 3 is the load-bearing one: after the bridge column is gone, the canonical
chain is the *only* way to resolve an attachment, so it must be valid first.

### The gate that would have been wrong

A prior audit proposed gating on
`isActive = true AND legacyLessonProductLinkId IS NULL`, reasoning from the
pre-Phase-8 invariant "active implies bridge non-null". **That check is
backwards now and would abort the deploy on legitimately correct data**, for two
independent reasons:

1. Step 2 stopped writing the bridge, so every canonically-created row is active
   with a `NULL` bridge. That is the new correct state.
2. The operator's deletion of all `LessonProductLink` rows fires the pre-existing
   `ON DELETE SET NULL` FK, nulling the bridge on any surviving attachment that
   pointed at them.

A `NULL` bridge on an active row is expected and fine. The column is provably
unread by code and is dropped, not validated. This reasoning is recorded in the
migration header itself and asserted by
`tests/legacy-product-link-removal.test.ts` so nobody "fixes" the gate later.

### Accepted evidence degradation

`CommerceClickAttribution` rows whose *only* structured product identity was
`lessonProductLinkId` or `experienceProductLinkId` keep `destinationUrl` and
`destinationHost` — the click itself remains provable — but no longer resolve to
a product row. Informational query (5) in the migration header quantifies this
population **before** deploying, so it is a recorded, conscious decision rather
than a discovery. Every click minted from Phase 8 onward carries
`campaignLessonProductId` and/or `brandCommerceProductId` instead.

## Redaction coverage

`shop/redact` previously ran two `updateMany` calls nulling `sourceShopDomain` on
`ExperienceProductLink` and `LessonProductLink`. Those are removed because the
tables are gone.

**No coverage is lost.** Those two statements only ever nulled a shop *domain
string* on snapshot rows. The canonical chain needs no equivalent field scrub:
`ConnectedCommerceProduct`, `BrandCommerceProduct` and `CampaignLessonProduct`
all cascade (`ON DELETE CASCADE`) from `CommerceConnection`, which this webhook
already deletes outright. Their rows are removed wholesale rather than
field-scrubbed, which is strictly stronger erasure than nulling one column.

Two pre-existing observations, recorded here rather than acted on (this was a
destructive-migration change, not a webhook expansion):

- Phase 14 replaced the former best-effort delete with strict
  `deleteShopifyCommerceConnectionByShopDomain`. It still runs *after* the
  historical scrub commits, but a deletion failure now returns a sanitized
  retryable non-2xx response so Shopify redelivers; an already-deleted row is
  idempotently successful.
- `CommerceClickAttribution.destinationHost` / `destinationUrl` embed the shop
  domain, and the attribution row survives connection deletion by design
  (`SetNull`, because a click is historical evidence). No redaction step scrubs
  them. This gap is **independent** of the removed legacy scrubs — those never
  covered attribution rows either — and is pre-existing since Phase 6. Per
  `docs/shopify-data-inventory.md`, a shop domain is not treated as personal
  data, so this is a documentation/consistency question rather than a compliance
  break, but it should be decided explicitly rather than inherited.

## Remaining debt — explicitly NOT done in Phase 8

### `Brand.shopify*` compatibility columns → deferred to Phase 9

All **16** `Brand.shopify*` columns survive Phase 8 untouched:

`shopifyShopDomain`, `shopifyAdminAccessTokenEncrypted`, `shopifyInstalledAt`,
`shopifyDisconnectedAt`, `shopifyUninstalledAt`, `shopifyConnectionStatus`,
`shopifyLastProductSyncAt`, `shopifyCurrencyCode`,
`shopifyAccessTokenExpiresAt`, `shopifyRefreshTokenEncrypted`,
`shopifyRefreshTokenExpiresAt`, `shopifyGrantedScopes`, `shopifyClientId`,
`shopifyTokenRefreshLockedUntil`, `shopifyTokenRefreshLockId`,
`shopifyAuthMode`.

They duplicate state that `CommerceConnection` / `CommerceConnectionSecret` now
also hold, and the dual-write between them is real, live compatibility debt.
Retiring it is a **source-of-truth cutover** — deciding which table wins for
OAuth, token refresh, and connection status, then migrating every reader — which
is a different kind of risk from deleting provably-unread product snapshots. It
is deferred to a future **Phase 9** and must not be smuggled into a product
change.

### Reward-provider-specific debt → deferred to an independent later phase

`BrandRewardOfferProduct.shopifyProductGid` (provider-shaped, `NOT NULL`, part of
`@@unique([offerId, shopifyProductGid])`) and the whole
`ShopifyRewardRedemption` model remain Shopify-specific rather than
provider-neutral.

This is deliberately **not** Phase 8's problem. It is the money/points path: it
touches `PointTransaction`, `UserPointAccount`, discount-code issuance, and
redemption reconciliation. Provider-neutralizing it requires its own phase with
its own reconciliation and refund-safety review, independent of the product
catalog. Phase 8 does not read, write, or migrate any of it — the removal
migration does not reference those tables at all.

### Also not done

- No change to `SHOPIFY_SCOPES` / `REQUIRED_SCOPES`, `shopify.app.toml`, or
  `shopify.app.custom.toml`.
- No change to Phase 7's order normalization
  (`CommerceOrder` / `CommerceOrderLineItem` / `CommerceOrderEvent`), which
  remains not-live for the reasons in
  `docs/commerce/phase-7-order-normalization-summary.md`.
- No purchase-based points, commissions, or payouts.
- No backfill of `hasPublicStorefrontUrl` in SQL. It is repopulated only by a
  product sync from the provider, which is the only source that knows the
  answer.
- `CommerceConnectionSecret` is not redesigned.
- No recovery path for the dropped snapshot data. There is deliberately no down
  migration.

## Verification

- `tests/legacy-product-link-removal.test.ts` — the primary regression guard.
  Asserts the migration's exact drop set, that all three `RAISE EXCEPTION`
  preflight gates precede every destructive statement, that no
  `DELETE`/`TRUNCATE`/`UPDATE`/`CASCADE` exists in executable SQL, that no
  `Brand.shopify*` column or KEEP-list table appears in any drop statement, and
  that the schema no longer declares the legacy models, the bridge, or the
  curation flag while still declaring all 16 `Brand.shopify*` columns and every
  KEEP-list model.
- `tests/campaign-lesson-product-schema.test.ts` — the Phase 5 assertions that
  the bridge EXISTS are **inverted**, not deleted, so re-adding the bridge fails
  the suite.
- `tests/campaign-commerce-product-schema.test.ts` — same inversion for
  `commerceProductCurationEnabled`.
- `tests/integration-coverage.test.ts` — `shop/redact` coverage updated to the
  new statement set; no other webhook assertion weakened.
