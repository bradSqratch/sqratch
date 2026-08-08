# Phase 5 — Multi-Campaign Product Links and Campaign-Context Resolution

## Scope

Phase 5 makes lesson product attachments campaign-scoped so that a Lesson on
an Experience co-sponsored by two or more campaigns can carry products
authorized by different campaigns without one context leaking into another,
publicly or in the creator picker. It also closes an audit-discovered class
of bug in how "which campaign is this?" was decided, on both the creator and
public sides.

## Old behavior (found and fixed by this phase's audit)

**Creator picker.** The lesson product management context used to expose a
single `primaryBrand` — "the first connected brand" reachable from the
Lesson's Experience through a linked campaign. On an Experience co-sponsored
by two brands, whichever campaign's `CampaignExperience.sortOrder` sorted
first silently became "the" brand a creator could attach products against.
`sortOrder` is brand-writable, so a co-sponsoring brand could self-elect as
primary by writing an extreme value.

**Public side (more severe).** The equivalent pattern —
`campaigns[0]` — was read directly in five or more server locations across
the public routes and libraries (the public shop route's fallback catalog,
the public lesson-products route's display brand, the progress route's
session-campaign stamp, analytics attribution, and `public-experience.ts`'s
primary campaign/brand resolution). Three concrete vectors followed from it:

1. **`CampaignExperience.sortOrder` escalation.** Because `sortOrder` is
   brand-writable and had no enforced bound or secondary tiebreak, a
   co-sponsoring brand could write a sufficiently extreme value to make its
   own campaign sort first on a shared Experience, hijacking which sponsor's
   catalog, shop domain, and attribution every visitor saw — regardless of
   which campaign the visitor actually arrived through.
2. **Public-side `campaigns[0]` reads.** Even absent deliberate manipulation,
   any Experience with two or more eligible campaigns and no trusted
   per-visitor signal resolved to an arbitrary "first" sponsor rather than
   failing closed.
3. **`UserSession.campaignId` clobbering in the lesson-progress route.** The
   progress route's session upsert wrote any non-null `campaignId` over
   whatever was already stored on the visitor's session, on every progress
   ping. Since its own campaign resolution used the same `campaigns[0]`-style
   guess, a routine "mark lesson complete" call could silently overwrite the
   visitor's real, cookie-backed, QR-stamped campaign context with a guessed
   one.

All three are fixed in this phase (see **Campaign context** below).

## New multi-campaign behavior

**0 / 1 / 2+ eligible-context rule**, applied identically wherever a campaign
context must be resolved (creator attach, public catalog, public lesson
products, progress, analytics):

- **Zero** eligible (brand-owning) campaigns: no context to resolve —
  free-form/brandless behavior, unchanged from pre-Phase-4.
- **Exactly one** eligible campaign: it auto-resolves. This is the only
  permitted inference, because it is unambiguous.
- **Two or more**: an explicit selection is required. On the creator side
  this is `selection_required`, an explicit API state carrying the full
  ordered list. On the public side, absent a trusted stored signal, the
  resolved context is `null` and every ambiguity-sensitive read fails
  closed.

An explicitly requested campaign id is **always validated** against the
eligible set, on every path, including the single-context case (the old
curation resolver returned its `legacy` result before ever looking at a
requested id, so a client-supplied id on a legacy-only Experience was
silently ignored — now every id is checked, and a mismatch is
`invalid_campaign`, never a silent fallback).

**Unified curated + legacy selector — no cross-context ratchet.** A curated
campaign's presence on an Experience no longer makes a legacy sibling
unselectable, and vice versa. Every eligible context is offered together.
This is safe because authorization is fully self-contained per context, not
per Experience:

- A **curated** context still has to satisfy the full strict Phase 4 chain
  (`commerceProductCurationEnabled`, an active `CampaignCommerceProduct`,
  `isCampaignEligible`, `isAvailable`, same-brand pinning) regardless of what
  a sibling campaign's mode is.
- A **legacy** context still has to satisfy `assertProductUrlMatchesBrandDomain`
  (below) regardless of what a sibling campaign's mode is.

