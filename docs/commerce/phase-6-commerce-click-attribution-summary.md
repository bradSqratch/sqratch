# Phase 6 — Commerce Click Attribution

## Click attribution ≠ purchase attribution ≠ buyer identity

Read this section first. `CommerceClickAttribution` records that a specific
visitor was redirected, at a specific time, with separately recorded trusted
entry/acquisition and product-authorization campaign facts, to a specific
merchant URL. It does **not** record, imply, or prove
that a purchase happened, which order it corresponds to, or who the buyer
was. Nothing downstream of Phase 6 should treat a click row as a sale, a
conversion, or evidence of identity beyond "this visitor was sent here."

## Provider transport status

> Phase 6 implements the attribution foundation — an opaque, hash-stored,
> campaign-scoped click token, a server-side click-creation-and-redirect
> path, and a code-side seam (`CommerceClickAttribution.consumedAt` /
> `consumedByOrderRef`) for a future order match. Phase 6 does not, and must
> not claim to, provide live order attribution. SQRATCH's Shopify app
> currently holds only `read_products, read_discounts, write_discounts`,
> subscribes to no order webhook, and ships no storefront extension of any
> kind. Until a theme app extension or web pixel, a `read_orders` scope
> grant, and an `orders/create` webhook subscription all exist, a click
> token minted by Phase 6 can be correlated with an order only by weak
> heuristics (timing, product, shop domain), never by a carried identifier.

Do not soften, summarize away, or omit the paragraph above in any downstream
document, PR description, or product communication about this phase.

## Shopify limitations

The transport audit that motivated the paragraph above found, as of this
phase:

- No `read_orders` (or any order-read) scope granted or requested.
- No `orders/create` (or any order-lifecycle) webhook subscription.
- No `extensions/` directory in this app: no theme app extension, no
  checkout UI extension, no web pixel.
- In principle, several mechanisms exist that *could* carry an attribution
  token into an order — a cart permalink parameter, a theme/cart attribute,
  a web pixel event, a checkout UI extension reading the URL — but **none of
  them are wired up in this app today**. Phase 6 does not add any of them.

Given that, `?ref=<token>` is appended to the outbound merchant URL as a
harmless, currently-inert, forward-compatible seam. No code in this app
reads it back. It exists so that a future phase adding one of the
mechanisms above has somewhere to look, without requiring a second
migration of the click-creation path.

## Privacy

`CommerceClickAttribution` stores the following visitor-identifying or
visitor-adjacent fields:

- `ipHash` — a peppered HMAC-SHA-256 of the request IP (`hashClickToken`'s
  sibling, domain-separated so the two hash spaces can never collide). The
  raw IP address is never stored or logged.
- `userAgent` — truncated to 512 characters.
- `userId` — the resolved internal SQRATCH user id, when the visitor is
  logged in; `null` for anonymous visitors.

Referrers are deliberately **not** persisted for new click rows: they commonly
contain opaque tokens, email addresses, and query values that are unnecessary
for click evidence.

**Retention.** Every row carries `expiresAt = createdAt + 30 days`. No sweep
job exists yet to act on that field — see the recommendation below.

**GDPR redaction recommendation (not implemented in Phase 6).** The core
implementation agent's recommendation for a later phase:

1. Add a SQRATCH-side account-erasure hook that nulls `ipHash`, `userAgent`,
   and `userId` on a user's `CommerceClickAttribution` rows while
   preserving the row itself (the row's non-PII fields — destination,
   experience, brand, campaign, timestamps — remain useful attribution
   history even after erasure).
2. Note that the existing Shopify `shop/redact` webhook's cascade already
   nulls provider-linked foreign keys (`connectedProductId`,
   `commerceConnectionId`, etc.) via `ON DELETE SET NULL` when a connection
   is redacted; that mechanism is unrelated to and does not need to change
   for SQRATCH-side user erasure.
3. Add a future retention sweep job that nulls PII fields (not the row) on
   rows past `expiresAt`.

None of the three items above is implemented in Phase 6. They are a
documented recommendation for later work, not a claim of current behavior.

## Token lifecycle

