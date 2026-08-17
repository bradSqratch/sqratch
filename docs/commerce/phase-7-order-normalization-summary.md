# Phase 7 — Provider-Neutral Order Normalization

> **Superseded rollout status:** Phase 12 activates the prospective Shopify
> transport (`read_orders`, order/refund webhooks, and a Theme App Extension).
> The model and normalization semantics below remain the foundation; the
> "Not live" section immediately below, and every other historical statement
> that no order delivery exists, describe the pre-Phase-12 state and are
> **no longer current** — see
> `docs/commerce/phase-12-live-order-ingestion-and-conversion-attribution-summary.md`
> for what is actually live today.

## Not live at Phase 7. Superseded by Phase 12 — read that document for current status.

**Everything in this section describes Phase 7 as it stood before Phase 12.**
It is preserved verbatim below because the reasoning ("design and
fixture-test the normalization before requesting the scope") is still worth
recording, but treat every present-tense claim in it as **historical**, not
current.

Nothing in production wrote to `CommerceOrder`, `CommerceOrderLineItem`, or
`CommerceOrderEvent` at Phase 7, and nothing in production could. SQRATCH's
Shopify app held `read_products, read_discounts, write_discounts` — **not**
`read_orders`. Neither `shopify.app.toml` nor `shopify.app.custom.toml`
subscribed to any `orders/*` or `refunds/*` webhook topic. Shopify therefore
never sent an order payload to this app, and the three route handlers
(`src/app/api/shopify/webhooks/orders/create`, `.../orders/updated`,
`.../refunds/create`) could only be exercised by a fixture.

Phase 7 existed so this normalization was designed, reviewed, and
fixture-tested **before** any scope was requested. **Phase 12 has since
requested and uses `read_orders`, subscribed all three topics, and these
routes now receive live Shopify traffic** — do not describe Phase 7's
"not live" framing as still true.

## Models

### `CommerceOrder`

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (cuid) | |
| `connectionId` | `String` | required, `-> CommerceConnection` Cascade |
| `brandId` | `String` | required, `-> Brand` Cascade — **always** read from the resolved connection, never from a caller. See [Why brandId has no composite FK](#why-brandid-has-no-composite-fk). |
| `provider` | `CommerceProvider` | |
| `externalOrderId` | `String?` | nullable for redaction |
| `orderNumber` | `String?` | human-facing, not personal data |
| `currencyCode` | `String?` | never a guessed default |
| `minorUnitExponent` | `Int?` | the exponent actually used to convert every amount below |
| `subtotalMinor` / `discountsMinor` / `shippingMinor` / `taxMinor` / `totalMinor` | `BigInt?` | see [Money semantics](#money-semantics) |
| `totalRefundedMinor` | `BigInt` (default `0`) | **cumulative**, not incremental — see [Refunds](#refunds) |
| `netRevenueMinor` | `BigInt?` | derived, see below |
| `financialStatus` | `CommerceOrderFinancialStatus?` | |
| `fulfillmentStatus` | `CommerceOrderFulfillmentStatus?` | |
| `cancelledAt` / `cancelReason` | `DateTime?` / `String?` | |
| `providerCreatedAt` / `providerUpdatedAt` | `DateTime?` | `providerUpdatedAt` is the staleness ordering key |
| `attributionId` | `String? @unique` | optional 1:1 to `CommerceClickAttribution`, `SetNull` |

`@@unique([connectionId, externalOrderId])` — never a bare unique on
`externalOrderId`. Two different stores can mint the same provider order id;
the schema does not assume otherwise (same rule as
`ConnectedCommerceProduct.@@unique([connectionId, externalKey])`).

### `CommerceOrderLineItem`

| Field | Type | Notes |
|---|---|---|
| `orderId` | `String` | `-> CommerceOrder` Cascade — a line has no meaning without its order |
| `externalLineItemId` / `externalProductId` / `externalVariantId` | `String?` | |
| `connectedProductId` | `String?` | best-effort catalog resolution, `-> ConnectedCommerceProduct` **SetNull** |
| `title` / `sku` | `String?` | |
| `quantity` | `Int` (required) | the one required money-adjacent column; a line without a usable quantity is skipped, never defaulted to 1 |
| `unitPriceMinor` / `discountMinor` / `taxMinor` / `totalMinor` | `BigInt?` | signed — a discount or adjustment line can legitimately be negative |

Line items are replaced **wholesale** on every non-stale write (delete-then-insert
in the same transaction), not reconciled row by row: providers report the
complete line set on every order event, so a merge-by-id reconciliation would
silently retain lines the merchant has since removed.

### `CommerceOrderEvent`

The idempotency ledger. One row per delivery, including deliveries that
change no order (a `SKIPPED_DISCONNECTED` delivery is still evidence that the
event arrived).

| Field | Type | Notes |
|---|---|---|
| `providerEventId` | `String` | `X-Shopify-Webhook-Id`, or a synthesized `digest:<sha256>` fallback |
| `topic` | `String` | bound to the **route path**, never `x-shopify-topic` |
| `externalOrderRef` | `String?` | not a foreign key — an event can resolve to no order |
| `providerUpdatedAt` | `DateTime?` | copied from the payload for triage |
| `status` | `CommerceOrderEventStatus` | `RECEIVED \| PROCESSED \| SKIPPED_STALE \| SKIPPED_DISCONNECTED \| FAILED` |
| `payloadDigest` | `String` | SHA-256 hex of the raw, HMAC-verified body — the body itself is never stored |
| `failureSummary` | `String?` | a short classified tag, never a raw error message |
| `orderId` | `String?` | `-> CommerceOrder` **SetNull** — the ledger survives order deletion |

`@@unique([provider, providerEventId])` is the deduplication key.

### Why money is `BigInt` here, `Int` on `ConnectedCommerceProduct`

A single product **price** comfortably fits Postgres `INTEGER` (int4, max
2,147,483,647 minor units ≈ $21.4M at exponent 2), which is why the catalog
table uses `Int`. An order **total** carries no such guarantee: a wholesale
or B2B order, or any 0-exponent currency (JPY, KRW, VND, CLP), can exceed
int4 outright. Overflowing raises Postgres `22003` at write time and loses
the order. Every money column on the three Phase 7 tables is therefore
`BigInt`.

**Known limitation, stated rather than worked around**: the shared converter
`decimalStringToMinorUnits` (`src/lib/commerce/money.ts`) still enforces the
int4 range (`INT32_MIN`/`INT32_MAX`), because it was written for the `Int`
catalog columns. So although these **columns** accept a 64-bit value, the
current ingestion path rejects any single amount outside int4 with a typed
`OUT_OF_RANGE` result — nulling that one field, never failing the order. The
wider column type is precisely what makes widening that helper a code-only
change later, with no second migration.

### Why brandId has no composite FK

`CampaignCommerceProduct` and `CampaignLessonProduct` use a composite
`(campaignId, brandId) -> Campaign(id, brandId)` foreign key.
`CommerceClickAttribution` retains that check specifically for
`(productCampaignId, brandId)`, while `entryCampaignId` is a separate simple
foreign key because acquisition and product authorization can legitimately be
different campaign/brand contexts. There is **no** equivalent
`CommerceConnection(id, brandId)` unique key, and creating one would add a
unique index to a pre-existing table — which this migration deliberately
refuses to do (see the migration's own PREFLIGHT section). Cross-brand
integrity is instead enforced in
`src/lib/commerce/order-ingestion.ts`, which always reads `brandId` **from**
the resolved `CommerceConnection` row and never accepts it from a caller or a
webhook payload. A caller-supplied mismatch is reported on the outcome as
`brandIdOverriddenFromConnection: true` and is never persisted. If a
database-level guarantee is wanted later, it is a separate, deliberately
reviewed migration that adds `CommerceConnection_id_brandId_key` first.

## Provider adapter: the Shopify normalizer

`src/lib/commerce/providers/shopify-order-normalizer.ts` is a **pure**
function module — no I/O, no Prisma, no network, no clock — exporting
`normalizeShopifyOrderPayload`, `normalizeShopifyRefundPayload`,
`mapShopifyFinancialStatus`, `mapShopifyFulfillmentStatus`,
`readMoneyAmount`, `deriveCumulativeRefundMinor`,
`extractShopifyAttributionToken`, `computeShopifyPayloadDigest`, and the
`SHOPIFY_ORDER_PII_KEYS` deny-list.

### Dual money-shape handling

Shopify represents money either as a bare decimal string (`"19.99"` — the
long-standing REST shape for `total_price`, `subtotal_price`, `total_tax`,
`total_discounts`, and line-item `price`), or as a MoneyBag object
(`{ shop_money: { amount, currency_code }, presentment_money: {...} }` — the
`*_set` fields such as `total_shipping_price_set`, and increasingly the
primary shape in newer API versions). `readMoneyAmount` handles both, plus a
bare JSON number, and returns `null` for anything else. When a MoneyBag is
present, `shop_money` is preferred over `presentment_money`: `shop_money` is
denominated in the shop's own currency, which is what `order.currency` names
and therefore what `minorUnitExponent` is resolved from — mixing a
presentment amount with a shop currency code would produce a number that is
wrong by an exchange rate, silently.

Every conversion goes through `decimalStringToMinorUnits` (sign-aware) —
**never** `providerPriceStringToMinorUnits`, which rejects negatives by
design and would wrongly reject a refund, discount, or adjustment amount. A
conversion failure nulls that one field and never fails the order.

### PII deny-list, actively enforced

`SHOPIFY_ORDER_PII_KEYS` names the payload keys this module must never read:
`customer`, `billing_address`, `shipping_address`, `email`, `contact_email`,
`phone`, `customer_locale`, `browser_ip`, `client_details`. This is not a
passive claim — `tests/shopify-order-normalizer.test.ts` feeds
`normalizeShopifyOrderPayload` a fixture that carries a full `customer` block
(name, email, phone, address), a `billing_address`, a `shipping_address`, and
`client_details`, then asserts the *values* from that block (not merely the
key names) never appear anywhere in the serialized normalized output. The
output **type** itself has no field that could hold any of it — there is
nowhere to put an email, a name, or an address on `NormalizedOrderInput`.

## Money semantics

- Every amount is an integer count of minor units (`bigint`), converted from
  the provider's decimal string via `decimalStringToMinorUnits` /
  `getCurrencyExponent`.
- Refund amounts specifically use `decimalStringToMinorUnits` (sign-aware),
  never the price-only `providerPriceStringToMinorUnits` wrapper, which
  rejects negative values by design and exists for a domain (product prices)
  where negative is always invalid data.
- **Totals are never derived.** `totalMinor` is always the provider's own
  reported total, persisted verbatim. It is never computed by summing
  converted line items: `decimalStringToMinorUnits` **truncates**, not
  rounds, so a sum of per-line conversions can legitimately disagree with the
  provider's total by a few minor units — asserting equality there would
  reject perfectly valid orders. `netRevenueMinor` is the one derived column
  (`totalMinor - totalRefundedMinor`), computed at write time, null whenever
  `totalMinor` is null (an unknown total cannot produce a known net; `0`
  would falsely read as "this order earned nothing").

## Refunds

`totalRefundedMinor` is interpreted as the **cumulative** amount refunded
against the order as of the current event — the running total, not the delta
for one refund. This is deliberate and is the safer of the two designs:

- **Cumulative is idempotent by construction.** Replaying the same refund
  event, or applying a later refund event twice, writes the same value
  (assignment is idempotent; addition is not). Webhook transports guarantee
  at-least-once, never exactly-once, delivery — an incremental design would
  double-count a refund on any redelivery that slipped past the dedup gate
  (e.g. the same logical refund re-sent under a new delivery id).
- **Cumulative is self-healing under a missed event.** If refund #2's
  delivery is lost and refund #3's arrives, the cumulative total in #3 is
  still correct; an incremental design would silently understate the
  refunded amount forever.

### The `FULL` / `PARTIAL` completeness discriminator, and exactly why it exists

`NormalizedOrderInput.completeness` is `"FULL"` or `"PARTIAL"`:

- **`FULL`** — every field is authoritative, including its nulls. A null
  `cancelledAt` genuinely means "not cancelled" and **clears** a previously
  stored cancellation. Produced by a payload that carries the whole order
  (`orders/create`, `orders/updated`, or a `refunds/create` body that happens
  to embed its parent `order`).
- **`PARTIAL`** — a fragment. Only non-null fields are applied; every null
  **preserves** whatever is already stored. Produced by a bare
  `refunds/create` body, which describes a Refund resource, not the order
  itself.

Why this exists: a `refunds/create` payload's own `transactions[]` amount is
an **increment** for that one refund — reading it as the cumulative total
would either double-count on replay or require re-deriving the cumulative
figure by reading-then-adding to the stored value, which reintroduces exactly
the double-counting race cumulative semantics exist to eliminate. So
`normalizeShopifyRefundPayload`, for a bare fragment with no embedded order,
emits `totalRefundedMinor: null` (flagged `REFUND_CUMULATIVE_UNAVAILABLE`)
and otherwise leaves every other field null — `completeness: "PARTIAL"`
means the ingestion service preserves the order's title, currency, line
items, and every other field rather than nulling them out from a payload
that never claimed to describe them. Without the `FULL`/`PARTIAL`
distinction, a refund fragment would blank the order's currency, totals, and
statuses.

**Correction to an earlier framing worth stating precisely**: a bare
`refunds/create` delivery, on its own, updates *nothing about the refunded
amount* — only its timestamp (`providerUpdatedAt`, from the refund's
`processed_at`/`created_at`) reaches the stored order, via a `PARTIAL`
update. The cumulative refund figure legitimately lands only from an
`orders/updated` delivery for the same order (or from a `refunds/create`
variant that embeds its parent `order`, in which case the result is `FULL`
and the cumulative figure is derived exactly as it would be from a full
order payload). A rollout that subscribes to `refunds/create` but not
`orders/updated` would record refund timing without ever recording the
refunded amount — this is why both topics are listed as required in
[Shopify scope/webhook rollout requirement](#shopify-scopewebhook-rollout-requirement---not-done-in-phase-7)
below.

## Idempotency

`@@unique([provider, providerEventId])` on `CommerceOrderEvent` is the
deduplication key. Winning the `INSERT` against it is the claim on the
delivery; losing it (Prisma `P2002`) means another delivery of the same
provider event already claimed it — a successful no-op (`ALREADY_PROCESSED`),
never an error, never a second write to the order table.

**Synthesized-key fallback for fixture testing.** Shopify stamps every real
delivery with `X-Shopify-Webhook-Id`, reused across retries of one logical
event. A fixture-driven test (or a malformed/proxy-stripped delivery) has no
such header, so `resolveProviderEventId` falls back to a deterministic
`digest:<sha256 of the raw body>`. Two byte-identical deliveries still
deduplicate under the fallback. Stated trade-off: two genuinely distinct
events with byte-identical bodies would collide under the fallback and the
second would read `ALREADY_PROCESSED` — for an order payload, which always
carries an `updated_at`, byte-identical bodies mean identical state, so
collapsing them is correct rather than lossy.

**The `providerUpdatedAt` staleness gate.** An incoming event whose
`providerUpdatedAt` is not strictly newer than the stored value never
overwrites the row (`SKIPPED_STALE`). A brand-new external order id is never
stale regardless of its timestamp (`FIRST_SEEN`). A stored row with no
incoming timestamp to compare against is `UNORDERABLE` — skipped, not
guessed. An **equal** timestamp is treated as stale, not applied: it carries
no evidence of being newer, and applying it would let two same-timestamp
deliveries flap the row.

**The crash-between-claim-and-commit operational gap — stated, not hidden,
and self-healing as of Phase 12.**
The event claim (`CommerceOrderEvent` insert) is its own statement/transaction,
executed **before** the order-writing transaction, deliberately not inside
it — Postgres aborts an entire transaction on a failed statement, so "catch
P2002 and carry on" is not expressible if the claim were inside the same
transaction as the order write. The consequence: a process that dies between
winning the claim and committing the order transaction leaves a `RECEIVED`
event row with no order.

**Phase 7's original design point stopped here** and described the next
redelivery as reporting `ALREADY_PROCESSED` with no retry — that was a real
P1 (a retry landing in that window could be permanently lost, since Shopify
treats 200 as settled and stops retrying). **Phase 12 closed it.** The claim
now resolves to one of four explicit outcomes
(`src/lib/commerce/order-ingestion.ts`, `OrderEventClaim` /
`decideOrderEventClaim` / `resolveOrderEventClaim`):

- `CLAIMED` — no prior row; process it.
- `RECLAIMED` — the prior row is `FAILED` (any age), or `RECEIVED` past a
  60-second lease (`EVENT_CLAIM_LEASE_MS`); atomically taken over
  (compare-and-set on `id` + `status` + `receivedAt`, which also refreshes
  the lease so a genuinely live reclaimer doesn't immediately look stale to
  a third retry) and processed.
- `COMPLETED_DUPLICATE` — the prior row is terminal (`PROCESSED`,
  `SKIPPED_STALE`, or `SKIPPED_DISCONNECTED`); acknowledged `200`, not
  reprocessed.
- `IN_FLIGHT` — the prior row is `RECEIVED` and the lease has **not**
  expired: this is the exact "crashed between claim and commit" window.
  It is **not** treated as a duplicate. The webhook responds `500`, so
  Shopify redelivers, and by the time it does the lease has either
  completed normally (→ `COMPLETED_DUPLICATE`, `200`) or expired
  (→ `RECLAIMED`, reprocessed for real).

So a stuck `RECEIVED` row with no order now self-heals within roughly one
lease window of Shopify's own retry cadence, with no operator action
required in the common case.

Ops runbook note — the query below still finds rows that are unusually old
for a `RECEIVED`, `processedAt IS NULL` state, which is now a signal of a
genuinely abandoned or slow-to-retry delivery worth investigating (rather
than, as at Phase 7, every such row being a guaranteed permanent loss):

```sql
SELECT * FROM "CommerceOrderEvent"
WHERE status = 'RECEIVED' AND "processedAt" IS NULL AND "orderId" IS NULL
  AND "receivedAt" < now() - interval '10 minutes';
```

A row already past several retry cycles without reclaiming warrants
investigation (e.g. a repeatedly-crashing worker, or Shopify's retries
having stopped for an unrelated reason) rather than an operational
assumption that it is unrecoverable.

## Privacy

Zero customer PII fields, by construction — not merely by convention. There
is no email, name, phone, address, customer id, or IP column on any of the
three Phase 7 tables, and the Shopify normalizer actively skips the
`customer` / `billing_address` / `shipping_address` / `email` /
`contact_email` / `phone` / `customer_locale` / `browser_ip` /
`client_details` payload keys (`SHOPIFY_ORDER_PII_KEYS`). `payloadDigest` is
a one-way SHA-256 hex digest of the raw HMAC-verified body — it proves which
bytes were processed without storing any of them.

This is **stricter** than what a real order sync would eventually need — a
production commerce integration typically wants at least a hashed customer
identifier for deduplication and support. That is a deliberate Phase 7
boundary, not an oversight: buyer identity verification is explicitly Phase
8 territory, to be designed and reviewed on its own, with its own privacy
review, rather than folded into order normalization by default.

## Attribution evidence rules

Restating Phase 6's framing, because it still governs everything below it:
**a click is not a purchase, and a purchase is not proof of identity.**
`CommerceClickAttribution` records that a specific visitor was redirected, at
a specific time, to a specific merchant URL. Its two campaign fields preserve
different evidence: `entryCampaignId` is acquisition/entry context and
`productCampaignId` is the server-derived campaign authorization of the
clicked product. Phase 7 preserves that click row through the optional 1:1
relation; it neither collapses the two fields nor invents campaign evidence
for an unattributed order.

An order is associated with a `CommerceClickAttribution` **only** when the
payload carries a token that hash-matches an existing, unexpired, unconsumed
row. Never inferred from timing, product overlap, session, IP, or "the only
recent click for this brand." An unattributed order is the correct and
expected outcome, not a failure. The claim itself is a conditional update
(`updateMany({ where: { id, consumedAt: null }, ... })`), so of two
concurrent claimants for the same click exactly one wins; the loser stays
unattributed rather than stealing a click another order is entitled to.
`CommerceOrder.attributionId @unique` is the second, database-level guard
against two orders ever holding one click.

**Phase 6's finding stands, restated for Phase 7's context: in production
today this logic essentially never fires.** Nothing in Shopify's current
storefront-to-order pipeline carries the `?ref=<token>` query parameter
forward into an order payload — the token is appended to the outbound
merchant URL, and no theme app extension, checkout UI extension, or web pixel
ships with this app to capture it into `note_attributes`, `landing_site`, or
any other order field. `extractShopifyAttributionToken` checks all three of
those locations, and the ingestion service performs a real, hash-matched,
race-safe lookup against `CommerceClickAttribution` — this logic exists so
that it is **correct once, and if,** that transport gap is ever closed by a
future phase, not because it is live now.

## Shopify scope/webhook rollout requirement — NOT done in Phase 7

This section is load-bearing and must not be softened in any future edit.
**None** of the following was done in Phase 7, and the three new routes are
inert — reachable only by fixtures — until every one of these is completed,
in this rough order:

1. Add `read_orders` to `SHOPIFY_SCOPES` in `src/lib/shopify.ts` **and** to
   `REQUIRED_SCOPES` in `src/lib/shopify-token-manager.ts` **and** to both
   `shopify.app.toml` and `shopify.app.custom.toml` **and** update
   `tests/shopify-scope-drift.test.ts` to match — all four must move
   together or the scope-drift test will (correctly) fail.
2. Add `orders/create`, `orders/updated`, and `refunds/create` webhook
   subscription blocks to both TOML files, each pointing at the
   corresponding route added in this phase. Config-declared subscriptions are
   the only mechanism this app uses (runtime registration was removed), so an
   unsubscribed topic is never delivered regardless of route code.
3. Handle the `LEGACY_OFFLINE` scope-check bypass documented by the Phase 7A
   audit: brands on a legacy, non-expiring token silently receive 403s from
   Shopify on any newly-scoped call with no reconnect signal surfaced to
   them. Adding `read_orders` without addressing this leaves those brands
   quietly broken rather than prompted to reconnect.
4. Update `src/content/legal/privacy.ts` and `src/content/legal/terms.ts`,
   which currently make explicit, affirmative statements that SQRATCH does
   not request order access (e.g. "SQRATCH does not request access to
   Shopify orders" appears in both files today). Those statements become
   false the moment `read_orders` is requested, regardless of whether any
   route is live yet.
5. Every already-connected `EXPIRING_OFFLINE` brand will need to re-approve
   installation via OAuth to grant the new scope; there is no silent
   scope-upgrade path for that auth mode.
6. Drive a full Shopify app review for the new scope before general
   availability — Shopify requires justification and review for
   `read_orders` on a public app listing.

Skipping or reordering these is not a shortcut; each guards a real
consequence (a broken legal claim, a silently-broken merchant, a rejected
app review, or webhooks that are subscribed but never actually authorized).

## Limitations

- **The int32 money ceiling.** `decimalStringToMinorUnits` still enforces the
  int4 range even though every Phase 7 money column is `BigInt`. A single
  amount above roughly $21.4M-equivalent (at exponent 2) is rejected with a
  typed `OUT_OF_RANGE` result, nulling that one field and never failing the
  order. Widening the helper is a separate, deliberately reviewed change; the
  wider column type is what makes that a code-only change later.
- **The crash-between-claim-and-commit operational gap** described under
  [Idempotency](#idempotency) above.
- **`ShopifyCommerceAdapter` was deliberately left untouched.** The three
  order webhook routes bypass it entirely and call the lower-level,
  already-provider-neutral `verifyShopifyWebhookRequest` primitive directly —
  the exact same function the four existing webhook routes already use. This
  is not an oversight: `tests/shopify-commerce-adapter.test.ts` has a live
  assertion that `ShopifyCommerceAdapter`'s webhook topic map rejects
  `orders/create` as unrecognized, and that test is explicitly out of scope
  for this phase to change. Routing order webhooks through the adapter would
  have required either widening that topic map (touching a file and test
  this phase was told not to touch) or building a second, divergent
  verification path — both worse than reusing the primitive the adapter
  itself wraps. A future maintainer should read this as a deliberate
  decoupling, not a gap to "fix" by merging the two paths.

## Migration

`prisma/migrations/20260807180000_add_commerce_order_normalization`

- **Preflight**: the migration file's header includes the exact preflight
  SQL confirming the three prerequisite migrations
  (`20260806120000_add_commerce_connection_abstraction`,
  `20260806140000_add_commerce_product_catalog`,
  `20260807160000_add_commerce_click_attribution`) are applied and not
  rolled back, that their tables exist, that the three new enum type names
  are not already taken, and that the three new tables don't already exist
  from a partial manual application.
- **Additive-only**: three new enum types, three new tables, their indexes,
  and their foreign keys. No pre-existing table, column, index, or
  constraint is altered, dropped, or backfilled — verified mechanically by
  `tests/commerce-order-migration-shape.test.ts`.
- **Rollback limitations**: there is no automatic rollback SQL. While these
  tables are empty (their state until the rollout above happens), dropping
  them is genuinely lossless. Once order rows exist, dropping the tables
  destroys normalized revenue history that **cannot be re-derived** — the
  raw provider payloads are never retained anywhere (only their one-way
  digest), and re-fetching them from Shopify would require the very
  `read_orders` scope this phase does not hold. `AnalyticsEvent` is not a
  substitute: it is client-fired, forgeable, and carries no money at all.
  Restore from a database backup, or export the three tables, before any
  manual drop.

## Phase 8 boundary

Explicitly, Phase 7 does **not** implement, and nothing in it should be read
as implying:

- Purchase-based SQRATCH points (no code path in `order-ingestion.ts`,
  `shopify-order-normalizer.ts`, `shopify-order-webhook.ts`, or any of the
  three routes references `PointTransaction`, `UserPointAccount`,
  `debitPoints`, `creditPoints`, or `pointsLedger` — verified by source
  inspection in `tests/order-ingestion.test.ts`).
- Brand reward interaction of any kind (no reference to `BrandRewardOffer`,
  `ShopifyRewardRedemption`, or `createShopifyRewardDiscountCode` anywhere in
  the same surface — same verification).
- Creator commissions or payouts (no reference to `commission`, `payout`, or
  `creatorEarning` anywhere in the same surface — same verification; this
  concept does not exist anywhere else in the codebase yet either).
- Buyer identity verification, or any claim about who bought what.

`CommerceOrder` and `CommerceOrderLineItem` exist purely as normalized
financial fact records — provider-neutral evidence of what a merchant order
*was* — for a future phase to consume. They award nothing, debit nothing,
and identify no one.
