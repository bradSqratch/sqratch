# Environment Variables

Use separate Vercel values for Development, Preview, and Production. Never place server credentials in `NEXT_PUBLIC_*`. `.env.example` in the repository root is the copy-and-fill template; this document explains what each variable does, where it's read, and how it's classified.

This inventory was produced by searching the repository for every `process.env.*` reference (`rg -o 'process\.env\.[A-Z_0-9]+' src prisma prisma.config.ts next.config.ts`), not by re-transcribing an earlier version of this document.

## Database

| Variable | Classification | Read in | Notes |
|---|---|---|---|
| `DATABASE_URL` | Required locally, production-supplied | `src/lib/prisma.ts`, `prisma.config.ts` | Pooled PostgreSQL connection string used by the application at runtime. |
| `DIRECT_URL` | Required locally, production-supplied | `prisma.config.ts` | Direct (non-pooled) connection used by Prisma CLI workflows (`migrate`, `db push`). Falls back to `DATABASE_URL` if unset. |
| `PG_POOL_MAX` | Optional locally | `src/lib/prisma.ts` | Pool size. Defaults to `1` on Vercel, `5` otherwise. |
| `PG_IDLE_TIMEOUT_MS` | Optional locally | `src/lib/prisma.ts` | Defaults to `30000`. |
| `PG_CONNECT_TIMEOUT_MS` | Optional locally | `src/lib/prisma.ts` | Defaults to `10000`. |
| `PG_SSL_REJECT_UNAUTHORIZED` | Optional locally | `src/lib/prisma.ts` | Set to `false` to accept a self-signed cert (e.g. a disposable local Postgres with SSL enabled). Defaults to `true` (reject unauthorized). |

## Authentication

| Variable | Classification | Read in | Notes |
|---|---|---|---|
| `NEXTAUTH_SECRET` | Required locally, production-supplied | `src/app/api/auth/[...nextauth]/options.ts`, `src/lib/auth/auth-security.ts` | Signs NextAuth JWT sessions. Rotating it invalidates active sessions; it does not affect Shopify credential decryption. |
| `NEXTAUTH_URL` | Required locally, production-supplied | `src/lib/shopify.ts` (URL fallback chain) | Canonical app origin for NextAuth callbacks. |
| `EMAIL_VERIFICATION_CODE_PEPPER` | Required locally, production-supplied | `src/lib/auth/email-verification-crypto.ts` | Server-only HMAC pepper for six-digit email verification codes. Use a randomly generated 32-byte-or-longer value; production must not issue verification codes without it. |
| `DOMAIN` | Required locally, production-supplied | `src/helpers/mailer.ts`, QR export/batch routes | Canonical application origin used to build links in emails and exported QR content. |
| `NEXT_PUBLIC_APP_URL` | Optional locally | `src/lib/shopify.ts`, QR export/batch routes | Fallback origin, used if `SHOPIFY_APP_URL`/`DOMAIN`/`NEXTAUTH_URL` aren't authoritative for a given call site. |

## Encryption

| Variable | Classification | Read in | Notes |
|---|---|---|---|
| `APP_ENCRYPTION_KEY` | Required for Shopify features, production-supplied | `src/lib/crypto.ts` | Stable, server-only secret used to encrypt Shopify access and refresh tokens at rest (AES-256-GCM). Must be generated and managed independently from `NEXTAUTH_SECRET`. Rotating it makes existing encrypted credentials unreadable and requires a credential migration or store reconnection. |

## Shopify

| Variable | Classification | Read in | Notes |
|---|---|---|---|
| `SHOPIFY_APP_DISTRIBUTION` | Required for Shopify features | `src/app/shopify/route.ts`, `src/app/api/shopify/embedded/session/route.ts`, brand Shopify page | `public` for the reviewed app (`shopify.app.toml`) or `custom` for the test app (`shopify.app.custom.toml`). Controls App Bridge token exchange vs. legacy OAuth. |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` | Required for Shopify features, production-supplied | `src/lib/shopify.ts`, `src/lib/shopify-webhooks.ts`, `src/lib/shopify-session-token.ts`, `src/lib/shopify-token-manager.ts`, OAuth/embedded routes | Client ID/secret for the selected Shopify app. `SHOPIFY_API_SECRET` also verifies inbound webhook and session-token HMACs. Do not mix client IDs between public and custom apps. |
| `SHOPIFY_APP_URL` | Required for Shopify features, production-supplied | `src/lib/shopify.ts` | Canonical HTTPS origin, e.g. `https://www.sqratch.com` in production. |
| `SHOPIFY_REDIRECT_URI` | **Stale — unused** | — | Not referenced anywhere in the codebase (confirmed by repository-wide search). The OAuth redirect URL is derived from `SHOPIFY_APP_URL` plus a hardcoded path. Removed from `.env.example`. |

**Scopes are not configured through an environment variable.** There is no `SHOPIFY_SCOPES` (or similarly named) variable read anywhere in the codebase — confirmed by repository-wide search — so it has been removed from `.env.example`. The required scopes, `read_products,read_discounts,write_discounts`, are instead hardcoded/configured independently in three places and must be kept aligned across all three by hand whenever they change:

- `src/lib/shopify.ts` — the `SHOPIFY_SCOPES` constant, which the application code actually reads at runtime.
- `shopify.app.toml` — the `[access_scopes]` block for the public (reviewed) app.
- `shopify.app.custom.toml` — the `[access_scopes]` block for the custom test app.

Deploy TOML config explicitly with `shopify app deploy --config shopify.app.toml` or `shopify app deploy --config shopify.app.custom.toml`. If these three drift out of alignment, the app can request or be granted a different scope set than the code expects.

## Supabase / storage

