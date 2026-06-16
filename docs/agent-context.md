# SQRATCH — Agent Context Reference

> Quick-start guide for AI agents. Read this before touching any code.
> For full details see `docs/codebase-map.md`.

---

## What is SQRATCH?

A Next.js 15 + Prisma + Supabase app. Brands print physical QR stickers; users scan them with their phone, unlock campaign experiences (video courses, posts, Q&A), earn loyalty points, and redeem those points for Shopify discount codes.

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
| Does this talk to Shopify? | Check for `shopify-discounts.ts`, `shopify-products.ts`, or `shopify.ts` imports |
| Is this GDPR-relevant? | Shopify webhook routes under `/api/shopify/webhooks/` |
| Is this on the critical user path? | Routes under `/api/public/` and `/api/rewards/` |

---

## Auth Contracts (read before every API edit)

| Helper | File | Meaning when it returns null |
|---|---|---|
| `getAdminContext()` | `src/lib/admin-auth.ts` | Not logged in OR not `ADMIN` role → return 401 |
| `getBrandAdminContext()` | `src/lib/brand-auth.ts` | Not `BRAND_ADMIN` role → return 401/403 |
| `getBrandManagementContext()` | `src/lib/brand-auth.ts` | No session at all → return 401 |
| `getServerSession(authOptions)` | next-auth | Unauthenticated → null session |
| `getExperienceAccessContext()` | `src/lib/experience-access.ts` | Experience not found |
| `getRewardClaimContext()` | `src/lib/reward-access.ts` | User hasn't unlocked required campaign |

Middleware (`src/middleware.ts`) only protects `/dashboard/**`, `/admin/**` page routes — **it does not protect API routes**. API routes are individually responsible for auth checks.

---

## The 5 Files You Must Read Before Any Shopify Change

1. `src/lib/shopify.ts` — API version, OAuth helpers, HMAC, webhook registration
2. `src/lib/crypto.ts` — AES-256-GCM; key from `APP_ENCRYPTION_KEY`
3. `src/lib/shopify-webhooks.ts` — HMAC verification for all inbound webhooks
4. `src/lib/shopify-discounts.ts` — GraphQL mutations for discount code creation
5. `src/app/api/rewards/shopify/redeem/route.ts` — full redemption transaction

**Hard rules:**
- Never log or return the decrypted Shopify access token
- Never remove `timingSafeEqual` from HMAC checks
- Never change `SHOPIFY_API_VERSION` without testing all GraphQL calls
- All 4 GDPR webhooks must always return HTTP 200

---

## The 4 Files You Must Read Before Any Points / Rewards Change

1. `src/lib/points.ts` — `awardQrScanPoint()` with unique-constraint idempotency
2. `src/lib/reward-offers.ts` — availability check, code generation
3. `src/lib/reward-access.ts` — brand unlock eligibility gate
4. `src/app/api/rewards/shopify/redeem/route.ts` — serializable TX + refund path

**Hard rules:**
- `User.points` must always be modified with a matching `PointTransaction` row in the same transaction
- Never remove `isolationLevel: Serializable` from the redeem transaction
- Never remove the `debit.count !== 1` race-condition guard
- `PointTransaction` rows are an immutable audit ledger — never delete them

---

## The 3 Files You Must Read Before Any QR / Scan Change

1. `src/lib/qr-redemption.ts` — atomic `updateMany` QR status transition
2. `src/app/api/public/scan/route.ts` — full scan handler with session, unlock, points
3. `prisma/schema.prisma` → `QRCode`, `CampaignUnlock`, `PointTransaction` models

**Hard rules:**
- `QRCode` status changes (`NEW → USED`) must go through `redeemQrCodeForUser()` only
- The `status: "NEW"` filter in `updateMany` is the atomic double-redemption guard — never remove it
- `CampaignUnlock` has `@@unique([campaignId, userId])` — one unlock per user per campaign

---

## The 3 Files You Must Read Before Any Experience Page Change

1. `src/lib/experience-access.ts` — viewer context, unlock status, creator ownership check
2. `src/lib/session.ts` — `sqr_session` anonymous cookie tracking
3. `src/components/experience/experience-shell.tsx` — shared layout for all `/x/` pages

**Hard rules:**
- Anonymous viewers (not logged in) use `sqr_session` cookie for progress tracking — don't break this
- Experience pages must work for anonymous users (QR scanned by non-logged-in user)
- `canAccessPrivate` and `canInteract` flags in `ExperienceAccessContext` control gating — check before adding new access-restricted features

---

## Key Env Vars Quick Reference

| Var | Used In | Critical? |
|---|---|---|
| `DATABASE_URL` | Prisma (pooled) | Yes |
| `DIRECT_URL` | Prisma (migrations) | Yes |
| `NEXTAUTH_SECRET` | next-auth JWT signing; fallback encryption key | Yes |
| `APP_ENCRYPTION_KEY` | `src/lib/crypto.ts` — Shopify token encryption | Yes — changing breaks all stored tokens |
| `SHOPIFY_API_KEY` | OAuth start/callback | Yes for Shopify features |
| `SHOPIFY_API_SECRET` | HMAC verification (OAuth + webhooks) | Yes — must match Shopify partner dashboard |
| `SHOPIFY_APP_URL` | Webhook callback URL registration | Yes — must be public HTTPS URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side storage uploads | Yes for uploads |
| `SUPABASE_LESSON_VIDEO_BUCKET` | Lesson video bucket used for signed direct uploads | Recommended |
| `MAX_VIDEO_UPLOAD_MB` | Server-authoritative lesson video limit; defaults to 250 MB | No |
| `LESSON_VIDEO_SIGNED_URL_TTL_SECONDS` | Private lesson playback URL lifetime; defaults to 3600 seconds | No |
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
| `/dashboard/brand/shopify` | Shopify integration management |
| `/api/shopify/oauth/start` | Begin Shopify OAuth |
| `/api/shopify/oauth/callback` | Shopify OAuth return |
| `/api/shopify/installations/[id]` | Confirm Shopify install + link to brand |
| `/api/shopify/webhooks/*` | Inbound Shopify webhooks (HMAC-verified, no JWT) |
| `/api/rewards/shopify/redeem` | POST — debit points + issue discount code |
| `/api/public/scan` | POST — process QR scan |

---

## Common Gotchas

1. **Webhook routes bypass middleware JWT** — intentional (`src/middleware.ts:9`). They are HMAC-verified instead.
2. **`User.points` is a denormalized cache** — the ledger is `PointTransaction`. Always write both.
3. **`TokenStore` is a multi-purpose key-value store** — Shopify OAuth state and pending install tokens both live here with different `service` key prefixes.
4. **`CampaignUnlock` supports both authenticated and anonymous users** — `userId` is nullable; `anonKey` is used for anonymous. Both must be handled in any unlock-checking logic.
5. **next-auth v4 with App Router** — uses `getServerSession(authOptions)` (server components/routes), not `useSession` (client only). Mixing these up is a common source of auth bugs.
6. **Shopify GraphQL API version** is `2026-04` (set in `src/lib/shopify.ts:SHOPIFY_API_VERSION`). Never hardcode it elsewhere.
7. **`APP_ENCRYPTION_KEY` fallback chain**: `APP_ENCRYPTION_KEY` → `SHOPIFY_TOKEN_ENCRYPTION_KEY` → `NEXTAUTH_SECRET`. If you change any of these, all existing `shopifyAdminAccessTokenEncrypted` values become unreadable.

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
- Any file touching `points`, `rewards`, `shopify`, `qr`, `unlock`
