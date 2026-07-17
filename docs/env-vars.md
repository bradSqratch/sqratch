# Environment Variables

Use separate Vercel values for Development, Preview, and Production. Never place server credentials in `NEXT_PUBLIC_*`.

## Core

- `DATABASE_URL`: pooled PostgreSQL URL used by the application.
- `DIRECT_URL`: direct PostgreSQL URL used by Prisma CLI workflows.
- `NEXTAUTH_SECRET`, `NEXTAUTH_URL`: NextAuth session-signing secret and canonical URL. Rotate `NEXTAUTH_SECRET` independently to invalidate authentication sessions; it does not affect Shopify credential decryption.
- `EMAIL_VERIFICATION_CODE_PEPPER`: server-only HMAC pepper for email verification codes. Use a randomly generated 32-byte-or-longer value; production must not start verification issuance without it.
- `DOMAIN`, `APP_BASE_URL`: canonical application origin.
- `APP_ENCRYPTION_KEY`: stable, server-only secret used to encrypt Shopify access and refresh tokens. It must be independently generated and managed from `NEXTAUTH_SECRET`. Rotating it makes existing encrypted credentials unreadable and requires a credential migration or store reconnection.

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

Supabase Cron is manually managed outside this repository. It calls `POST /api/internal/email-worker` every five minutes and `POST /api/internal/reconcile-redemptions` every ten minutes, each with `x-cron-secret: <CRON_SECRET>`. Do not add Vercel Cron configuration for either worker.

The welcome-email worker retries transient delivery failures after 5 minutes, 15 minutes, 1 hour, and 6 hours. Its fifth actual send attempt is terminal `FAILED`; stale `SENDING` claims are recovered after 15 minutes using the same schedule. To inspect terminal jobs, filter `EmailQueue` by `template = 'WELCOME'` and `status = 'FAILED'`. After correcting the underlying delivery issue, an operator may intentionally requeue one reviewed job (never a broad set) with this controlled update; the worker revalidates eligibility before sending:

```sql
UPDATE "EmailQueue"
SET "status" = 'PENDING', "attempts" = 0, "nextAttemptAt" = NULL,
    "claimedAt" = NULL, "lastError" = 'Manually requeued after review.'
WHERE "id" = :reviewed_job_id
  AND "template" = 'WELCOME'
  AND "status" = 'FAILED'
  AND "sentAt" IS NULL;
```

## Rate Limiting

The current limiter is a bounded, in-memory best-effort fallback. It is not deployment-wide on Vercel. No durable Redis/KV service is configured in this repository. Before high-volume campaigns, provision an approved shared limiter and preserve fail-open behavior for QR scans while using stricter behavior for account/email and OAuth endpoints.

## Authentication hardening

Verification challenges expire after 10 minutes and are exhausted after five failed codes. Resending replaces the previous challenge. The migration `20260716120000_harden_auth_sessions_and_verification` invalidates legacy outstanding challenges because plaintext six-digit values cannot be converted safely; affected unverified users must request a new code. Password creation and changes use the shared 8–72 character letter-and-number policy, and changing a password revokes existing JWT sessions through `User.sessionVersion`.

The active brand is held in the HttpOnly `sqratch_active_brand_id` cookie and is always checked against current `BrandMember` membership. Multi-brand users must select a brand; no membership is selected implicitly. Global `ADMIN` users may select any brand through the same server-validated context, but still do not receive an implicit first brand. Brand-scoped APIs return `409 ACTIVE_BRAND_REQUIRED` until selection is made. Membership roles remain per-brand: `VIEWER` cannot write, and the existing `ADMIN`/`MANAGER` management split is preserved rather than granting either role access to another brand. Durable Upstash-based rate limiting remains future work.

Embedded Shopify HTML responds with a validated `frame-ancestors` policy for the requested `*.myshopify.com` shop plus `https://admin.shopify.com`; missing or malformed shops receive the admin-only fallback. Shopify relinking performs all pending-install consumption, membership validation, old-owner release, and destination assignment in one serializable transaction after external Shopify reads complete. Unique/serialization races return a controlled conflict.

`POST /api/public/session` returns only `{ "ok": true }`; the anonymous identifier remains in the HttpOnly `sqr_session` cookie, which is accepted only when it matches the expected 48-character hex format. Responses are marked `Cache-Control: no-store`.
