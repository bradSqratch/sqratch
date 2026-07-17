# SQRATCH — Agent Context Reference

> Quick-start guide for AI agents. Read this before touching any code.
> For full details see `docs/codebase-map.md`.

---

## What is SQRATCH?

A Next.js 15 + Prisma 7 + Supabase app. Brands print physical QR stickers; users scan them with their phone, unlock campaign experiences (video courses, posts, Q&A), earn loyalty points, and redeem those points for Shopify discount codes.

**Three user roles that matter most:**
- `ADMIN` — SQRATCH internal staff; full access
- `BRAND_ADMIN` — brand operators; manage campaigns, Shopify, rewards
- `USER` / `CREATOR` — end users and content creators

---

## Fastest Way to Understand What a File Does

| Question | How to answer |
|---|---|
| What does this API route do? | Check which auth helper it calls at the top (see Auth Contracts below) |
| Does this touch money/points? | Check for `PointTransaction`, `ShopifyRewardRedemption`, `User.points` |
| Does this talk to Shopify? | Check for `shopify-discounts.ts`, `shopify-products.ts`, `shopify-token-manager.ts`, or `shopify.ts` imports |
| Is this GDPR-relevant? | Shopify webhook routes under `/api/shopify/webhooks/` |
| Is this on the critical user path? | Routes under `/api/public/` and `/api/rewards/` |
| Is this rate-limited? | Check for `rateLimit()` import from `src/lib/rate-limit.ts` |

---

## Auth Contracts (read before every API edit)

| Helper | File | Meaning when it returns null |
|---|---|---|
| `getAdminContext()` | `src/lib/admin-auth.ts` | Not logged in OR not `ADMIN` role → return 401 |
| `getBrandAdminContext()` | `src/lib/brand-auth.ts` | Not `BRAND_ADMIN` role → return 401/403 |
| `getBrandManagementContext()` | `src/lib/brand-auth.ts` | No session at all → return 401 |
| `resolveSession()` | `src/lib/auth-session.ts` | Unauthenticated → null session (centralised; test-hookable) |
| `resolveBrandAdminContext()` | `src/lib/auth-session.ts` | Not brand admin → null (centralised; test-hookable) |
| `getServerSession(authOptions)` | next-auth | Unauthenticated → null session |
| `getExperienceAccessContext()` | `src/lib/experience-access.ts` | Experience not found |
| `getRewardClaimContext()` | `src/lib/reward-access.ts` | User hasn't unlocked required campaign |

**JWT lifecycle:** maxAge 7 days. Every 5 minutes the JWT callback re-reads `role`, `isActive`, `isEmailVerified` from DB. Deactivated users get forced sign-out (`null` return). All emails normalised to lowercase.

Middleware (`src/middleware.ts`) only protects `/dashboard/**`, `/admin/**` page routes — **it does not protect API routes**. API routes are individually responsible for auth checks.

---

## The 7 Files You Must Read Before Any Shopify Change

1. `src/lib/shopify.ts` — API version (`2026-04`), OAuth helpers, HMAC, scopes
2. `src/lib/shopify-session-token.ts` — App Bridge JWT verifier (signature-first, timing-safe)
3. `src/lib/shopify-token-manager.ts` — Token lifecycle: legacy/expiring, CAS-locked refresh, scope check
4. `src/lib/crypto.ts` — AES-256-GCM; key from `APP_ENCRYPTION_KEY`
5. `src/lib/shopify-webhooks.ts` — HMAC verification for all inbound webhooks
6. `src/lib/shopify-discounts.ts` — GraphQL mutations for discount code creation
7. `src/app/api/rewards/shopify/redeem/route.ts` — full redemption transaction

**Hard rules:**
- Never log or return the decrypted Shopify access token or refresh token
- Never remove `timingSafeEqual` / `timingSafeBase64urlEqual` from HMAC checks
- Never change `SHOPIFY_API_VERSION` without testing all GraphQL calls
- All 4 GDPR webhooks must always return HTTP 200
- Scopes must remain exactly: `read_products`, `read_discounts`, `write_discounts`
- Webhooks are TOML-managed (`shopify.app.toml`) — `registerShopifyWebhooks()` was removed

**Two distribution modes:**
- `SHOPIFY_APP_DISTRIBUTION=public` → App Bridge session token → token exchange → expiring offline tokens
- `SHOPIFY_APP_DISTRIBUTION=custom` → OAuth code exchange → legacy non-expiring offline tokens

---

## The 6 Files You Must Read Before Any Points / Rewards Change

