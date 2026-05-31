# Shopify Production Testing

This app uses Shopify only to read and display products in SQRATCH. Store ownership is tied to `Brand`, not the individual user.

## Vercel Environment Variables

- `SHOPIFY_API_KEY`: Shopify app client ID/API key.
- `SHOPIFY_API_SECRET`: Shopify app client secret. Used for OAuth and webhook HMAC verification.
- `SHOPIFY_SCOPES`: Must be exactly `read_products`.
- `SHOPIFY_APP_URL`: Production app origin, for example `https://sqratch.com`.
- `NEXTAUTH_URL`: Production app origin, for example `https://sqratch.com`.
- `NEXTAUTH_SECRET`: Required by auth and used as an encryption fallback.
- `APP_ENCRYPTION_KEY`: Preferred stable key for encrypting Shopify access tokens. Do not rotate without a token migration plan.
- `DATABASE_URL`: Production database URL.
- `DIRECT_URL`: Required only if your Prisma migration workflow needs a direct database connection.

Do not add product write scopes unless the product requirements change.

## Shopify Partner Dashboard Settings

- App URL: `https://sqratch.com/shopify`.
- Embedded app: enabled.
- Allowed redirection URL: `https://sqratch.com/api/shopify/oauth/callback`.
- Access scopes: `read_products` only.
- Admin API version: match `SHOPIFY_API_VERSION` in `src/lib/shopify.ts`.
- App uninstall webhook: `https://sqratch.com/api/shopify/webhooks/app/uninstalled`.
- Customer data request webhook: `https://sqratch.com/api/shopify/webhooks/customers/data_request`.
- Customer redact webhook: `https://sqratch.com/api/shopify/webhooks/customers/redact`.
- Shop redact webhook: `https://sqratch.com/api/shopify/webhooks/shop/redact`.

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

## App Store Submission Checklist

- Confirm scopes contain only `read_products`.
- Confirm the app is embedded.
- Confirm app URL and OAuth redirect URL are HTTPS production URLs.
- Confirm privacy compliance webhooks are configured and return `200` for valid HMAC requests.
- Confirm uninstall webhook clears token access.
- Confirm the app does not write or mutate Shopify products.
- Confirm the app explains that products are displayed in SQRATCH experiences.
- Confirm the privacy policy and support/contact URLs are set in Shopify Partner Dashboard.
- Confirm test credentials and test instructions are ready for Shopify review.
