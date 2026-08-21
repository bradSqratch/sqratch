# Shopify Production Testing

The public app uses App Bridge session tokens, token exchange, and expiring offline-token rotation. The custom test app remains `LEGACY_OFFLINE`. Use the matching TOML and credentials for each flow; never mix public and custom client IDs.

This app reads Shopify products for display, reads Shopify orders for click-only conversion attribution (`read_orders` — see the Order Ingestion checklist below and `docs/commerce/phase-12-live-order-ingestion-and-conversion-attribution-summary.md`), and creates single-use Shopify discount codes when a user redeems SQRATCH points (`write_discounts`) — it never writes or mutates products or orders. Redemption status is polled and reconciled against Shopify after issuance. Store ownership is tied to `Brand`, not the individual user. For the detailed redemption/refund transaction and reconciliation logic, see `docs/points-ledger.md` and `docs/codebase-map.md` (Section F: "Shopify Reward Redemption", "Reward State Machine", "Stuck-Redemption Reconciliation").

## Vercel Environment Variables

- `SHOPIFY_API_KEY`: Shopify app client ID/API key.
- `SHOPIFY_API_SECRET`: Shopify app client secret. Used for OAuth and webhook HMAC verification.
- `SHOPIFY_APP_URL`: Production app origin, for example `https://www.sqratch.com`.
- `NEXTAUTH_URL`: Production app origin, for example `https://www.sqratch.com`.
- `NEXTAUTH_SECRET`: Required to sign application authentication sessions. It does not encrypt Shopify credentials.
- `APP_ENCRYPTION_KEY`: The sole stable, server-only key for encrypting Shopify access and refresh tokens. Generate and manage it independently from `NEXTAUTH_SECRET`. Do not rotate it without a token migration plan or store-reconnection plan.
- `DATABASE_URL`: Production database URL.
- `DIRECT_URL`: Required only if your Prisma migration workflow needs a direct database connection.

Do not add product write scopes unless the product requirements change.

## Shopify Partner Dashboard Settings