1. `src/lib/reward-redemption-state.ts` — formal state machine (ALLOWED_TRANSITIONS, terminal, refresh, reconciliation)
2. `src/lib/reward-reconciliation.ts` — exactly-once stuck-redemption recovery + refund
3. `src/lib/points.ts` — `awardQrScanPoint()` with unique-constraint idempotency
4. `src/lib/reward-offers.ts` — availability check, code generation
5. `src/lib/reward-access.ts` — brand unlock eligibility gate
6. `src/app/api/rewards/shopify/redeem/route.ts` — serializable TX + refund path

**Hard rules:**
- `User.points` must always be modified with a matching `PointTransaction` row in the same transaction
- Never remove `isolationLevel: Serializable` from the redeem transaction
- Never remove the `debit.count !== 1` race-condition guard
- `PointTransaction` rows are an immutable audit ledger — never delete them
- Never weaken the composite unique `(shopifyRewardRedemptionId, reason)` — exactly-once refund guard
- Never alter accepted reconciliation/state-machine code without a new test proving a defect

**State machine:** PENDING → POINTS_DEBITED → ISSUED → USED/EXPIRED. FAILED/REFUNDED/CANCELLED are terminal. Reconciliation handles stuck POINTS_DEBITED (CAS lock, limit 20, 5 min age, max 5 attempts → manual review).

---

## The 3 Files You Must Read Before Any QR / Scan Change

1. `src/lib/qr-redemption.ts` — atomic `updateMany` QR status transition
2. `src/app/api/public/scan/route.ts` — full scan handler with session, unlock, points
3. `prisma/schema.prisma` → `QRCode`, `CampaignUnlock`, `PointTransaction` models

**Hard rules:**
- `QRCode` status changes (`NEW → USED`) must go through `redeemQrCodeForUser()` only
- The `status: "NEW"` filter in `updateMany` is the atomic double-redemption guard — never remove it
- `CampaignUnlock` has `@@unique([campaignId, userId])` — one unlock per user per campaign
- Anonymous unlock dedup uses a partial unique index (Postgres-only, migration `20260615113320`)

---

## The 3 Files You Must Read Before Any Experience Page Change

1. `src/lib/experience-access.ts` — viewer context, unlock status, creator ownership check
2. `src/lib/session.ts` — `sqr_session` anonymous cookie tracking
3. `src/components/experience/experience-shell.tsx` — shared layout for all `/x/` pages

**Hard rules:**
- Anonymous viewers (not logged in) use `sqr_session` cookie for progress tracking — don't break this
- Experience pages must work for anonymous users (QR scanned by non-logged-in user)
- `canAccessPrivate` and `canInteract` flags in `ExperienceAccessContext` control gating

---

## Rate Limiting

In-memory fixed-window limiter (`src/lib/rate-limit.ts`). Per-instance on Vercel serverless — not deployment-wide.

| Endpoint | Key | Limit | Window |
|---|---|---|---|
| `/api/auth/signup` | `signup:{ip}` | 5 | 15 min |
| `/api/auth/send-email-verification` | `send-verify-email:{ip}` | 5 | 15 min |
| `/api/public/waitlist` | `waitlist:{ip}` | 10 | 60 min |
| `/api/shopify/oauth/start` | `shopify-oauth-start:{ip}` | 20 | 60 min |
| `/api/public/scan` | `scan:{ip}` | 60 | 60 min |

For production-wide enforcement, replace with Upstash Redis or Vercel KV.

---

## Key Env Vars Quick Reference

| Var | Used In | Critical? |
|---|---|---|
| `DATABASE_URL` | Prisma (pooled) | Yes |
| `DIRECT_URL` | Prisma (migrations) | Yes |
| `NEXTAUTH_SECRET` | NextAuth/JWT session signing | Yes — rotating invalidates authentication sessions, not Shopify credentials |
| `APP_ENCRYPTION_KEY` | `src/lib/crypto.ts` — Shopify access and refresh token encryption | Yes — rotating makes stored credentials unreadable until migrated or stores reconnect |
| `SHOPIFY_API_KEY` | OAuth start/callback, session token verification | Yes for Shopify features |
| `SHOPIFY_API_SECRET` | HMAC verification (OAuth + webhooks) | Yes — must match Shopify partner dashboard |
| `SHOPIFY_APP_URL` | OAuth redirect base URL | Yes — must be public HTTPS URL |
| `SHOPIFY_APP_DISTRIBUTION` | `public` or `custom` — controls auth flow | Yes — determines token exchange vs legacy OAuth |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side storage uploads | Yes for uploads |
| `CRON_SECRET` | `x-cron-secret` header for internal workers | Yes for email + reconciliation cron |
| `MAILTRAP_HOST`, `MAILTRAP_USER`, `MAILTRAP_PASSWORD` | SMTP email delivery | Yes for emails |

See `docs/env-vars.md`, `docs/prisma-migrations.md`, `docs/points-ledger.md`, and `docs/reward-reconciliation.md` before production operations.

---

## URL Pattern Cheat Sheet

