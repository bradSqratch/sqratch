# Environment Variables

Use separate Vercel values for Development, Preview, and Production. Never place server credentials in `NEXT_PUBLIC_*`.

## Core

- `DATABASE_URL`: pooled PostgreSQL URL used by the application.
- `DIRECT_URL`: direct PostgreSQL URL used by Prisma CLI workflows.
- `NEXTAUTH_SECRET`, `NEXTAUTH_URL`: NextAuth signing secret and canonical URL.
- `DOMAIN`, `APP_BASE_URL`: canonical application origin.
- `APP_ENCRYPTION_KEY`: stable secret used to encrypt Shopify credentials. Rotating it requires a credential migration or reconnect.

## Shopify

- `SHOPIFY_APP_DISTRIBUTION`: `public` for the reviewed app or `custom` for the test app.
- `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`: credentials for the selected Shopify app.
- `SHOPIFY_APP_URL`: canonical HTTPS origin, `https://www.sqratch.com` in production.
- Public config: `shopify.app.toml`.
- Custom config: `shopify.app.custom.toml`.
- Required scopes: `read_products,read_discounts,write_discounts`.

Deploy config explicitly with `shopify app deploy --config shopify.app.toml` or `shopify app deploy --config shopify.app.custom.toml`. Do not mix client IDs between environments.

## Internal Operations

- `CRON_SECRET`: required in `x-cron-secret` for email and redemption reconciliation workers.
- `MAILTRAP_HOST`, `MAILTRAP_PORT`, `MAILTRAP_USER`, `MAILTRAP_PASSWORD`, `ADMIN_EMAIL`: current SMTP delivery configuration.
- Supabase and Cloudinary variables are documented in `.env.example`; service-role and API secrets remain server-only.

## Rate Limiting

The current limiter is a bounded, in-memory best-effort fallback. It is not deployment-wide on Vercel. No durable Redis/KV service is configured in this repository. Before high-volume campaigns, provision an approved shared limiter and preserve fail-open behavior for QR scans while using stricter behavior for account/email and OAuth endpoints.
