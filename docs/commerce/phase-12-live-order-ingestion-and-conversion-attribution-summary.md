# Phase 12 — Live provider-neutral order ingestion and Shopify conversion attribution

Phase 12 activates a live, exact-evidence conversion path without inventing
attribution for historical clicks or orders. **Phase 12.1** hardened this
implementation before commit: fixed a P1 webhook-delivery data-loss window,
renamed the cart attribute for checkout-presentation hygiene, added the
Shopify app-embed enablement UX and the `app/scopes_update` synchronization
webhook, and closed several correctness/documentation gaps. This document
describes the hardened, current state.

## Transport and evidence

The validated SQRATCH redirect appends `?sqratch_ref=<token>` — the public,
SQRATCH-namespaced URL query parameter (`CLICK_TOKEN_QUERY_PARAM`,
`src/lib/commerce/click-token.ts`), never a generic `ref`. The
`extensions/sqratch-attribution` Theme App Extension reads that query
parameter, format-validates it, and writes it to a **separate**, differently
named Shopify cart attribute: `_sqratch_ref` (`CLICK_TOKEN_CART_ATTRIBUTE`),
via `/cart/update.js`. The single leading underscore hides the attribute
from Shopify's normal checkout presentation while it remains fully readable
through the Ajax Cart API and order webhooks — this is a deliberate,
intentional divergence from the URL parameter's name, not an oversight; the
two constants are independently defined and independently tested so a future
edit cannot silently collapse them back into one shared literal.

Shopify cart attributes are carried into the order as order attributes; the
normalizer (`extractShopifyAttributionToken`,
`src/lib/commerce/providers/shopify-order-normalizer.ts`) accepts only that
durable `_sqratch_ref` attribute — never `landing_site` or `referring_site`,
which are visitor-supplied and untrustworthy. The app embed changes neither
theme source nor product/variant/checkout behavior — it only ever calls
`/cart/update.js` with one attribute. The latest legitimate SQRATCH click
replaces only the prior `_sqratch_ref` cart attribute (last touch); no other
cart or checkout attribute is ever read or written by this app. No creator,
creator-profile, experience, campaign, lesson, user, brand, or connection
identifier is ever written to a Shopify cart attribute — only the opaque,
256-bit, HMAC-hashed-at-storage click token.

The app stores only a peppered token hash and short prefix; the plaintext
token is never persisted. A conversion claim requires: exact token-hash
match, valid token format, `redirectedAt` set (the visitor genuinely reached
the merchant), unexpired (`expiresAt`), unconsumed (or an idempotent replay
by the exact order that already consumed it), non-null immutable
`attributedBrandId`, exact resolved Brand match, exact `CommerceConnection`
match, and matching provider. It does not use email, customer identity, time
proximity, campaign topology, product similarity, IP, or user agent.
Historical clicks with a null `attributedBrandId` remain unknown and cannot
become conversions.

## Shopify configuration and rollout

Both Shopify TOMLs request `read_products,read_orders,read_themes,read_discounts,write_discounts`
and subscribe to `orders/create`, `orders/updated`, `refunds/create`,
`order_transactions/create`, and `app/scopes_update` (in addition to the
pre-existing `app/uninstalled` and the three GDPR compliance topics).
`order_transactions/create` fires only for a transaction created or settled
to a terminal status (`success`, `failure`, or `error`) and exists as the
reliable signal for a refund transaction that was created `PENDING` and
later settles with no other order-level field changing — see "Refund
settlement" below. `read_all_orders` and `write_orders` are not requested. Both apps use Shopify **managed installation**
(`use_legacy_install_flow` is `false` in `shopify.app.toml` and absent from
`shopify.app.custom.toml`) — confirmed by audit, not changed by this phase —
which is what lets Shopify grant a newly-required scope to an
already-installed merchant without a full re-OAuth.