| Pattern | What it serves |
|---|---|
| `/q/[qrCodeData]` | QR scan entry (physical sticker URL) |
| `/c/[campaignSlug]` | Campaign landing page after scan |
| `/x/[experienceSlug]` | Public experience hub |
| `/x/[experienceSlug]/shop` | Experience Shopify product + reward shop |
| `/shopify` | Embedded app shell (Shopify Admin → install) |
| `/dashboard/brand/shopify` | Shopify integration management |
| `/api/shopify/oauth/start` | Begin Shopify OAuth (rate limited) |
| `/api/shopify/oauth/callback` | Shopify OAuth return |
| `/api/shopify/embedded/session` | App Bridge token exchange (public distribution) |
| `/api/shopify/installations/[id]` | Confirm Shopify install + link to brand |
| `/api/shopify/webhooks/*` | Inbound Shopify webhooks (HMAC-verified, no JWT) |
| `/api/rewards/shopify/redeem` | POST — debit points + issue discount code |
| `/api/rewards/shopify/redemptions` | GET — user's redemption history |
| `/api/rewards/shopify/redemptions/[id]/refresh-status` | POST — re-check discount usage |
| `/api/internal/reconcile-redemptions` | POST — cron reconciliation of stuck redemptions |
| `/api/internal/email-worker` | POST — cron email queue processor |
| `/api/public/scan` | POST — process QR scan (rate limited) |

---

## Common Gotchas

1. **Webhook routes bypass middleware JWT** — intentional (`src/middleware.ts:7`). They are HMAC-verified instead.
2. **`User.points` is a denormalized cache** — the ledger is `PointTransaction`. Always write both.
3. **`TokenStore` is a multi-purpose key-value store** — Shopify OAuth state and pending install tokens (both LEGACY and EXPIRING shapes) both live here with different `service` key prefixes.
4. **`CampaignUnlock` supports both authenticated and anonymous users** — `userId` is nullable; `anonKey` is used for anonymous. Both must be handled in any unlock-checking logic.
5. **next-auth v4 with App Router** — uses `getServerSession(authOptions)` (server components/routes), not `useSession` (client only). Mixing these up is a common source of auth bugs.
6. **Shopify GraphQL API version** is `2026-04` (set in `src/lib/shopify.ts:SHOPIFY_API_VERSION`). Never hardcode it elsewhere.
7. **Credential and session secrets are independent**: `APP_ENCRYPTION_KEY` is the sole server-only key for Shopify access and refresh token encryption. `NEXTAUTH_SECRET` signs application authentication sessions. Generate and manage them separately: rotating `NEXTAUTH_SECRET` does not affect Shopify credentials, while rotating `APP_ENCRYPTION_KEY` requires token migration or store reconnection.
8. **Auth dependency injection in `auth-session.ts`** — there are no global test hooks. Routes that need test injection export an implementation function `…Impl(req[, ctx], deps: AuthResolvers)`; the production `GET`/`POST` export is a thin wrapper that binds `realAuthResolvers`. Tests call the `…Impl` function directly with mock resolvers. Other routes call the standalone `resolveSession()` / `resolveBrandAdminContext()` wrappers (real implementation).
9. **User deletion returns 409** if the user has campaigns or QR codes. Deactivation is the recommended alternative.
10. **`/dev/email-preview`** and `/dev/email-preview/invite` return HTTP 404 when `NODE_ENV === "production"`; they are dev-only email template previews.

---

## Data Flow: Physical QR → Discount Code (end-to-end)

```
Physical sticker (qrCodeData) 
  → /q/[qrCodeData]                      QR scan page
  → POST /api/public/scan                Redeems QR, creates CampaignUnlock, awards point
  → /c/[campaignSlug]                    Campaign landing
  → /x/[experienceSlug]/shop             Experience shop
  → POST /api/rewards/shopify/redeem     Debits points, calls Shopify GraphQL
  → ShopifyRewardRedemption(status=ISSUED, code="BRAND-XXXXXXXX")
  → User copies code → uses at brand's Shopify checkout
  → Cron reconciliation picks up stuck POINTS_DEBITED → auto-refund or ISSUED
```

---

## What's Safe to Edit Without Deep Context

- `src/components/ui/` — shadcn primitives
- `src/content/legal/` — privacy, terms text
- `src/app/about/`, `/contact/`, `/home/`, `/privacy/`, `/terms/`, `/support/`
- `src/components/home/` — marketing page components
- `src/data/` — static data files

## What Requires Full Context + Testing

- `src/lib/` — any file
- `src/app/api/` — any route
- `prisma/schema.prisma` — especially model constraints and enums
- `src/middleware.ts` — route protection
- Any file touching `points`, `rewards`, `shopify`, `qr`, `unlock`, `reconcil`
