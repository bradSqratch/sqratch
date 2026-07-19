# Shopify Production Testing

The public app uses App Bridge session tokens, token exchange, and expiring offline-token rotation. The custom test app remains `LEGACY_OFFLINE`. Use the matching TOML and credentials for each flow; never mix public and custom client IDs.

This app reads Shopify products for display, and creates single-use Shopify discount codes when a user redeems SQRATCH points (`write_discounts`) — it never writes or mutates products. Redemption status is polled and reconciled against Shopify after issuance. Store ownership is tied to `Brand`, not the individual user. For the detailed redemption/refund transaction and reconciliation logic, see `docs/points-ledger.md` and `docs/codebase-map.md` (Section F: "Shopify Reward Redemption", "Reward State Machine", "Stuck-Redemption Reconciliation").

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
- Access scopes: `read_products`, `read_discounts`, and `write_discounts` only.
- Admin API version: match `SHOPIFY_API_VERSION` in `src/lib/shopify.ts`.
- App uninstall webhook: `https://www.sqratch.com/api/shopify/webhooks/app/uninstalled`.
- Customer data request webhook: `https://www.sqratch.com/api/shopify/webhooks/customers/data_request`.
- Customer redact webhook: `https://www.sqratch.com/api/shopify/webhooks/customers/redact`.
- Shop redact webhook: `https://www.sqratch.com/api/shopify/webhooks/shop/redact`.

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
- Confirm OAuth asks only for product read access.
- Complete OAuth and confirm redirect to `/dashboard/brand/shopify/install?install=...` if brand selection is needed.
- Select or create the Brand.
- Confirm redirect to `/dashboard/brand/shopify?connected=1`.
- Confirm Brand status is `CONNECTED`.
- Confirm encrypted token is saved only on `Brand`.
- Confirm creators who are not authorized Brand Admins or Brand Members cannot connect a store.

## Shopify-Started Install Checklist

- Start install from Shopify Admin or the Shopify app listing.
- Confirm Shopify loads `/shopify` embedded.
- Click `Continue to SQRATCH linking`.
- Complete OAuth.
- If not logged into SQRATCH, confirm redirect to `/login?next=/dashboard/brand/shopify/install?...`.
- Log in or sign up.
- Confirm the pending install resumes and shows the Shopify shop domain.
- Select an existing authorized Brand or create a Brand when the SQRATCH role allows it.
- Confirm the store is linked to `Brand` and not to only the user account.
- Confirm the pending install token is deleted after linking.
- Confirm OAuth HMAC mismatch is rejected.
- Confirm expired or mismatched OAuth state is rejected.

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
- Product with no `onlineStoreUrl`: product should use the safe `/products/{handle}` fallback.
- Product with no variants: product should render with zero variants and no price.
- Product with no price: product should render without showing `$0.00` unless Shopify actually returns `0`.
- Draft or archived product: product should be excluded by the `status:active` Admin GraphQL query.
- Unpublished active product: product should not crash if Shopify omits `onlineStoreUrl`.
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

All four webhooks live under `/api/shopify/webhooks/`, are HMAC-verified via `verifyShopifyWebhookRequest`, and must return `200` even when no action is needed. See `docs/shopify-data-inventory.md` for the field-by-field data-handling rationale.

- Send each of `customers/data_request`, `customers/redact`, `shop/redact`, and `app/uninstalled` with an invalid HMAC and confirm the request is rejected (non-200) before any processing.
- Confirm `customers/data_request` and `customers/redact` return `200` and write a sanitized audit log entry (topic + shop domain only, no customer PII) without touching any database row — SQRATCH stores no Shopify-customer-keyed data.
- Confirm `shop/redact` for a shop with no matching `Brand` returns `200` without error.
- Confirm `shop/redact` for a shop with a matching `Brand`: nulls the brand's Shopify credentials and `shopifyShopDomain`; anonymizes `ShopifyRewardRedemption` Shopify-specific metadata (discount node id, discount status, user errors) while preserving the redemption's SQRATCH core fields (`userId`, `brandId`, `offerId`, `code`, `pointsCost`, `status`, timestamps); sets the brand's `BrandRewardOffer` rows `isActive: false`; nulls `sourceShopDomain` on any `BrandRewardOffer`/`ExperienceProductLink`/`LessonProductLink` row that referenced the redacted domain, across all brands; scrubs the domain/currency/client-id out of `ShopifyConnectionEvent` history while preserving the event type and timestamp; deletes orphaned OAuth-state/pending-install `TokenStore` rows for that shop.
- Confirm `app/uninstalled` clears credential/token fields and sets `UNINSTALLED`, but intentionally preserves `shopifyShopDomain` (unlike `shop/redact`) so the same shop can reinstall and relink seamlessly.
- Automated coverage: `tests/integration-coverage.test.ts` (shop/redact temp-token cleanup) and `tests/shopify-connection-transitions.test.ts`.

## App Store Submission Checklist

- Confirm scopes contain only `read_products`, `read_discounts`, and `write_discounts`.
- Confirm the app is embedded.
- Confirm app URL and OAuth redirect URL are HTTPS production URLs.
- Confirm privacy compliance webhooks are configured and return `200` for valid HMAC requests.
- Confirm uninstall webhook clears token access.
- Confirm the app does not write or mutate Shopify products.
- Confirm the app explains that products are displayed in SQRATCH experiences.
- Confirm the privacy policy and support/contact URLs are set in Shopify Partner Dashboard.
- Confirm test credentials and test instructions are ready for Shopify review.