Existing stores must reauthorize (or have Shopify silently grant the new
scope through managed installation) after the app configuration is
deployed; until then the Shopify status endpoint reports
`orderAttributionReady: false` without disabling their existing catalog or
reward functionality. **`app/scopes_update`** keeps SQRATCH's canonical
`CommerceConnection.grantedScopes` (and temporary legacy mirror) synchronized
whenever Shopify's managed installation changes what's granted, without requiring a full reconnect —
see "Scope synchronization" below.

Official references used:

- [Shopify access scopes](https://shopify.dev/docs/api/usage/access-scopes)
- [Shopify webhook delivery verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries)
- [Shopify order webhooks](https://shopify.dev/docs/agents/orders/order-webhooks)
- [Theme app extension configuration](https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration)
- [Cart attributes](https://shopify.dev/docs/storefronts/themes/architecture/templates/cart)
- [Managed installation scope changes](https://shopify.dev/docs/apps/build/authentication-authorization/app-installation/manage-access-scopes)

## Webhook delivery claim state machine (the Phase 12.1 P1 fix)

**Root cause, as it stood before Phase 12.1**: the event claim
(`CommerceOrderEvent` insert, `status: RECEIVED`) and the order-writing
transaction are two separate writes, deliberately not one transaction
(Postgres aborts the whole transaction on a failed statement, so "catch the
unique-violation and carry on" isn't expressible if the claim were inside
it). A redelivery of the same event that arrived while the original request
was still between those two writes — including because the original process
had already crashed — was indistinguishable from a genuinely-completed
duplicate: both read back a `RECEIVED` row and were acknowledged `200`.
Since Shopify treats `200` as settled and stops retrying, a delivery that
crashed in that window could be **permanently lost** — never ingested, never
retried again.

**Fix**: the claim now resolves to one of four explicit outcomes
(`OrderEventClaim`, `decideOrderEventClaim`, `resolveOrderEventClaim` in
`src/lib/commerce/order-ingestion.ts`):

| Outcome | Meaning | HTTP response |
|---|---|---|
| `CLAIMED` | No prior row for this `(provider, providerEventId)`. | Process normally. |
| `RECLAIMED` | Prior row is `FAILED` (any age) or `RECEIVED` past a 60-second lease (`EVENT_CLAIM_LEASE_MS`); atomically taken over via compare-and-set on `(id, status, receivedAt)`, which also **resets** `receivedAt` so the new lease doesn't immediately read as stale to a third concurrent retry. | Process normally. |
| `COMPLETED_DUPLICATE` | Prior row is terminal: `PROCESSED`, `SKIPPED_STALE`, or `SKIPPED_DISCONNECTED`. | `200`, not reprocessed. |
| `IN_FLIGHT` | Prior row is `RECEIVED` and the lease has **not** expired — this is the exact "crashed between claim and commit" window, and it is no longer conflated with a genuine duplicate. | `500` — Shopify redelivers; by then the lease has either completed (→ `COMPLETED_DUPLICATE`) or expired (→ `RECLAIMED`). |

`isRetryableOrderIngestionOutcome()` is the single source of truth mapping
an outcome to the webhook's HTTP status (`src/lib/commerce/providers/shopify-order-webhook.ts`):
retryable (`500`) for `IN_FLIGHT`, `WRITE_FAILED` (a transient failure
during the order transaction), and `UNEXPECTED_FAILURE` (any unexpected
thrown error, now caught at both the ingestion layer and the webhook-handler
layer rather than propagating as an unhandled exception); `200` for every
deterministic outcome (success, genuine duplicate, malformed/non-retryable
payload). See `docs/commerce/phase-7-order-normalization-summary.md`'s
"Idempotency" section for the full before/after narrative and the updated
ops runbook query.

## Order and analytics semantics

The raw body is HMAC-verified before parsing; route paths (not the
spoofable `x-shopify-topic` header) bind topics; Shopify delivery IDs
deduplicate `CommerceOrderEvent` (with a digest-of-body fallback for
fixture-driven tests, which have no such header). `orders/updated` is the
authoritative full-order state, and `refunds/create` and
`order_transactions/create` are non-creating partial fragments. Stale
updates cannot overwrite newer state; an order retains its existing
attribution across later updates.

**Refund settlement is never computed from a REST refund/transaction
webhook payload.** Shopify documents that a Refund object's existence does
not prove money moved ("check the transaction status"), and the REST
Transaction resource carries no shop-money field at all. Whenever a
delivery carries refund evidence (`orders/create`/`orders/updated` with a
non-empty `refunds[]`, or unconditionally for `refunds/create` and
`order_transactions/create`), the Shopify provider layer
(`src/lib/commerce/providers/shopify-order-financial-reconciliation.ts`)
performs a live Admin GraphQL query for the order's `transactions`, sums
only `kind: REFUND, status: SUCCESS` amounts in shop currency, and that
sum — never a REST-derived figure — becomes the cumulative
`totalRefundedMinor`/`financialStatus` written to `CommerceOrder`. If
reconciliation cannot establish a trustworthy value right now (no usable
credential, order not found, or an ambiguous/possibly-truncated
transaction list), those two fields are deferred (left `null`), which
`order-ingestion.ts` coalesces to the previously-stored value rather than
guessing or zeroing it; a transient reconciliation failure blocks ingestion
of that delivery entirely and asks Shopify to redeliver.

`/api/brand/analytics/conversions` scopes to the immutable click Brand
(`attribution.attributedBrandId`, never the FK-backed and cascade-rewritable
`brandId` — see `docs/commerce/phase-10-click-only-attribution-analytics-foundation-summary.md`
for why), and `/api/creator/analytics/conversions` scopes to creator-owned
click Experiences. They report ingested orders, historical `attributedOrders`,
current `currentlyNetPositivePaidOrders`, `pendingOrAuthorizedOrders`,
`partiallyRefundedOrders`, and `fullyRefundedOrders`, plus
`grossAttributedRevenueByCurrency`, `refundedRevenueByCurrency`, and
`netAttributedRevenueByCurrency` current-state minor-unit sums — each an
array of `{currencyCode, minor}` rows, grouped by the row's own currency, so
a brand/creator whose orders span more than one currency never has those
amounts silently summed into one unlabeled total (an `"UNKNOWN"` bucket
catches any row whose own currency could not be resolved) — and
provider/campaign/Experience/creator/lesson/product breakdowns
(`src/lib/commerce/order-analytics.ts`). **`attributedOrdersByProduct`
counts distinct ORDERS per product, not line-item occurrences** — an order
carrying the same connected product on two line items counts once for that
product, not twice; every other breakdown was already, and remains,
one-value-per-order. Minor values serialize as decimal strings. No
commission, payout, reward, or point behavior is added — `orders/create`
receipt is never treated as equivalent to money received; the normalized
financial-status enum (`PENDING | AUTHORIZED | PARTIALLY_PAID | PAID |
PARTIALLY_REFUNDED | REFUNDED | VOIDED`) is carried verbatim from Shopify's
`financial_status` and only ever reported, never acted on. Pending,
authorized, voided, and fully refunded orders do not contribute current
positive net conversions; later refund updates reduce current net analytics
without deleting historical attribution.

Shopify payload customer/address/contact fields are deliberately ignored by
the normalizer and never stored or logged. No migration is required: the
existing provider-neutral order, line-item, event, and direct attribution
models already represent the lifecycle, and this remains true after Phase
12.1's hardening — the only schema-adjacent changes in this pass were
comment corrections (see "Documentation and comment corrections" below).

## Shopify app-embed enablement UX

The theme app extension's app-embed block ships inactive — Shopify does not
auto-enable an app embed on install. With `read_themes`, the Shopify-specific
theme readiness module reads only the current main theme's
`config/settings_data.json` and reduces it to a neutral state; theme contents
and enabled state are never persisted. The Brand Shopify status page
(`src/app/(withSidebar)/dashboard/brand/shopify/BrandShopifyClient.tsx`)
therefore surfaces explicit readiness states and a setup CTA once connected:

```
Shopify connection                Connected
Product catalog                   Ready
Order access                      Ready / Needs approval
Theme verification access         Available / Needs approval
Storefront conversion tracking    Enabled / Disabled / Not configured / Unknown
Overall conversion tracking       Ready / Not ready

[ Enable conversion tracking ]
```

The button,
shown only when a valid deep link can be built, opens Shopify's Theme
Editor in a new tab (never an automatic redirect):

```
https://<shop>.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=<api-key>/sqratch-attribution-embed
```

Built by a pure, defensively-validated function
(`buildThemeEditorAppEmbedDeepLink`, `src/lib/commerce/shopify-app-embed.ts`)
from three server-trusted values only — the brand's own stored
`shopifyShopDomain` (validated against a strict `*.myshopify.com` pattern),
the brand's own stored `shopifyClientId` (the Shopify app the brand actually
installed under — public or custom — validated against the 32-character
lowercase-hex client-id shape), and the app-embed block's handle
(`sqratch-attribution-embed`, filename-derived since
`extensions/sqratch-attribution/shopify.extension.toml` declares no explicit
`handle`) — never from client/request input. The assembled URL is re-parsed
and re-checked against its own inputs before being returned, so component
injection is structurally impossible, not merely unlikely.

## Scope synchronization (`app/scopes_update`)

`POST /api/shopify/webhooks/app/scopes_update` (`src/app/api/shopify/webhooks/app/scopes_update/route.ts`)
keeps canonical `CommerceConnection.grantedScopes` (and a temporary legacy
Brand mirror) current whenever Shopify's managed
installation grants or revokes a scope without a full OAuth reconnect. It
verifies HMAC over the raw body via the same shared verifier every other
webhook uses, resolves the exact `Brand` by its unique `shopifyShopDomain`
(never any client-suppliable id), and updates only that brand's
`grantedScopes` via compare-and-set writes scoped by the matching provider
connection and shop domain, while retaining the legacy mirror for old token
code. The write is scoped by both the
resolved row's own id and its shop domain (`applyGrantedScopesUpdate`,
`src/lib/shopify-token-manager.ts`) — an unknown shop is a deterministic
`200` no-op, and the update additionally refuses to resurrect scopes on a
row already `UNINSTALLED`. This webhook does not grant permissions itself;
it only synchronizes SQRATCH's cached view of what Shopify has already
granted. The Brand Shopify status route's `orderAttributionReady` field
gates on the canonical scope array containing `read_orders`, so this webhook keeps
that field accurate without requiring the merchant to reconnect.

An authoritative reconciliation path via Shopify's `currentAppInstallation.accessScopes`
(queried opportunistically alongside an already-authenticated Admin API
call, e.g. product sync) was assessed and intentionally **not** implemented
in this pass — the only current authenticated-call site
(`src/lib/shopify-products.ts`) would need its GraphQL query and response
type extended, which was judged non-trivial enough to defer rather than
rush. `applyGrantedScopesUpdate` is already written to be the reusable sink
for that follow-up.

## Documentation and comment corrections

Phase 12.1 also fixed several stale claims found by an independent audit:
a `shopify-order-webhook.ts` header claiming "200 for everything except a
signature failure" (now inaccurate given `WRITE_FAILED`/`IN_FLIGHT` → 500);
a matching stale comment in `order-ingestion.ts`; `docs/env-vars.md` and
`docs/shopify-testing.md` both still describing a 3-scope, 4-webhook Shopify
configuration; a `prisma/schema.prisma` comment claiming order ingestion
still enforces the `int4` range via `decimalStringToMinorUnits` (it uses the
separate, `int8`-bounded `decimalStringToBigIntMinorUnits`, and has since
`src/lib/commerce/money.ts` was extended); and internally-contradictory
"superseded" banners in the Phase 6, 7, and 10 docs, where a forward-pointing
banner had been added without updating the very next paragraph that still
asserted the pre-Phase-12 state as current.