Selecting a legacy sibling therefore grants no access to a curated sibling's
catalog, and cross-context isolation is enforced downstream by
campaign-scoped `CampaignLessonProduct` rows (rendering and scoping are
per-campaign), never by hiding one sibling from the selector.

**Mandatory scoping under ambiguity for legacy attaches.** A legacy attach
lets a creator supply a product URL verbatim, with no catalog id to derive a
`CampaignLessonProduct` scoping row from. With exactly one eligible context
that is harmless — an unscoped `LessonProductLink` renders under that one
context regardless. With two or more eligible contexts, an unscoped row
would render under **every** sibling campaign, which is a cross-campaign
leak for a link created today under one specific campaign's picker. The
creator routes therefore require, on a 2+-context Experience, that the URL
resolve to a `BrandCommerceProduct` in the selected brand's own synced
catalog (`findBrandCommerceProductIdForProductUrl`) before the attach is
allowed; otherwise the request is rejected with a 400 asking the creator to
sync the product first. On a single-context Experience the pre-Phase-5
unscoped behavior is preserved exactly.

## Schema: `CampaignLessonProduct`

| Field                       | Type       | Notes                                                                                       |
| ---------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `id`                          | `String`   | cuid primary key                                                                              |
| `brandId`                    | `String`   | cascades from `Brand`                                                                         |
| `campaignId`                 | `String`   | composite FK `(campaignId, brandId) -> Campaign(id, brandId)`                                 |
| `lessonId`                   | `String`   | cascades from `Lesson`                                                                        |
| `brandCommerceProductId`     | `String`   | composite FK `(brandCommerceProductId, brandId) -> BrandCommerceProduct(id, brandId)`         |
| `legacyLessonProductLinkId`  | `String?`  | unique; optional 1:1 bridge to the display snapshot; `ON DELETE SET NULL`                     |
| `isActive`                   | `Boolean`  | default `true`; reversible lifecycle flag, reused rather than deleted                          |
| `displayOrder`                | `Int`      | default `0`                                                                                    |
| `deactivatedAt`               | `DateTime?`| set when `isActive` flips to `false`                                                          |
| `createdAt` / `updatedAt`     | `DateTime` | standard                                                                                       |

`@@unique([campaignId, lessonId, brandCommerceProductId])` gives one lifecycle
row per (campaign, lesson, product) tuple — reactivation reuses history
instead of creating a duplicate, and the same product can be attached under
two different campaigns as two structurally independent rows.

**Composite-FK cross-brand-rejection pattern (reused from Phase 4).** Both
`(campaignId, brandId) -> Campaign(id, brandId)` and
`(brandCommerceProductId, brandId) -> BrandCommerceProduct(id, brandId)`
require the referenced row to carry the *same* `brandId` as the attachment.
PostgreSQL itself rejects a cross-brand attachment even if a caller bypasses
the application service — no new unique index was needed on `Campaign` or
`BrandCommerceProduct`; both composite candidate keys already exist from
Phase 4's migration.

**`legacyLessonProductLinkId` bridge and its `SET NULL` reasoning.** A
`CampaignLessonProduct` carries no display fields of its own — title, image,
price, and URL live on the `LessonProductLink` snapshot it optionally binds
to. A creator can delete that snapshot through the existing DELETE route
independent of this table. Cascading the delete would destroy campaign-scoped
attribution history that cannot be re-derived (a `LessonProductLink` records
which product was attached, not which campaign authorized it, and on a
co-sponsored Experience that mapping isn't recoverable from `brandId` alone,
since two campaigns can share a brand). `SET NULL` instead only *detaches*
the row; the application layer (both the creator DELETE and PATCH-replace
routes) deactivates it in the same transaction as the snapshot delete/update,
so an active row never points at a null legacy link.

## Compatibility strategy

