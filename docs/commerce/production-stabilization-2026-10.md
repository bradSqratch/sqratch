# Production stabilization: October 2026

## Scope and starting state

Started on clean `main` at `f61846c4c76bcb617261b23fbb389417c7894687`, matching local `origin/main`; a final read-only `git ls-remote` also confirmed the same SHA on remote main. No branch, commit, push, deployment, provider mutation, environment-variable change, migration application, or production database write was performed. Production inspection used SELECT queries only.

## Findings and evidence

The original report and the later read-only snapshot differ. In the later snapshot, tenant `sqratch-inc` is CONNECTED with CAD configured, and #1004 already exists through a PROCESSED `commerce7:order:backfill` event. Its SQRATCH creation time is October 6, 2026 at 8:13:22 PM America/New_York (October 7 00:13:22 UTC). It is PAID, UNFULFILLED, subtotal 4900, tax 637, shipping 0, total/net 5537 minor units, refunded 0, one line, and unattributed. This work did not create that production order. The fixture uses those subsequently verified amounts; its ids are synthetic.

The last genuine Commerce7 Order Update event remains August 26, 2026. There are no genuine Create events in the observed ledger. Backfill success proves the canonical ingestion path can receive the order; it does not prove webhook delivery works. The Order Create and Update actions share `/api/commerce7/webhooks/orders`, authenticate with configured Basic Auth before parsing, resolve `tenantId` to an exact CONNECTED Commerce7 connection, use the raw-body digest as event identity, and share refund preparation and generic event claims with backfill. Failures before an event claim can leave no CommerceOrderEvent. The new REQUEST_RECEIVED log distinguishes application arrival from downstream processing, while existing auth diagnostics distinguish receiver configuration from credential mismatch. Provider-side subscription/delivery status remains unobservable from this UI.

Commerce7 click-attribution rows remain zero; Shopify has 31. The production CommerceProvider enum contains COMMERCE7 and the expected click columns exist. Missing enum/table-column deployment is therefore not supported by the current evidence. No Vercel logs or production pepper value/readiness were accessible in this session. The exact October 6 mint exception and provider non-delivery cause remain unresolved; absent pepper must not be asserted as the proven cause.

A reproducible click defect was found: `viewer.sessionId` is a format-validated cookie, which can outlive its UserSession row. The old QR lookup tolerated a missing row but the insert still wrote its nonexistent FK. A missing optional session is now omitted from the click row. Session creation failures also redirect after destination authorization. New failure logs expose provider, surface, stage, allow-listed Prisma code, configuration presence, and context-presence booleans only. No error message, error object, destination, token/hash, session id, IP or query values are logged by the mint diagnostic.

Backfill formerly reported COMPLETED after transient preparation failures and failed/in-flight ingestion. It also ignored provider-list completeness. These could advance a durable checkpoint past un-ingested orders. INCOMPLETE now prevents both Catch Up watermark and Custom Range cursor advancement, while successful writes remain idempotent. Raw list totals are checked before client-side date filtering; missing/invalid counts, dropped malformed entries, and partial responses cannot prove coverage. Large complete windows retain the existing 500-order processing ceiling and bounded adaptive narrowing. Provider pagination remains a separately unverified contract; the worker refuses incomplete coverage rather than guessing it.

## Brand Analytics

From/To initialize from the existing inclusive last-30-UTC-days helper. They are visibly labeled, and every request uses those exact values. Empty, inverted, invalid or over-cap dates pause requests and show an explanation. No preset or range cap was added/relaxed. Engagement uses UTC end-of-day rather than server-local `setHours`. Campaign sits inside Engagement; whole-brand product clicks and conversions remain independent. All three effects discard superseded responses and unmount results. Campaign options persist while filtering. Zero engagement and ingested-but-unattributed conversion breakdowns use concise empty states. Financial calculations, exact-token matching, currency separation/UNKNOWN handling, and privacy scopes are unchanged.

## Commerce7 attribution research decision

No Commerce7 token transport or extractor was enabled. Its normalizer remains fail-closed. Shopify's existing `sqratch_ref` query/cart-extension transport and generic exact-evidence matcher are unchanged. An unsupported Shopify-style parameter is no longer added to Commerce7 destinations.

Official sources inspected:

- [Storefront URL parameters](https://design-docs.commerce7.com/docs/url-parameters) and [alternate URL parameters guide](https://design-docs.commerce7.com/docs/url-parameters-1): document preconfigured metadata keys and `?meta-<code>=<value>` for adding metadata to a cart. They do not specify accepted custom-field types or explicitly guarantee arbitrary-token product-page-to-order persistence.
- [Order custom fields](https://documentation.commerce7.com/creating-custom-attributes-for-an-order) and [custom field types](https://documentation.commerce7.com/meta-data-data-types): document manual Order field creation and String fields separately. Customers do not see custom-field choices on web orders. These do not establish the String URL contract by themselves.
- [Shareable cart/checkout links](https://documentation.commerce7.com/working-with-influencers-to-market-your-product): the referral example specifically instructs Select with predetermined options. It is insufficient evidence for a fresh arbitrary token per click.
- [Orders API](https://developer.commerce7.com/docs/orders): documents GET order/list and total counts; its Cart example includes `metaData`. The inspected Order examples do not establish the exact populated String custom-field shape shared by GET order and Order webhook payloads.
- [APIs and Webhooks](https://developer.commerce7.com/docs/app-apis-webhooks): lists MetaData Config permissions and full-object webhook payloads, but permission availability is not a provisioning schema or an arbitrary-token persistence guarantee.
- [App Data](https://developer.commerce7.com/docs/custom-app-data): documents app-owned writes through authenticated API requests and app-namespaced responses. It does not document a storefront URL-to-appData handoff; using it here would require a different verified cart integration.

Answers to the required questions:

1. String fields exist and generic URL metadata exists. Their combination for arbitrary opaque tokens is **not sufficiently verified** by the inspected material.
2. No alternative field/type was verified. Select examples cannot accept an unbounded fresh token without an additional contract; appData requires authenticated API integration.
3. `metaData` is the documented Cart lead, but the exact populated Order GET/webhook field shape is **unverified**. No alias or guessed key is accepted.
4. Full product page → cart → checkout → order durability, including an existing cart, is **unverified**.
5. MetaData Config API access is documented; a safe definition read/create contract and required installed-app permissions were **not verified**. No provisioning code or tenant mutation was attempted.

No manual Commerce7 field setup is required for this release because transport remains disabled. For validation only, an operator can create an optional Order String field in a sandbox, choose a code such as `sqratch-ref`, and follow the experiment below. That is a candidate, not an implemented contract.

## Worker deployment and operator steps (not executed)

The new POST `/api/internal/commerce7-reconciliation-worker` requires `x-cron-secret` against the existing CRON_SECRET. It selects at most one unclaimed CONNECTED Commerce7 connection by oldest last-attempt time and calls one existing Catch Up step. Only aggregate counts are returned/logged. Failures return 503; authentication failure returns 401. There is no cron configuration, startup invocation, or production schedule in this change.

**Apply the additive migration `20261007010000_commerce7_reconciliation_claim` separately before deploying this code.** It adds activeRunId and activeRunStartedAt to the existing state table. Prisma generation here was local only. Manual Catch Up, Custom Range, and the legacy reconciliation endpoint share the whole-step claim with the worker. Acquisition uses the existing connection-row lock in a short transaction; no transaction/row lock is held during provider HTTP. Release matches the exact run owner. Claims are never stolen based on time.

An interrupted process can leave a durable claim. The state UI exposes its start time. An operator must first prove the invocation has ended, then clear only that exact connection/run claim using a separately authorized, conditional administrative update. Never clear by age alone and never move the reconciliation watermark to recover a claim. This availability tradeoff prevents a still-running process and replacement from overlapping.

After sandbox QA, migration and deployment, an operator may separately schedule authenticated POST requests using the existing operations scheduler. Choose frequency and runtime limits against observed chunk duration and backlog. Monitor failed counts, checkpoint lag, and persistent claims. Webhooks remain the live path. Scheduling the safety net does not establish provider webhook health.

## Manual test plan

1. In an isolated test database, apply the additive migration after review. Do not point local write tests at production. Run the opt-in real-Postgres concurrency test described in `tests/commerce7-order-reconciliation-real-db.test.ts`; it must reject a second caller while the first provider phase is suspended and release ownership afterward.
2. Open Brand Analytics at desktop and mobile widths. Confirm visible labeled UTC From/To defaults span 30 inclusive days. Inspect network requests: all three endpoints must receive those same two date strings. Choose an August date, change Campaign, and confirm only engagement reloads while whole-brand sections retain their scope. Change dates quickly, clear one, invert them, and exceed the existing cap; stale results must not replace current data and blank fields must not issue bounded-default requests.
3. Verify empty brand and ingested-but-unattributed states. With suitable test data, verify CAD, USD and UNKNOWN remain separate in revenue and trends. Confirm no calculated click/order conversion rate appears.
4. Through both direct Experience and campaign entry, click Commerce7 generic storefront, campaign product and lesson products. Confirm a merchant redirect and one canonical click row with provider/surface/context/product/connection/redirect evidence. Repeat with a stale session cookie. In an isolated environment, remove the pepper or force session/create failure; redirect must continue without token transport, with only safe stage/code/readiness diagnostics. Restore test configuration afterward.
5. Inspect Commerce7's actual Order Create/Update subscription and delivery logs manually: URL, HTTPS, matching receiver Basic Auth, tenant and response codes. Do not paste credentials or full customer payloads into logs/chat. Deliver a sandbox Create and Update; confirm REQUEST_RECEIVED, authentication result, canonical event, and final order independently. Test bad auth, malformed/unsupported event, wrong tenant and disconnected connection; no unauthorized ingestion should occur. Identical delivery must deduplicate.
6. For the already-backfilled #1004, first confirm the existing production row with SELECT only. In a sandbox, represent a paid one-product 5537-CAD-minor order with no delivered webhook. Run Custom Range covering its provider updatedAt, repeat, then Catch Up. Expect exactly one canonical order, PAID/UNFULFILLED, refunded 0, net 5537 and no fabricated attribution. Recheck #1002 partial-refund totals 9831/3277/6554 and root-only identity after repeated reconciliation.
7. Invoke the worker without/with an invalid secret (401), then with valid sandbox credentials. Verify one connection/chunk maximum and counts-only output. Run overlapping worker/manual calls for one connection (busy/409, no second provider fetch), and different connections (independent). Force provider/list/refund/ingestion failure; no checkpoint should advance. A later retry must resume the same window without duplicate orders. Force process termination; observe the durable claim and exercise verified owner-specific operator recovery.
8. Commerce7 contract experiment: create an optional sandbox Order String field. Use a synthetic 43-character base64url marker with the candidate `?meta-sqratch-ref=<marker>` on a product page, then add to cart and checkout. Verify the exact value in cart, GET order and Create/Update webhook, including an existing cart, navigation, redirects, multiple tabs/clicks and checkout. Compare missing/malformed values. Record only redacted payload shape and a boolean exact-match result. Ask Commerce7 to confirm supported String URL assignment, exact Order payload shape, overwrite semantics and MetaData Config API read/provision contract. Only then enable a provider-specific transport/extractor using the existing generic matcher and its hash/provider/connection/brand/redirect/expiry/one-time-consumption rules.
9. Repeat Shopify public product redirect, extension cart attribute, HMAC Create/Update/refund ingestion, attribution and reward redemption smoke tests. No Shopify provider module or extension was changed.

## Review notes

P0: none identified. P1 repairs cover checkpoint/data-coverage safety. P2 repairs cover click fail-open behavior, UI races, claim serialization and safe diagnostics. Findings repaired: checkpoint completion after unsuccessful ingestion; incomplete list coverage; stale session FK; legacy reconciliation bypassing whole-step ownership; forwarding range-only fields into claim Prisma create/release shapes; superseded engagement/click results and unmount conversion results. Known operational limitations are the unapplied migration, verified-recovery requirement for abandoned claims, unavailable provider delivery/Vercel evidence, and unverified Commerce7 arbitrary-token transport. The latter remains fail-closed rather than being represented as complete.

Complete validation after implementation passed: TypeScript, ESLint, 2,845 tests (2,826 passed, 19 skipped, zero failures), Next.js production build, diff whitespace check, and Prisma schema validation. After final adversarial review, all six checks passed again with identical test totals and no known remaining P0/P1/P2 findings. Skipped real-database/browser/provider tests remain operator QA; passing unit tests are not evidence of live webhook delivery or a verified provider transport.

Graphify AST update completed: 4,526 nodes and 10,194 edges. It warned that SQL extraction lacks `tree_sitter_sql`, a JSON locale file produced no nodes, and community labels need refresh. No semantic/API-cost labeling or dependency installation was performed. Current source and the additive SQL migration were reviewed directly.


## Final file inventory

- `docs/env-vars.md`
- `prisma/schema.prisma`
- `src/app/(withSidebar)/dashboard/brand/analytics/page.tsx`
- `src/app/(withSidebar)/dashboard/brand/commerce/commerce-response-validation.ts`
- `src/app/(withSidebar)/dashboard/brand/commerce/orders/BrandCommerceOrdersClient.tsx`
- `src/app/api/brand/analytics/route.ts`
- `src/app/api/brand/commerce/connections/[connectionId]/orders/catch-up/route.ts`
- `src/app/api/brand/commerce/connections/[connectionId]/orders/reconcile-range/route.ts`
- `src/app/api/brand/commerce/connections/[connectionId]/orders/reconcile/route.ts`
- `src/lib/commerce/click-attribution.ts`
- `src/lib/commerce/click-token.ts`
- `src/lib/commerce/commerce-click-analytics.ts`
- `src/lib/commerce/providers/commerce7-order-backfill.ts`
- `src/lib/commerce/providers/commerce7-order-normalizer.ts`
- `src/lib/commerce/providers/commerce7-order-reconciliation.ts`
- `src/lib/commerce/providers/commerce7-order-webhook.ts`
- `src/lib/commerce/providers/commerce7-orders.ts`
- `tests/brand-analytics-conversions.test.ts`
- `tests/commerce-click-attribution.test.ts`
- `tests/commerce7-order-ingestion.test.ts`
- `tests/commerce7-order-reconciliation-real-db.test.ts`
- `tests/commerce7-order-reconciliation-routes.test.ts`
- `tests/commerce7-order-reconciliation.test.ts`
- `tests/commerce7-refund-repair-pipeline.test.ts`
- `docs/commerce/production-stabilization-2026-10.md` (new)
- `prisma/migrations/20261007010000_commerce7_reconciliation_claim/migration.sql` (new)
- `src/app/api/internal/commerce7-reconciliation-worker/route.ts` (new)
- `src/lib/commerce/brand-analytics-filters.ts` (new)
- `src/lib/commerce/click-diagnostics.ts` (new)
- `src/lib/commerce/providers/commerce7-reconciliation-claim.ts` (new)
- `src/lib/commerce/providers/commerce7-reconciliation-worker.ts` (new)
- `tests/brand-analytics-ux.test.ts` (new)
- `tests/commerce7-reconciliation-worker.test.ts` (new)

## git diff --stat

Tracked-file output (Git excludes the nine untracked new files above until staged):

```text
 docs/env-vars.md                                   |   2 +-
 prisma/schema.prisma                               |  17 +--
 .../dashboard/brand/analytics/page.tsx             | 135 +++++++++++--------
 .../brand/commerce/commerce-response-validation.ts |   2 +
 .../commerce/orders/BrandCommerceOrdersClient.tsx  |   6 +
 src/app/api/brand/analytics/route.ts               |  19 +--
 .../[connectionId]/orders/catch-up/route.ts        |   8 +-
 .../[connectionId]/orders/reconcile-range/route.ts |   7 +-
 .../[connectionId]/orders/reconcile/route.ts       |  13 +-
 src/lib/commerce/click-attribution.ts              | 146 ++++++++++++---------
 src/lib/commerce/click-token.ts                    |   5 +
 src/lib/commerce/commerce-click-analytics.ts       |   2 +-
 .../commerce/providers/commerce7-order-backfill.ts |  16 ++-
 .../providers/commerce7-order-normalizer.ts        |   6 +-
 .../providers/commerce7-order-reconciliation.ts    |  38 +++++-
 .../commerce/providers/commerce7-order-webhook.ts  |   6 +-
 src/lib/commerce/providers/commerce7-orders.ts     |  13 +-
 tests/brand-analytics-conversions.test.ts          |   2 +-
 tests/commerce-click-attribution.test.ts           | 145 +++++++++++++++++++-
 tests/commerce7-order-ingestion.test.ts            |  36 +++++
 .../commerce7-order-reconciliation-real-db.test.ts |  34 ++---
 .../commerce7-order-reconciliation-routes.test.ts  |  17 +++
 tests/commerce7-order-reconciliation.test.ts       |  33 ++++-
 tests/commerce7-refund-repair-pipeline.test.ts     |  42 +++++-
 24 files changed, 559 insertions(+), 191 deletions(-)
```