- App URL: `https://www.sqratch.com/shopify`.
- Embedded app: enabled.
- Allowed redirection URL: `https://www.sqratch.com/api/shopify/oauth/callback`.
- Access scopes: `read_products`, `read_orders`, `read_themes`, `read_discounts`, and `write_discounts` (see `docs/env-vars.md`'s Shopify scopes section for why `read_orders` is tracked separately from the other four at runtime).
- Admin API version: match `SHOPIFY_API_VERSION` in `src/lib/shopify.ts`.
- App uninstall webhook: `https://www.sqratch.com/api/shopify/webhooks/app/uninstalled`.
- Scope-update webhook: `https://www.sqratch.com/api/shopify/webhooks/app/scopes_update`.
- Customer data request webhook: `https://www.sqratch.com/api/shopify/webhooks/customers/data_request`.
- Customer redact webhook: `https://www.sqratch.com/api/shopify/webhooks/customers/redact`.
- Shop redact webhook: `https://www.sqratch.com/api/shopify/webhooks/shop/redact`.
- Order created webhook: `https://www.sqratch.com/api/shopify/webhooks/orders/create`.
- Order updated webhook: `https://www.sqratch.com/api/shopify/webhooks/orders/updated`.
- Refund created webhook: `https://www.sqratch.com/api/shopify/webhooks/refunds/create`.
- Order transaction created/settled webhook: `https://www.sqratch.com/api/shopify/webhooks/order_transactions/create`.

The repository also contains `shopify.app.toml` for the production embedded app configuration.

## Embedded App Shell

- Open the app from Shopify Admin and confirm `/shopify?shop=...&host=...` loads inside Shopify.
- Confirm SQRATCH branding is visible.
- Confirm the shell shows the Shopify shop domain when the `shop` parameter is valid.
- Confirm an already linked store shows the connected Brand name.
- Confirm an unlinked store shows `Not connected`.
- Confirm `Continue to SQRATCH linking` starts OAuth at `/api/shopify/oauth/start?shop=...`.

Current limitation: the embedded shell loads the minimum App Bridge script/meta surface, but it does not use App Bridge session-token authenticated API routes. The production flow intentionally hands off to SQRATCH OAuth/session auth and the SQRATCH Brand dashboard.

## SQRATCH-First Install Checklist

- Log in as a Brand Admin or authorized Brand Member with `ADMIN` or `MANAGER` brand role.
- Open `/dashboard/brand/shopify`.
- Enter a valid `*.myshopify.com` domain.
- Click `Connect Shopify`.
- Confirm OAuth asks for exactly the five scopes in `SHOPIFY_SCOPES` (`read_products`, `read_orders`, `read_themes`, `read_discounts`, `write_discounts`) — no product/order/theme write access.
- Complete OAuth and confirm redirect to `/dashboard/brand/shopify/install?install=...` if brand selection is needed.
- Select an existing eligible Brand (installation never creates a Brand — confirm no "Create new Brand" option is shown).
- Confirm redirect to `/dashboard/brand/shopify?connected=1`.
- Confirm Brand status is `CONNECTED`.
- Confirm encrypted token is saved only on `Brand`.
- Confirm a `USER` or `CREATOR` account (including one with no Brand membership at all) sees the "Brand Admin access required" panel instead of the install page, with "Switch SQRATCH account" and "Return to dashboard" actions — not a silent redirect to `/dashboard`.
- Confirm `POST /api/shopify/installations/[installId]` with a `createBrand` payload is rejected with `400`.

## Shopify-Started Install Checklist

- Start install from Shopify Admin or the Shopify app listing.
- Confirm Shopify loads `/shopify` embedded.
- Click `Continue to SQRATCH linking`.
- Complete OAuth.
- If not logged into SQRATCH, confirm redirect to `/login?next=/dashboard/brand/shopify/install?...`.
- Log in or sign up.
- Confirm the pending install resumes and shows the Shopify shop domain.
- Select an existing authorized Brand (installation only links to an existing eligible Brand — it never creates one).
- Confirm the store is linked to `Brand` and not to only the user account.
- Confirm the pending install token is deleted after linking.
- Confirm OAuth HMAC mismatch is rejected.
- Confirm expired or mismatched OAuth state is rejected.
- Log in with a `USER` or `CREATOR` account instead: confirm the pending install is **not** deleted or invalidated, and that "Switch SQRATCH account" signs out of SQRATCH only (not Shopify), returning to the exact same install URL after logging in with an eligible account.

## Product Linking Checklist

- Connect a development Shopify store with at least one active product.
- Open `/dashboard/brand/shopify`.
- Click `Fetch products`.
- Confirm products load from Admin GraphQL API, not REST `/products.json`.
- Confirm only up to 100 active products are shown in the dashboard fetch view.
- Link a Shopify product to a lesson or experience flow where applicable.
- Open the public experience shop view and confirm linked products render.
- Confirm a disconnected or uninstalled Brand does not fetch products.
- Confirm a revoked or invalid token shows a clean error instead of crashing the page.

## Product Edge Cases

- Product with no image: product should render with no image instead of crashing.
- Password-protected development store: a product returned by
  `published_status:published` may have no `onlineStoreUrl`, should use the
  canonical `/products/{handle}` navigation fallback, and must still persist
  as storefront-published after a complete publication scan.
- Product with no variants: product should render with zero variants and no price.
- Product with no price: product should render without showing `$0.00` unless Shopify actually returns `0`.
- Draft or archived product: product should be excluded by the `status:active` Admin GraphQL query.
- Unpublished active product: product should not crash if Shopify omits
  `onlineStoreUrl`, but must stay excluded from public Shop and Lesson views.
- More than 100 active products: dashboard fetch is intentionally limited to the first 100 and should communicate that limit.

## Disconnect And Uninstall Checklist

- Click `Disconnect Shopify` from the Brand dashboard.
- Confirm `shopifyConnectionStatus` becomes `DISCONNECTED`.
- Confirm `shopifyDisconnectedAt` is set.
- Confirm `shopifyAdminAccessTokenEncrypted` is cleared.
- Reconnect the same shop and confirm status returns to `CONNECTED`.
- Trigger `app/uninstalled` from Shopify.
- Confirm webhook HMAC is verified against the raw body before processing.
- Confirm `shopifyConnectionStatus` becomes `UNINSTALLED`.
- Confirm `shopifyUninstalledAt` is set.
- Confirm `shopifyAdminAccessTokenEncrypted` is cleared.
- Send invalid webhook HMAC and confirm the request is rejected.
- Send valid privacy compliance webhooks and confirm they return `200`.

## Phase 15B Lifecycle-History Rollout

`20260821120000_rename_shopify_connection_event_to_commerce_connection_event`
physically renames the lifecycle-history table and columns. The accepted
controlled maintenance window has this compatibility matrix:

| Application revision | Database schema | Result |
| --- | --- | --- |
| Pre-Phase 15B | Pre-Phase 15B | Works |
| Phase 15B | Pre-Phase 15B | Lifecycle paths fail |
| Pre-Phase 15B | Phase 15B | Lifecycle paths fail |
| Phase 15B | Phase 15B | Works |

During the short window, operators must not intentionally perform Shopify
install/reconnect/relink, dashboard or embedded disconnect, `app/uninstalled`,
scope lifecycle transitions, invalid-grant lifecycle recording, or
`shop/redact`. Shopify webhook failures in this interval are expected to be
non-2xx and retried.

1. Record the preflight lifecycle-row fingerprint.
2. Push/deploy the Phase 15B revision first and wait until the Vercel
   production deployment is **Ready**. If it fails before becoming production,
   do not run the migration.
3. Immediately run `npx prisma migrate deploy`.
4. Immediately run the Phase 15B postflight SQL and compare its lifecycle-row
   fingerprint with the preflight fingerprint.
5. If `migrate deploy` errors, stop immediately. Do not retry, run `db push`,
   reset, or manually rename any additional database objects.

## Reward Redemption, Status Refresh, and Reconciliation Checklist

See `docs/points-ledger.md` for the full ledger/account model and `docs/codebase-map.md` (Section F.7–F.9) for the exact transaction sequence; this section covers what to exercise manually.

- Confirm a redemption with sufficient points creates a `ShopifyRewardRedemption` (`PENDING` → `POINTS_DEBITED`) and a matching negative `PointTransaction` inside the same serializable transaction.
- Confirm redeeming with insufficient points is rejected before any Shopify call is made.
- Confirm a repeated request with the same `idempotencyKey` returns the cached result rather than creating a second redemption.
- Confirm a request with the same `idempotencyKey` but a different offer/user is rejected (409).
- Confirm successful discount code creation transitions the redemption to `ISSUED` and returns the code.
- Confirm a Shopify-side failure during discount creation triggers the refund path: points restored, a positive `PointTransaction` created, and the redemption transitions to `REFUNDED` — never left silently `POINTS_DEBITED`.
- Confirm a generated-code collision retries (bounded, 3 attempts) rather than failing the whole redemption.
- Confirm `POST /api/rewards/shopify/redemptions/[id]/refresh-status` re-checks Shopify discount usage and can transition `ISSUED` → `USED`/`EXPIRED`, but only through `assertTransition()`.
- Confirm stuck `POINTS_DEBITED` rows older than the reconciliation minimum age are picked up by `/api/internal/reconcile-redemptions`, resolved to `ISSUED` or refunded to `REFUNDED` exactly once, and that rows exceeding the max-attempts bound are flagged `needsManualReview` rather than retried forever.
- Automated coverage for this flow lives in `tests/shopify-rewards.test.ts` and `tests/reward-reconciliation.test.ts` (mocked persistence/Shopify calls — see `docs/codebase-map.md` Section J for what these tests do and do not exercise).

## Compliance Webhook Checklist

The four compliance/lifecycle webhooks below (`customers/data_request`, `customers/redact`, `shop/redact`, `app/uninstalled`) live under `/api/shopify/webhooks/`, are HMAC-verified via `verifyShopifyWebhookRequest`, and always return `200` once the signature checks out — every outcome for these four topics is deterministic. This is **not** true of every webhook topic this app now subscribes to: the order/refund topics and `app/scopes_update` can legitimately return `500` for a transient persistence failure or an in-flight claim, so Shopify retries — see the Order Ingestion checklist below. See `docs/shopify-data-inventory.md` for the field-by-field data-handling rationale.

- Send each of `customers/data_request`, `customers/redact`, `shop/redact`, and `app/uninstalled` with an invalid HMAC and confirm the request is rejected (non-200) before any processing.
- Confirm `customers/data_request` and `customers/redact` return `200` and write a sanitized audit log entry (topic + shop domain only, no customer PII) without touching any database row — SQRATCH stores no Shopify-customer-keyed data.
- Confirm `shop/redact` for a shop with no matching `Brand` returns `200` without error.
- Confirm `shop/redact` for a shop with a matching connection: anonymizes `ShopifyRewardRedemption` Shopify-specific metadata (discount node id, discount status, user errors) while preserving the redemption's SQRATCH core fields (`userId`, `brandId`, `offerId`, `code`, `pointsCost`, `status`, timestamps); sets matching `BrandRewardOffer` rows inactive; nulls `sourceShopDomain` on offers tied to the redacted domain; scrubs account/currency/client-id snapshots only from `CommerceConnectionEvent` rows where `provider=SHOPIFY`, preserving event type and timestamp and leaving Commerce7 history untouched; deletes orphaned OAuth-state/pending-install `TokenStore` rows for that shop.
- Confirm `app/uninstalled` clears credential/token fields and sets `UNINSTALLED`, but intentionally preserves `shopifyShopDomain` (unlike `shop/redact`) so the same shop can reinstall and relink seamlessly.
- Automated coverage: `tests/integration-coverage.test.ts` (shop/redact temp-token cleanup) and `tests/shopify-connection-transitions.test.ts`.

## Storefront Conversion Tracking (Theme App Extension) Checklist

See `docs/commerce/phase-12-live-order-ingestion-and-conversion-attribution-summary.md` for the full design. The extension (`extensions/sqratch-attribution/`) writes exactly one hidden cart attribute, `_sqratch_ref`, carrying only the opaque click token — never a creator/campaign/experience/lesson/user/brand/connection id.

- Confirm the Brand Shopify status page shows an "Enable conversion tracking" call-to-action once connected, with rows for Shopify connection / Product catalog / Order conversion permission / Storefront conversion tracking (`src/app/(withSidebar)/dashboard/brand/shopify/BrandShopifyClient.tsx`).
- Click the CTA and confirm it opens Shopify's Theme Editor (`/admin/themes/current/editor?context=apps&activateAppId=<api-key>/sqratch-attribution-embed`) in a new tab — never an automatic redirect/popup on the connect flow itself.
- In the Theme Editor, enable the "SQRATCH attribution" app embed block and press Save.
- Click a SQRATCH commerce-click redirect link, confirm the storefront cart carries a `_sqratch_ref` attribute (Ajax cart / `/cart.js`), and confirm it is NOT visible in the normal checkout summary (single leading underscore).
- Complete a test order and confirm the `orders/create` webhook payload's `note_attributes`/`attributes`/`cart_attributes` carries `_sqratch_ref`, and that it correctly attributes (see the Order Ingestion checklist).
- Confirm the "Order access" row reads "Needs approval" before `read_orders` is granted and "Ready" after — this is `orderAttributionReady`, gated on canonical `CommerceConnection.grantedScopes`.

## Order Ingestion / Conversion Attribution Checklist

- Send `orders/create` for a brand-new `providerEventId` and confirm a `CommerceOrder` row is created with attribution linked when the order carries a valid, unexpired, unconsumed `_sqratch_ref` token whose hash matches a `CommerceClickAttribution` row with `redirectedAt` set and a non-null `attributedBrandId` matching the connection's brand.
- Redeliver the identical `orders/create` payload (same `providerEventId`) after the first has fully processed and confirm `200` with no second order/line-item write (`COMPLETED_DUPLICATE`).
- Confirm a webhook delivery that fails signature verification never reaches ingestion and is rejected `401` before any database write.
- Confirm a transient database failure during the order write returns `500` (`WRITE_FAILED`) so Shopify retries, and that retry succeeds once the transient condition clears.
- Confirm a malformed/non-retryable payload (e.g. missing order id) is acknowledged `200` without creating a row, and is not retried by Shopify.
- Confirm `orders/updated` treats an older `providerUpdatedAt` than what's stored as stale and does not overwrite newer state (`SKIPPED_STALE`, `200`).
- Confirm `refunds/create` (and, once a previously-pending refund transaction settles, `order_transactions/create`) triggers a live Shopify Admin GraphQL financial reconciliation — never a value computed from the refund/transaction webhook payload itself — that updates `totalRefundedMinor`/`financialStatus` on the existing order without creating a duplicate order row. `totalRefundedMinor` is the sum of settled (`status: SUCCESS`) `kind: REFUND` order transactions in shop currency; a pending/failed/error transaction must never reduce it.
- Confirm an order with the same connected product on multiple line items counts as one attributed order for that product in conversion analytics (`attributedOrdersByProduct`), not one per line item.
- Confirm no points, creator commission, or payout is triggered by any order/refund webhook — `orders/create` is a normalized snapshot, not a settlement event.
- Automated coverage: `tests/order-ingestion.test.ts`, `tests/shopify-order-webhook.test.ts`, `tests/order-analytics.test.ts`, `tests/shopify-order-normalizer.test.ts`.

## App Store Submission Checklist

- Confirm scopes contain `read_products`, `read_orders`, `read_themes`, `read_discounts`, and `write_discounts` — and no broader order scope (`read_all_orders`, `write_orders`) or theme write scope (`write_themes`).
- Confirm the app is embedded.
- Confirm app URL and OAuth redirect URL are HTTPS production URLs.
- Confirm privacy compliance webhooks are configured and return `200` for valid HMAC requests.
- Confirm uninstall webhook clears token access.
- Confirm the app does not write or mutate Shopify products or orders.
- Confirm the app explains that products are displayed in SQRATCH experiences.
- Confirm the privacy policy and support/contact URLs are set in Shopify Partner Dashboard.
- Confirm test credentials and test instructions are ready for Shopify review.