**Dual-read.** A `LessonProductLink` with no `CampaignLessonProduct`
counterpart is *unscoped* and renders unconditionally on the public lesson
products route, exactly as it always has — this is the correct reading for
every row that predates Phase 5. An existing but inactive scoping row is an
explicit revocation, not an unscoped fallback, and is hidden. An active scope
renders only when its campaign is still brand-owning and linked to the current
Experience. Campaign entry exposes only the trusted entry campaign's scope;
direct Experience entry exposes the deterministic union of every such active
scope. The lesson list and its outbound click route share this same predicate,
so a rendered product cannot fail solely because click authorization drifted.

**`ExperienceProductLink` was deliberately not touched.** It has no writer
anywhere in the codebase for either creation or update outside the
Shopify shop/redact webhook's `updateMany` (which only nulls PII fields on
GDPR redaction) — confirmed by inspection. It continues to render with
absolute precedence over the curated/legacy fallback catalog on the public
shop route, unchanged from before this phase and locked in by
`tests/public-experience-product-catalog.test.ts`.

**Why direct links keep absolute precedence.** `ExperienceProductLink` and a
current `LessonProductLink` represent a creator's or brand's explicit,
already-resolved choice; the campaign catalog fallback only exists to fill in
when no direct link exists. Phase 5 does not change that ordering anywhere.

## Campaign context: the exact validated-signal rule

`src/lib/campaign-context.ts` is the single, pure, dependency-free resolver
every public and creator surface now goes through:

- `buildEligibleCampaignContexts` — filters to brand-owning campaigns and
  orders them `sortOrder` ascending, then `campaignId` ascending as a
  code-level tiebreak that a lossy `ORDER BY` can never silently change.
- `resolveCampaignSelection` — the 0/1/N + explicit-request rule described
  above, used by the creator curation policy.
- `resolveValidatedPublicCampaignContext` — the public visitor rule:

  1. The visitor's stored `UserSession.campaignId` is trusted **only** when
     it is genuinely among the campaigns linked to the Experience being
     viewed.
  2. Otherwise, exactly one eligible campaign auto-resolves.
  3. Otherwise, `null` — never `eligibleCampaignIds[0]`.

`UserSession.campaignId` is cookie-backed (`sqr_session`, httpOnly) and is
stamped server-side only by `/api/public/scan` (QR scan) and
`/api/public/campaign/[slug]` (campaign landing) — never by a client-supplied
request parameter, and never inferred by any other route.

**The two supporting bug fixes:**

- **`sortOrder` bound.** `buildEligibleCampaignContexts`'s `campaignId`
  tiebreak is applied in code, not left to a database `ORDER BY`, so a
  brand writing an extreme `sortOrder` can no longer change which context a
  consumer resolves to when ambiguity — not a numeric ordering — is the
  correct outcome for two-or-more eligible campaigns.
- **Session-clobber fix.** The lesson-progress route's session upsert now
  passes `campaignId: null` whenever the visitor's session already has a
  stored campaign, leaving it untouched; it stamps a resolved campaign only
  when the session had none *and* the resolution is genuinely deterministic
  (single eligible campaign). The route is a progress-tracking endpoint, not
  a writer of the visitor's real campaign context.

## Creator UX

The lesson product panel no longer shows a "first connected brand" fallback.
When `curation.requiresCampaignSelection` is true, it renders an explicit
Campaign / Brand / Provider selector; it auto-selects when exactly one
eligible context exists. The resolved `campaignId` flows into both curated
(`catalogProductId` + `campaignId`) and legacy (`productUrl` + `campaignId`)
attach payloads whenever the Experience is ambiguous.

## Public UX and Phase 5.1 direct Experience entry

Campaign-scoped entry derives scoped content only from the visitor's trusted
entry campaign. It never selects a first campaign or brand. Direct
`ExperienceProductLink` rows remain global compatibility content.

Phase 5.1 adds an explicit direct/unscoped Experience-entry mode. A direct
`/x/<experience-slug>` entry cannot reuse a stale campaign session from an
earlier Campaign QR entry. In that mode, public commerce displays the
deterministic union of valid campaign-scoped products and distinct linked
brand storefront catalogs. Campaign-scoped entries preserve their individual
campaign identities; equivalent products from different campaigns are not
silently collapsed.

