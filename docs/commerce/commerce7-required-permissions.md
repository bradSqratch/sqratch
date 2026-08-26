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

## Verification status (PHASE 21 — read this before calling it "confirmed")

> Empirically verified with the SQRATCH Commerce7 sandbox using
> `Setting: Read`; general partner-app availability pending explicit
> Commerce7 confirmation.

Specifically:

- `GET /v1/setting` (the collection endpoint, no id) works today against the
  `sqratch-inc` sandbox tenant with App ID/App Secret Basic Auth + an exact
  `tenant` header, when `Setting: Read` is enabled on the app.
- Commerce7 staff separately indicated in Partner Slack that they were **not
  certain** Setting data is generally accessible through partner app
  credentials for every installed merchant tenant. SQRATCH has asked
  Commerce7 to clarify:
  1. whether `GET /v1/setting` (collection) is supported the same way
     `GET /v1/setting/:id` (single record) is, for partner apps generally;
  2. whether that holds for every installed tenant, not just this sandbox.
- Until Commerce7 confirms, do **not** treat a successful sandbox call as
  proof this works for all merchants. Do **not** restore manual
  storefront/currency/route editing in response to that uncertainty — the
  integration already fails closed (a 401/403 or any non-2xx Setting
  response is a normal, controlled `SETTINGS_SYNC_FAILED` outcome, never an
  unhandled exception, never surfaced to a merchant as an alarming error —
  see `commerce7-connection-lifecycle.ts` / `commerce7-settings-sync.ts`).
  If Commerce7 eventually confirms the collection endpoint is NOT reliably
  available for all tenants, the operational fallback is a real product
  decision for a future round (e.g. `GET /v1/setting/:id` if an id becomes
  discoverable, or reintroducing a merchant-confirmed fallback for tenants
  where Setting access is unavailable) — not something to guess at now.

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