| Variable | Classification | Read in | Notes |
|---|---|---|---|
| `SUPABASE_STORAGE_URL` | Required for uploads | `src/lib/storage-upload.ts`, `next.config.ts` | Supabase project URL for storage. `NEXT_PUBLIC_SUPABASE_URL` is an accepted fallback. |
| `SUPABASE_STORAGE_SERVICE_ROLE_KEY` | Required for uploads, production-supplied | `src/lib/storage-upload.ts` | Server-only service-role key for storage writes. `SUPABASE_SERVICE_ROLE_KEY` is an accepted fallback. Never expose to the client. |
| `SUPABASE_EXPERIENCE_COVER_BUCKET`, `SUPABASE_LESSON_VIDEO_BUCKET`, `SUPABASE_CAMPAIGN_VIDEO_BUCKET`, `SUPABASE_USER_AVATAR_BUCKET`, `SUPABASE_BRAND_ASSET_BUCKET` | Optional locally (each has a code default) | `src/lib/storage-upload.ts` and per-purpose upload routes | Bucket names; override only if your Supabase project uses different bucket names than the defaults shown in `.env.example`. |
| `MAX_UPLOAD_MB` | Optional locally | `src/lib/storage-upload.ts` | General upload size cap in MB. Defaults to `5`. |
| `MAX_VIDEO_UPLOAD_MB` | Optional locally | `src/lib/storage-upload.ts` | Video upload size cap in MB. Defaults to `250`. |
| `LESSON_VIDEO_SIGNED_URL_TTL_SECONDS` | Optional locally (feature tuning) | `src/lib/lesson-video-playback.ts` | How long a signed lesson-video playback URL stays valid. Falls back to a code default and is bounded to a maximum if set too high. |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | Optional (only used by QR-batch image generation/deletion routes) | `src/app/api/qr/*`, `src/app/api/brand/qr-batches/*`, `src/app/api/brand/qr-codes/*` | Legacy asset-hosting credentials for QR code images. |

## Email

| Variable | Classification | Read in | Notes |
|---|---|---|---|
| `MAILTRAP_HOST`, `MAILTRAP_PORT`, `MAILTRAP_USER`, `MAILTRAP_PASSWORD` | Required for email, production-supplied | `src/helpers/mailer.ts` | Current SMTP delivery configuration (Mailtrap-compatible). |
| `ADMIN_EMAIL` | Required for email, production-supplied | `src/helpers/mailer.ts` | From-address for transactional/admin emails. |

## Internal cron / workers

| Variable | Classification | Read in | Notes |
|---|---|---|---|
| `CRON_SECRET` | Required for scheduled jobs, production-supplied | `src/app/api/internal/email-worker/route.ts`, `src/app/api/internal/reconcile-redemptions/route.ts` | Required in the `x-cron-secret` header for the email and redemption-reconciliation workers. |

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

## Analytics

| Variable | Classification | Read in | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_GA_ID` | Optional | `src/app/layout.tsx`, `src/components/GoogleAnalytics.tsx` | Google Analytics measurement ID. Not a secret (it's client-visible by design), but use a placeholder in shared/template configuration rather than a production-specific ID. |

## Seed script (local/dev only)

| Variable | Classification | Read in | Notes |
|---|---|---|---|
| `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` | Optional locally | `prisma/seed.ts` | Credentials for the admin user the seed script creates. |
| `ALLOW_PROD_SEED` | Never set in production | `prisma/seed.ts` | The seed script refuses to run when `NODE_ENV=production` unless this is explicitly `true`. Leave unset. |

## Runtime-detected (not user-configured)

`NODE_ENV` and `VERCEL` are read in several places (`src/lib/prisma.ts`, `src/lib/shopify.ts`, `src/lib/session.ts`, `src/lib/brand-context.ts`, dev-only route guards) but are set by the runtime/platform, not by an operator — do not add them to `.env`/`.env.example`.

## Rate Limiting

The current limiter is a bounded, in-memory best-effort fallback. It is not deployment-wide on Vercel. No durable Redis/KV service is configured in this repository. Before high-volume campaigns, provision an approved shared limiter and preserve fail-open behavior for QR scans while using stricter behavior for account/email and OAuth endpoints.

## Authentication hardening

Verification challenges expire after 10 minutes and are exhausted after five failed codes. Resending replaces the previous challenge. The migration `20260716120000_harden_auth_sessions_and_verification` invalidates legacy outstanding challenges because plaintext six-digit values cannot be converted safely; affected unverified users must request a new code. Password creation and changes use the shared 8–72 character letter-and-number policy, and changing a password revokes existing JWT sessions through `User.sessionVersion`.

The active brand is held in the HttpOnly `sqratch_active_brand_id` cookie and is always checked against current `BrandMember` membership. Multi-brand users must select a brand; no membership is selected implicitly. Global `ADMIN` users may select any brand through the same server-validated context, but still do not receive an implicit first brand. Brand-scoped APIs return `409 ACTIVE_BRAND_REQUIRED` until selection is made. Membership roles remain per-brand: `VIEWER` cannot write, and the existing `ADMIN`/`MANAGER` management split is preserved rather than granting either role access to another brand. Durable Upstash-based rate limiting remains future work.

Embedded Shopify HTML responds with a validated `frame-ancestors` policy for the requested `*.myshopify.com` shop plus `https://admin.shopify.com`; missing or malformed shops receive the admin-only fallback. Shopify relinking performs all pending-install consumption, membership validation, old-owner release, and destination assignment in one serializable transaction after external Shopify reads complete. Unique/serialization races return a controlled conflict.

`POST /api/public/session` returns only `{ "ok": true }`; the anonymous identifier remains in the HttpOnly `sqr_session` cookie, which is accepted only when it matches the expected 48-character hex format. Responses are marked `Cache-Control: no-store`.