The public lesson-products route follows the same direct-union rule as the
Experience Shop: global/unscoped rows always render; Campaign A entry sees
only active A-scoped rows; Campaign B entry sees only active B-scoped rows;
and a direct root Experience entry sees all active scopes whose campaigns are
still linked to the Experience. Inactive or detached-from-the-Experience
scopes remain hidden. Direct lesson clicks retain `entryCampaignId = null`
and the scoped row's `productCampaignId`; campaign-entry clicks carry both as
that trusted campaign.

**Nested direct-deep-link limitation.** `/x/<experience-slug>` is the
server-owned direct-entry boundary and clears stale campaign context unless a
signed campaign handoff is present. A bare nested URL such as
`/x/<experience-slug>/lessons/<lessonId>` does not currently pass through
that boundary, because clearing context on every nested navigation would
break normal Campaign → Experience → Lesson navigation. Consequently, a
visitor who already carries a valid campaign session is treated as that
campaign when opening a nested link directly. This is documented rather than
papered over with a client-controlled parameter; resolving it requires a
broader server-owned entry-mode design.

## Migration

`prisma/migrations/20260807140000_add_campaign_lesson_product_scoping`

- **Preflight**: depends on
  `20260806120000_add_commerce_connection_abstraction`,
  `20260806140000_add_commerce_product_catalog`, and
  `20260807120000_add_campaign_commerce_product_curation` all being applied;
  the migration file's own header includes the exact preflight SQL to confirm
  this plus the two composite unique keys (`Campaign_id_brandId_key`,
  `BrandCommerceProduct_id_brandId_key`) the new composite FKs resolve
  against.
- **Additive-only**: one new table (`CampaignLessonProduct`), its indexes,
  its unique constraints, and its foreign keys. No existing table, column, or
  index is altered, dropped, or backfilled.
- **Rollback limitations**: there is no automatic rollback SQL. Once
  attachment rows exist, dropping the table destroys campaign-scoped
  attribution history that cannot be re-derived — a `LessonProductLink`
  records which product was attached, not which campaign authorized it. The
  `LessonProductLink` snapshot rows themselves are never at risk from such a
  rollback (the FK direction is `CampaignLessonProduct -> LessonProductLink`,
  `SET NULL`, never the reverse), so product *display* survives; only
  campaign-scoping metadata would be lost. Export/back up the table before
  any manual rollback.

## Rollback limitations / backfill strategy

**No backfill was performed.** Every pre-existing `LessonProductLink` row
remains permanently unscoped — rendering unconditionally under every
campaign on its Experience — unless a brand or creator re-attaches it
through the new flow. This is intentional, not a gap: forcing a migration
would require guessing which campaign historically authorized a row that
predates campaign scoping entirely, and a guess here is exactly the class of
bug this phase exists to eliminate elsewhere.

## Known limitations

1. **`ExperienceProductLink` was not canonicalized.** It has no writer for
   creation/update anywhere in the codebase (confirmed by inspection) and was
   intentionally left as-is; see Compatibility strategy above.
2. **No backfill of historical unscoped links** — see above; intentional.
3. **Legacy creator picker remains live-Shopify backed.** `GET
   /api/creator/lessons/[lessonId]/available-products` calls
   `fetchNormalizedShopifyProducts` for a legacy campaign. On a
   multi-campaign Experience, a chosen live product must also exist as a
   persisted `BrandCommerceProduct` before it can receive the mandatory
   `CampaignLessonProduct` scope; otherwise the attach route safely rejects
   it with the sync-first message. This preserves canonical same-brand
   integrity but is poor picker UX. It is intentionally deferred to the next
   canonical-commerce cleanup phase; this phase adds no further legacy path.

## Phase 6 boundary

Click attribution, opaque attribution tokens, and purchase evidence are
**not** part of Phase 5. `lesson_product_click` / `shop_click` analytics
events continue to record best-effort attribution exactly as before
(omitting `brandId`/`campaignId` when the visitor's context is ambiguous
rather than guessing); building a durable, tamper-resistant click/purchase
attribution model is explicitly Phase 6 scope.