1. **Generation.** `generateClickToken()` produces 32 random bytes
   (256 bits), base64url-encoded to a 43-character, URL-safe string
   (`src/lib/commerce/click-token.ts`).
2. **Hash-only storage.** The plaintext token is never persisted anywhere —
   not in the database, not in a log line. Only `hashClickToken(token)` —
   HMAC-SHA-256 keyed by the `COMMERCE_CLICK_TOKEN_PEPPER` environment
   variable over a versioned, domain-separated input
   (`sqratch-commerce-click:v1:<token>`) — is stored, in
   `CommerceClickAttribution.tokenHash` (`@unique`). This mirrors the
   existing peppered-HMAC pattern in
   `src/lib/auth/email-verification-crypto.ts`; it is not a new crypto
   scheme.
3. **Non-secret triage prefix.** `tokenPrefix` stores the first 8 characters
   (48 bits) of the token for operator support triage only — far too short
   to reconstruct the remaining 208 bits.
4. **Required environment variable.** `COMMERCE_CLICK_TOKEN_PEPPER` must be
   set before this table is written to. The token module fails closed
   (throws) when it is absent; `handleCommerceClick` catches that throw and
   still redirects, without minting a row (see Fail-open design below). This
   variable has been added to `docs/env-vars.md`.
5. **Outbound append.** The plaintext token is appended to the validated
   destination URL as `?ref=<token>` — never as a path segment, never
   logged. An existing `ref` parameter on the merchant's own URL is left
   untouched rather than overwritten.
6. **Currently unconsumed.** No code path in Phase 6 looks up a token by
   hash. `handleCommerceClick` only ever calls
   `prisma.commerceClickAttribution.create(...)`; there is no
   `.findUnique`/`.findFirst` against this table anywhere in this phase's
   code. Redeeming a token against an order is Phase 7 territory.

## Multi-campaign behavior

