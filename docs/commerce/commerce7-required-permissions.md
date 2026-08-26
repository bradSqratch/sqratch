# Commerce7 — required App Development Center permissions

Reference for what SQRATCH's Commerce7 integration actually needs, and why.
Keep this in sync whenever a new Commerce7 API is added or an existing one's
scope changes.

## Required permissions

| Permission     | Used for                                                                 |
| --------------- | ------------------------------------------------------------------------ |
| **Product: Read** | Catalog sync (`src/lib/commerce/providers/commerce7-products.ts`) — product listing/availability for `ConnectedCommerceProduct`. |
| **Order: Read**   | Order ingestion/backfill (`commerce7-orders.ts`, `commerce7-order-backfill.ts`) — read-only, no mutation capability anywhere in this codebase. |
| **Setting: Read** | Store settings sync (`commerce7-settings.ts`) — see below. Added in the settings-sync round; replaces the prior manually-authored storefront configuration. |

## `Setting: Read` — exact scope of use

SQRATCH calls `GET /v1/setting` for exactly one reason: to read the tenant's
**Website URL**, **Currency**, and **Product Page base route**
(`baseRoute.product`) — the same three values a Brand Admin used to type in
by hand. Nothing else in that response is ever used.

**This permission's response can carry configuration belonging to other,
unrelated merchant integrations** — shipping-compliance, tax, payment, and
other third-party settings entirely outside SQRATCH's concern. The
integration code enforces a hard boundary at the client
(`fetchCommerce7StoreSettings` in `commerce7-settings.ts`): the raw response
is parsed only as `unknown`, immediately projected down to
`{storefrontUrl, currencyCode, productRoute}`, and discarded. See that
file's own header for the full contract.

**The raw Setting payload must never be logged or persisted** — not in
`providerMetadata`, not in a diagnostics payload, not in an error message,
not in a test fixture. `tests/commerce7-settings.test.ts` (Part 19) asserts
this directly against a response containing fake sensitive sibling fields.

## Explicitly NOT requested

Do not add any of the following unless a real feature requires it and this
doc is updated to justify it:

- **Refund: Read** — refund state is already inferred from Order data
  (`tenders[]`), no separate Refund API call is made.
- **Setting: Full** (write) — SQRATCH never writes Commerce7 settings; the
  sync direction is Commerce7 → SQRATCH only.
- **Order: Full** (write) — order mutation is out of scope; this codebase
  contains no function that creates, updates, or cancels a Commerce7 order.
- **Product: Full** (write) — catalog sync is read-only.

## App-level vs per-tenant credentials

All Commerce7 API calls (Product, Order, Setting) authenticate as
`App ID : App Secret` via HTTP Basic auth, both read from backend
environment configuration (`getCommerce7AppConfig()` in `commerce7.ts`).
This is deliberately **app-global**, never a per-tenant credential stored in
`CommerceConnectionSecret` — see that function's own doc comment for why.