Campaign context resolution reuses Phase 5's
`resolveValidatedPublicCampaignContext` (via
`src/lib/experience-access.ts`'s `resolvePublicCampaignId`) **verbatim** —
no second, divergent resolver was written for the click path. The same 0/1/2+
eligible-campaign rule applies: a visitor's stored, session-backed campaign
is trusted only when it is genuinely among the Experience's eligible
campaigns; otherwise exactly one eligible campaign auto-resolves; otherwise
the context is ambiguous and resolves to `null`. It is never
`campaigns[0]`.

`entryCampaignId` and `productCampaignId` are deliberately never collapsed:

- `entryCampaignId` is trusted acquisition evidence: the campaign through
  which the visitor entered the Experience. Explicit direct Experience entry
  records `null`, even if a stale session once held a campaign.
- `productCampaignId` is product authorization evidence: the campaign-scoped
  attachment that made this particular product available. It is `null` for a
  generic brand storefront product.
- A direct Experience click on a Campaign A-scoped product therefore records
  `entryCampaignId = null` and `productCampaignId = Campaign A`; it must never
  manufacture Campaign A acquisition credit.

`entryCampaignContextResolved` (a `Boolean`, default `false`) records whether
the trusted entry flow was campaign scoped. It is deliberately separate from
both nullable ids so direct/unscoped entry remains explicit in historical
evidence.

A campaign-scoped `LessonProductLink` (via an active `CampaignLessonProduct`
row) is clickable only inside its own campaign's resolved context, exactly
matching what the public lesson-products GET route already renders; an
unscoped link is unaffected by campaign context.

## The known coverage gap

Curated campaign-catalog products — rows reached through
`BrandCommerceProduct` / `ConnectedCommerceProduct` on the Experience shop,
**not** through a `LessonProductLink` or `ExperienceProductLink` row — carry
no internal link id (`productLinkId: null`, `source: "CAMPAIGN"` in the
public shop route's response). Neither click route accepts anything but an
internal `ExperienceProductLink.id` / `LessonProductLink.id`, so these items
have no click hop to use. `shop-client.tsx` still opens `product.productUrl`
directly for them, exactly as before Phase 6, using `productLinkId` as the
discriminator between a direct-link item (routed through the click hop) and
a curated-catalog item (opened raw). This is a stated Phase 6 boundary, not
a hidden bug — extending click attribution to curated-catalog items is
future work.

Every item rendered by `lesson-client.tsx` comes from `LessonProductLink`
(curated Lesson attachments write a `LessonProductLink` snapshot row per
Phase 5's `CampaignLessonProduct` bridge), so every lesson-product item has a
link id and is routed through the click hop; there is no equivalent gap on
that surface.

## Fail-open design

Everything inside `handleCommerceClick`'s attribution-minting step — token
generation, peppered hashing, the optional catalog lookup, the session
lookup, and the database insert — can fail for reasons unrelated to the
visitor: a database outage, a missing `COMMERCE_CLICK_TOKEN_PEPPER`, a
constraint surprise. None of those failures block the redirect. The route
logs a sanitized error (the exception's name only — never the error object,
which can carry query text or parameter values) and redirects anyway, to the
already-validated destination, with no token appended.

This is deliberate: attribution is evidence collection, not an availability
dependency on the commerce path. Losing one attribution row is a reporting
gap; blocking a redirect over it would turn a revenue-path click into an
outage. The one thing that is **not** fail-open is destination validation —
a URL that fails the `http:`/`https:`-only scheme check is never redirected
to, regardless of attribution outcome.

## Migration

`prisma/migrations/20260807160000_add_commerce_click_attribution`

- **Preflight**: the migration file's header includes the exact preflight
  SQL confirming all four prerequisite migrations
  (`20260806120000_add_commerce_connection_abstraction`,
  `20260806140000_add_commerce_product_catalog`,
  `20260807120000_add_campaign_commerce_product_curation`,
  `20260807140000_add_campaign_lesson_product_scoping`) are applied and not
  rolled back, that their tables exist, that the composite unique key
  `Campaign_id_brandId_key` this migration's composite FK resolves against
  already exists, that the new table doesn't already exist from a partial
  manual application, and that `COMMERCE_CLICK_TOKEN_PEPPER` is configured
  in the deploy environment (checked for presence only, never printed).
- **Additive-only**: one new table (`CommerceClickAttribution`), its unique
  index, its non-unique indexes, and its foreign keys. No existing table,
  column, or index is altered, dropped, or backfilled.
- **Campaign integrity**: `entryCampaignId -> Campaign(id)` preserves entry
  evidence even when entry and product brands differ. The product-authorization
  relation retains the Phase 4 composite check:
  `(productCampaignId, brandId) -> Campaign(id, brandId)`. PostgreSQL rejects
  a cross-brand product authorization at the database level, while no campaign
  is invented for generic direct brand storefront products.
- **Cascade design**: every foreign key except `experienceId` is
  `ON DELETE SET NULL` — a click row is historical evidence and must survive
  the deletion of the brand, campaign, product, session, or other entity it
  referenced. `experienceId` is the one required column and cascades, since
  a click with no Experience surface is not a record worth keeping. Known
  limitation: deleting a product-authorization Campaign nulls its composite
  `productCampaignId`/`brandId` pair; its independent entry campaign evidence
  remains intact.
- **Rollback limitations**: there is no automatic rollback SQL. Once click
  rows exist, dropping the table destroys click evidence. Historical
  `shop_click` / `lesson_product_click` AnalyticsEvent rows are disposable
  client-fired telemetry: they are forgeable, carry no server-minted token,
  and do not record the validated campaign context or destination host.
  Nothing else in the schema depends on this table, so a rollback breaks no
  other feature — the click routes simply degrade to redirecting without
  minting, matching the same fail-open behavior a missing pepper already
  produces. Export or back up `CommerceClickAttribution` before any manual
  drop.

## Phase 7 boundary

Explicitly, Phase 6 does **not** implement:

- Order matching or reconciliation of any kind.
- Points awards (no file in the click path imports or calls any
  points-ledger function — verified by source inspection as part of this
  phase's tests).
- Commissions or payouts (same verification, no commission/payout-related
  identifiers anywhere in the click path).
- Purchase identity verification, or any claim about who bought what.

`CommerceClickAttribution.consumedAt` and `.consumedByOrderRef` exist only
as schema — two nullable columns, unreferenced by any Phase 6 runtime code
path — as a forward seam for a future phase to use once an actual order
signal (a webhook, a scope grant, an extension) exists to consume them
against.
