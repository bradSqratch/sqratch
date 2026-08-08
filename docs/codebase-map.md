# SQRATCH Codebase Map

> Updated: 2026-07-19 · Next.js 15 · Prisma 7 · next-auth 4

---

## A. Top-Level Architecture

| Concern | Technology / Approach |
|---|---|
| **Framework** | Next.js 15 App Router (React Server + Client components) |
| **Language** | TypeScript throughout |
| **Routing** | App Router — `src/app/` directory; route groups `(auth)`, `(home)`, `(withSidebar)` |
| **Auth / Session** | next-auth v4 (`credentials` provider + JWT strategy); custom `sqr_session` cookie for anonymous QR tracking |
| **Database ORM** | Prisma 7 — PostgreSQL via Supabase (separate `DATABASE_URL` + `DIRECT_URL`) |
| **File Storage** | Supabase Storage; lesson videos use signed browser-to-Supabase uploads (`docs/lesson-video-uploads.md`) |
| **Email** | SMTP via Mailtrap-compatible credentials; async queue via `EmailQueue` table + `/api/internal/email-worker` |
| **Shopify** | Public embedded session-token/token-exchange flow (expiring offline tokens) plus legacy custom-app compatibility (`LEGACY_OFFLINE`); Admin GraphQL API v2026-04 |
| **Encryption** | AES-256-GCM via `APP_ENCRYPTION_KEY`; used to store Shopify access + refresh tokens at rest |
| **Rate Limiting** | In-memory fixed-window limiter (`src/lib/rate-limit.ts`); per-instance on Vercel serverless |
| **Analytics** | Internal `AnalyticsEvent` table + Google Analytics (`NEXT_PUBLIC_GA_ID`) |
| **CI** | GitHub Actions (`verify` job): prisma generate/validate, typecheck, lint, test, build, `npm audit --omit=dev` |
| **Deployment** | Vercel (env structure, `NEXTAUTH_URL`, `VERCEL` reference) |

---

## B. Directory Map

```
sqratch/
├── prisma/
│   ├── schema.prisma          ← AUTHORITATIVE data model; edit with care
│   ├── seed.ts                ← Dev seed only (production guard + SEED_ADMIN_PASSWORD required)
│   └── migrations/            ← Ordered SQL migrations (see Section K)
├── src/
│   ├── app/
│   │   ├── (auth)/            ← Login / signup / verify-email pages (no sidebar)
│   │   ├── (home)/            ← Marketing home page
│   │   ├── (withSidebar)/     ← All dashboard pages (sidebar layout)
│   │   │   ├── admin/         ← Internal admin tools (QR mgmt, user mgmt)
│   │   │   └── dashboard/
│   │   │       ├── admin/     ← SQRATCH admin views (approvals, brands, users)
│   │   │       ├── brand/     ← Brand dashboard (campaigns, shopify, rewards)
│   │   │       └── creator/   ← Creator dashboard (experiences, courses, posts)
│   │   ├── api/               ← All API route handlers
│   │   │   ├── admin/         ← Admin-only APIs
│   │   │   ├── auth/          ← next-auth + custom auth endpoints
│   │   │   ├── brand/         ← Brand management APIs
│   │   │   ├── creator/       ← Creator management APIs
│   │   │   ├── internal/      ← Cron-triggered internal workers (email, reconciliation)
│   │   │   ├── public/        ← Unauthenticated APIs (scan, experience viewer)
│   │   │   ├── rewards/       ← Reward redemption APIs
│   │   │   ├── shopify/       ← Shopify OAuth, embedded session, webhooks
│   │   │   ├── qr/            ← QR code admin APIs
│   │   │   ├── uploads/       ← Supabase storage upload APIs (role-scoped ownership)
│   │   │   └── user/          ← User profile / points APIs
│   │   ├── c/[campaignSlug]/  ← Campaign landing page (public, post-scan)
│   │   ├── q/[qrCodeData]/    ← QR scan entry point (public)
│   │   ├── x/[experienceSlug]/← Public experience pages
│   │   ├── shopify/           ← Shopify embedded app shell (install landing)
│   │   ├── dev/               ← Dev-only email preview routes (not gated in prod — see risks)
│   │   └── (legal pages)      ← /privacy, /terms, /support, /about, /contact
│   ├── components/
│   │   ├── experience/        ← All public experience UI (hub, course, lesson, shop)
│   │   ├── brand/             ← Brand dashboard UI forms
│   │   ├── creator/           ← Creator dashboard UI forms
│   │   ├── admin/             ← Admin page shells
│   │   ├── rewards/           ← Shopify reward redemption UI (two clients: dashboard + experience)
│   │   ├── ui/                ← shadcn/ui primitives — DO NOT edit directly
│   │   └── (root level)       ← Shared layout components (sidebar, navbar, etc.)
│   ├── lib/                   ← Server-side business logic (safe to import in API routes)
│   │   ├── prisma.ts          ← Singleton Prisma client
│   │   ├── auth-session.ts    ← Centralised session/brand-context resolvers (test-hook host)
│   │   ├── session.ts         ← Anonymous session cookie management
│   │   ├── points.ts          ← Point award / overview logic
│   │   ├── qr-redemption.ts   ← QR code redemption atomics
│   │   ├── experience-access.ts ← Experience gating / viewer context
│   │   ├── reward-access.ts   ← Reward eligibility gating (brand unlock → brand IDs)
│   │   ├── reward-offers.ts   ← Offer availability, code generation, payload parsing
│   │   ├── reward-redemption-state.ts ← Formal state machine (ALLOWED_TRANSITIONS, terminal, refresh, reconciliation)
│   │   ├── reward-reconciliation.ts   ← Exactly-once stuck-redemption recovery + refund
│   │   ├── redemption-idempotency.ts  ← Pure idempotency-match helper
│   │   ├── anon-merge-keys.ts        ← Anonymous merge-key collection helper
│   │   ├── pending-install.ts         ← Shopify pending-install payload build/parse (LEGACY + EXPIRING)
│   │   ├── shopify.ts         ← OAuth helpers, HMAC, webhook helpers, scopes
│   │   ├── shopify-session-token.ts ← App Bridge JWT verifier (signature-first, timing-safe)
│   │   ├── shopify-token-manager.ts ← Token lifecycle: legacy/expiring, CAS-locked refresh, scope check
│   │   ├── shopify-discounts.ts ← Shopify Admin GraphQL discount CRUD
│   │   ├── shopify-products.ts  ← Shopify Admin GraphQL product fetch
│   │   ├── shopify-webhooks.ts  ← Webhook HMAC verification helper
│   │   ├── shopify-connection-transitions.ts ← Records ShopifyConnectionEvent history (connect/relink/disconnect/uninstall)
│   │   ├── crypto.ts          ← AES-256-GCM encrypt/decrypt (Shopify tokens)
│   │   ├── rate-limit.ts      ← In-memory rate limiter (fixed-window, per-instance)
│   │   ├── brand-auth.ts      ← Brand admin session gating
│   │   ├── admin-auth.ts      ← SQRATCH admin session gating
│   │   ├── creator-auth.ts    ← Creator session gating
│   │   ├── approval-gating.ts ← Brand/creator request helpers
│   │   └── storage-upload.ts  ← Supabase storage upload helpers
│   ├── context/
│   │   └── AuthProvider.tsx   ← next-auth SessionProvider wrapper
│   ├── helpers/
│   │   ├── mailer.ts          ← Resend email send helper
│   │   └── emailTemplates.ts  ← Email HTML templates
│   ├── content/legal/         ← Static legal page content (privacy, terms)
│   ├── hooks/                 ← React hooks (use-mobile.ts)
│   └── middleware.ts          ← Route protection middleware (next-auth JWT check)
├── tests/                     ← Node.js built-in test runner (node:test + assert/strict)
├── docs/                      ← THIS directory (AI agent context docs)
├── .github/workflows/ci.yml  ← CI pipeline
├── prisma.config.ts           ← Prisma config (points to schema.prisma)
├── shopify.app.toml           ← Public app Shopify CLI config (TOML-managed webhooks)
├── shopify.app.custom.toml    ← Custom test app Shopify CLI config
├── .env                       ← Secret env vars — NEVER commit
└── .env.example               ← Public env template
```

**Casual-edit safe:** `src/components/ui/`, `src/content/legal/`, `src/data/`, `src/app/(home)/`, `src/app/about/`, `src/app/contact/`

**Edit with care (business logic):** `src/lib/`, `src/app/api/`, `prisma/schema.prisma`

**Never edit without full context:** `src/lib/crypto.ts`, `src/lib/shopify.ts`, `src/lib/shopify-token-manager.ts`, `src/lib/shopify-discounts.ts`, `src/lib/reward-redemption-state.ts`, `src/lib/reward-reconciliation.ts`, `src/app/api/rewards/shopify/redeem/route.ts`, `src/app/api/shopify/webhooks/`

---

## C. Route Map

### Public Routes (no auth required)

| Route | File | Purpose |
|---|---|---|
| `/` | `(home)/page.tsx` | Marketing landing page |
| `/home` | `home/page.tsx` | Alternate home |
| `/about` | `about/page.tsx` | About page |
| `/contact` | `contact/page.tsx` | Contact page |
| `/privacy` | `privacy/page.tsx` | Privacy policy |
| `/terms` | `terms/page.tsx` | Terms of service |
| `/support` | `support/page.tsx` | Support page |
| `/q/[qrCodeData]` | `q/[qrCodeData]/page.tsx` | QR scan entry — resolves code → campaign |
| `/c/[campaignSlug]` | `c/[campaignSlug]/page.tsx` | Campaign landing after scan |
| `/x/[experienceSlug]` | `x/[experienceSlug]/page.tsx` | Experience hub (public) |
| `/x/[experienceSlug]/courses/[courseSlug]` | `...courses/[courseSlug]/page.tsx` | Course detail |
| `/x/[experienceSlug]/lessons/[lessonId]` | `...lessons/[lessonId]/page.tsx` | Lesson viewer |
| `/x/[experienceSlug]/shop` | `...shop/page.tsx` | Experience shop tab (Shopify products + rewards) |
| `/x/[experienceSlug]/posts` | `...posts/page.tsx` | Experience posts/community |
| `/x/[experienceSlug]/qa` | `...qa/page.tsx` | Experience Q&A |
| `/shopify` | `shopify/route.ts` | Shopify app install landing (embedded); server-rendered HTML route handler, not a page component; no shop query leak |
| `/approval-pending` | `approval-pending/page.tsx` | Brand/creator approval pending screen |
| `/dev/email-preview` | `dev/email-preview/route.ts` | Dev email preview — returns 404 when `NODE_ENV === "production"` |

### Auth Routes

| Route | File | Purpose |
|---|---|---|
| `/login` | `(auth)/login/page.tsx` | Login page |
| `/signup` | `(auth)/signup/page.tsx` | Signup page |
| `/verify-email` | `(auth)/verify-email/page.tsx` | Email verification |

### Dashboard Routes (auth required — `role: USER+`)

| Route | File | Purpose |
|---|---|---|
| `/dashboard` | `(withSidebar)/dashboard/page.tsx` | User dashboard overview |
| `/dashboard/points` | `.../points/page.tsx` | User points + transaction history + reward redemption |
| `/profile` | `(withSidebar)/profile/page.tsx` | User profile edit — authenticated-only via `middleware.ts` matcher, no role restriction |

### Brand Dashboard Routes (auth + Brand-management policy, enforced in `dashboard/brand/layout.tsx`)

| Route | Purpose |
|---|---|
| `/dashboard/brand/campaigns` | Campaign list + management |
| `/dashboard/brand/campaigns/new` | Create campaign |
| `/dashboard/brand/campaigns/[id]/edit` | Edit campaign |
| `/dashboard/brand/campaigns/[id]/experiences` | Attach experiences to campaign |
| `/dashboard/brand/rewards` | Reward offers management |
| `/dashboard/brand/qr-batches` | QR batch list (paginated) |
| `/dashboard/brand/qr-batches/new` | Create QR batch |
| `/dashboard/brand/shopify` | Shopify integration status |
| `/dashboard/brand/shopify/install` | Shopify install confirmation UI |
| `/dashboard/brand/profile` | Brand profile edit |
| `/dashboard/brand/analytics` | Brand analytics |

### Creator Dashboard Routes (auth + `CREATOR` role, enforced in `dashboard/creator/layout.tsx` — no ADMIN override)

| Route | Purpose |
|---|---|
| `/dashboard/creator/experiences` | Experience list |
| `/dashboard/creator/experiences/new` | Create experience |
| `/dashboard/creator/experiences/[id]/edit` | Edit experience |
| `/dashboard/creator/experiences/[id]/courses` | Manage courses |
| `/dashboard/creator/courses/[id]/lessons` | Manage lessons |
| `/dashboard/creator/posts` | Creator posts |
| `/dashboard/creator/analytics` | Creator analytics |

### Admin Routes (auth + `ADMIN` role)

| Route | Purpose | Enforcement |
|---|---|---|
| `/admin/qr-management` | QR code admin tools | `middleware.ts` (`isAdminRoute`) |
| `/admin/user-management` | User admin | `middleware.ts` (`isAdminRoute`) |
| `/admin/campaigns-management` | Campaign admin | `middleware.ts` (`isAdminRoute`) |
| `/admin/print-qr` | QR printing tool | `middleware.ts` (`isAdminRoute`) |
| `/dashboard/admin/approvals` | Brand/creator approval queue | `dashboard/admin/layout.tsx` (middleware only checks `/dashboard/**` is authenticated, not role — the path doesn't match `isAdminRoute`) |
| `/dashboard/admin/brands` | Brand list | `dashboard/admin/layout.tsx` |
| `/dashboard/admin/users` | User list | `dashboard/admin/layout.tsx` |
| `/dashboard/admin/campaigns` | Campaign list | `dashboard/admin/layout.tsx` |

---

## D. API Map

### Auth APIs

| Method | Path | Auth | Rate Limit | Purpose | Side Effects |
|---|---|---|---|---|---|
| POST | `/api/auth/signup` | None | 5/15 min per IP | User signup (email+password) | Creates an unverified `USER` plus an HMAC-backed verification challenge |
| POST | `/api/auth/send-email-verification` | Session | 5/15 min per IP | Triggers email verification send | Replaces a peppered HMAC challenge and queues email; public response is generic |
| POST | `/api/auth/verify-email` | None | — | Consume six-digit challenge; merge anon unlocks | Atomically verifies the user and queues one welcome email only for ordinary self-service users without Creator/Brand applications |
| * | `/api/auth/[...nextauth]` | — | — | next-auth handler (signin/signout/session) | JWT callback checks `User.sessionVersion` and account state against the database |

### Public APIs (no auth required)

| Method | Path | Rate Limit | Purpose | Key DB Tables |
|---|---|---|---|---|
| POST | `/api/public/scan` | 60/60 min per IP | Process QR scan | `QRCode`, `CampaignUnlock`, `PointTransaction`, `AnalyticsEvent`, `UserSession` |
| GET | `/api/public/experience/[experienceSlug]` | — | Fetch experience data | `Experience`, `Campaign`, `Course` |
| GET | `/api/public/experience/[slug]/courses/[courseSlug]` | — | Fetch course + lessons | `Course`, `Lesson` |
| GET | `/api/public/experience/[slug]/lessons/[lessonId]` | — | Fetch lesson | `Lesson`, `LessonProgress` |
| GET | `/api/public/experience/[slug]/products` | — | Fetch experience shop products (canonical catalog only; no live Shopify fallback) | `CampaignCommerceProduct`, `BrandCommerceProduct`, `ConnectedCommerceProduct` |
| GET | `/api/public/experience/[slug]/lessons/[id]/products` | — | Fetch lesson products (canonical; gated on `hasPublicStorefrontUrl`) | `CampaignLessonProduct`, `BrandCommerceProduct`, `ConnectedCommerceProduct` |
| GET | `/api/public/campaign/[campaignSlug]` | — | Fetch campaign data | `Campaign`, `Experience` |
| GET | `/api/public/get-campaign-name?campaignId=` | — | Resolve campaign name (public) | `Campaign` |
| GET | `/api/public/viewer-status` | — | Get viewer unlock status | `CampaignUnlock` |
| POST | `/api/public/session` | — | Create/update session cookie | `UserSession` |
| POST | `/api/public/waitlist` | 10/60 min per IP | Join waitlist | `WaitlistEntry` |

### User APIs (auth required)

| Method | Path | Purpose | Side Effects |
|---|---|---|---|
| GET | `/api/user/me` | Get current user | None |
| PATCH | `/api/user/profile` | Update user profile | Updates `User` |
| POST | `/api/user/change-password` | Change password | Updates `User.password` |
| GET | `/api/user/progress` | Get lesson progress | None |
| GET | `/api/user/unlocks` | Get campaign unlocks | None |
| GET | `/api/me/dashboard-summary` | Dashboard summary stats | None |

### Brand APIs (auth + BRAND_ADMIN)

| Method | Path | Auth | Purpose | Side Effects |
|---|---|---|---|---|
| GET/POST | `/api/brand/campaigns` | BRAND_ADMIN | List / create campaigns | Creates `Campaign` |
| GET/PATCH/DELETE | `/api/brand/campaigns/[id]` | BRAND_ADMIN + ownership | Get/update/delete campaign | Modifies `Campaign` |
| POST | `/api/brand/campaigns/[id]/attach-experience` | BRAND_ADMIN | Link experience to campaign | Creates `CampaignExperience` |
| GET/POST | `/api/brand/qr-batches` | BRAND_ADMIN | List (paginated) / create QR batches | Creates `QRCodeBatch`, bulk generates `QRCode` rows |
| GET/PATCH | `/api/brand/qr-batches/[id]` | BRAND_ADMIN | Get/update batch | |
| GET | `/api/brand/qr-batches/[id]/export` | BRAND_ADMIN | CSV export (formula-injection sanitised) | None |
| PATCH | `/api/brand/qr-codes/[id]` | BRAND_ADMIN | Update single QR code | |
| GET/PATCH | `/api/brand/profile` | BRAND_ADMIN | Get/update brand profile | Updates `Brand` |
| GET/POST | `/api/brand/rewards/offers` | BRAND_ADMIN | List / create reward offers | Creates `BrandRewardOffer` + `BrandRewardOfferProduct` |
| GET/PATCH/DELETE | `/api/brand/rewards/offers/[offerId]` | BRAND_ADMIN + ownership | Manage offer | Modifies offer |
| GET | `/api/brand/shopify/status` | BRAND_ADMIN | Shopify connection status | None |
| GET | `/api/brand/shopify/products` | BRAND_ADMIN | Fetch products from Shopify | Calls Shopify Admin GraphQL |
| POST | `/api/brand/shopify/disconnect` | BRAND_ADMIN | Disconnect Shopify | Sets `shopifyConnectionStatus=DISCONNECTED` |
| GET | `/api/brand/analytics` | BRAND_ADMIN | Brand analytics | None |

### Admin APIs (auth + ADMIN)

| Method | Path | Purpose |
|---|---|---|
| PATCH | `/api/admin/user-management/update-or-delete-users/[id]` | Update user (email normalised to lowercase) |
| DELETE | `/api/admin/user-management/update-or-delete-users/[id]` | Delete user (409 if campaigns/QR codes exist) |
| GET | `/api/admin/user-management/get-user-emails` | List user emails |
| POST | `/api/admin/user-management/get-or-create-users` | Bulk user lookup/create |
| PATCH | `/api/admin/approvals/brand/[requestId]` | Approve/reject brand request |
| PATCH | `/api/admin/approvals/creator/[requestId]` | Approve/reject creator request |
| GET | `/api/admin/approvals` | List pending approvals |
| GET | `/api/admin/brands` | List all brands |
| GET | `/api/admin/users` | List all users |
| GET/PATCH/DELETE | `/api/admin/campaigns/[id]` | Manage individual campaigns |
| GET | `/api/admin/campaigns` | List campaigns |

### Shopify OAuth & Install APIs

| Method | Path | Auth | Rate Limit | Purpose | Side Effects |
|---|---|---|---|---|---|
| GET | `/api/shopify/oauth/start` | None | 20/60 min per IP | Begin OAuth; redirect to Shopify | Creates `TokenStore` (state, 10min TTL) |
| GET | `/api/shopify/oauth/callback` | None | — | Receive Shopify callback; timing-safe HMAC verify, timestamp freshness, state consumed before token exchange | Exchanges code for token; creates pending install `TokenStore` (24hr TTL) |
| POST | `/api/shopify/embedded/session` | Bearer session token | — | App Bridge token exchange (public distribution only) | Encrypts tokens, creates `TokenStore` pending install |
| GET | `/api/shopify/installations/[installId]` | Session + Brand-management policy (see Auth Contracts) | — | Load eligible existing Brands for this pending install | None |
| POST | `/api/shopify/installations/[installId]` | Session + Brand-management policy (see Auth Contracts) | — | Link install to an existing eligible Brand — never creates a Brand; a `createBrand` payload is rejected with 400 | Updates `Brand` (all token fields), deletes pending `TokenStore` |

### Shopify Webhook APIs (no auth — HMAC verified)

| Method | Path | Trigger | DB Effect |
|---|---|---|---|
| POST | `/api/shopify/webhooks/app/uninstalled` | Shop uninstalls app | Clears credential/token fields, sets `Brand.shopifyConnectionStatus=UNINSTALLED`; `shopifyShopDomain` is intentionally preserved for relink; records a `ShopifyConnectionEvent` |
| POST | `/api/shopify/webhooks/customers/data_request` | GDPR data request | Sanitized audit log only — no data returned (SQRATCH stores no Shopify-customer-keyed data) |
| POST | `/api/shopify/webhooks/customers/redact` | GDPR customer redact | Sanitized audit log only — no rows deleted (SQRATCH stores no Shopify-customer-keyed data) |
| POST | `/api/shopify/webhooks/shop/redact` | GDPR shop redact | Nulls `Brand` Shopify credentials/domain, anonymizes `ShopifyRewardRedemption` Shopify metadata, deactivates the brand's `BrandRewardOffer` rows, scrubs the domain from `ShopifyConnectionEvent` history, deletes orphaned OAuth `TokenStore` rows; SQRATCH business/ledger records are preserved — see `docs/shopify-data-inventory.md` |

### Reward APIs (auth required)

| Method | Path | Auth | Purpose | Side Effects |
|---|---|---|---|---|
| GET | `/api/rewards/shopify` | Session | List available reward offers for viewer (includes `computedAvailability`) | None |
| POST | `/api/rewards/shopify/redeem` | Session | Redeem reward (debit points + issue discount) | Creates `ShopifyRewardRedemption` + `PointTransaction`, calls Shopify GraphQL; bounded 3-attempt code-collision retry |
| GET | `/api/rewards/shopify/redemptions` | Session | List user's redemptions (includes `shopUrl`) | None |
| POST | `/api/rewards/shopify/redemptions/[id]/refresh-status` | Session | Re-check discount usage from Shopify | State-machine guard via `canRefresh()`; calls Shopify GraphQL; may transition ISSUED→USED/EXPIRED |

### Internal Worker APIs (cron-triggered)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/internal/email-worker` | `x-cron-secret` | Revalidate and process bounded `WELCOME` jobs; retry failures with backoff, recover stale claims, and mark ineligible jobs `SKIPPED` |
| POST | `/api/internal/reconcile-redemptions` | `x-cron-secret` | Reconcile stuck `POINTS_DEBITED` redemptions (limit 20, 5 min minimum age, 5 max attempts) |

### Progress APIs (session or auth)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/progress/lesson` | Record lesson progress (anonymous or logged in) |
| POST | `/api/progress/merge` | Merge anonymous progress into user after login |

### Upload APIs (auth + role-scoped ownership)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/uploads/storage-object` | Generic storage upload (ADMIN broad, BRAND_ADMIN brand-path, CREATOR own experience/avatar) |
| POST | `/api/uploads/experience-video` | Experience video upload (ownership verified, experienceId required) |
| POST | `/api/uploads/experience-cover` | Experience cover image |
| POST | `/api/uploads/brand-asset` | Brand asset upload |
| POST | `/api/uploads/user-avatar` | User avatar upload |
| POST | `/api/uploads/video` | Video upload |

---

## E. Prisma / Data Model Map

### Core Identity Models

| Model | Purpose | Key Relationships | Lifecycle Notes |
|---|---|---|---|
| `User` | End user, brand admin, creator, or SQRATCH admin | Has many `BrandMember`, `CreatorProfile`, `CampaignUnlock`, `PointTransaction`, `ShopifyRewardRedemption`, `UserSession` | `role` enum controls access everywhere; balances live on `UserPointAccount` (see Points below), not on `User`; `isActive` and `sessionVersion` are checked in the JWT callback |
| `UserSession` | Anonymous + authenticated browsing session | Belongs to `User?`, `Campaign?`, `QRCode?` | Created on QR scan; promoted to userId on login via `/api/progress/merge` |
| `EmailVerificationToken` | HMAC-backed email verification challenge | Belongs to `User` | Six-digit code is never stored; expires after 10 minutes, exhausts after five failed attempts, and is atomically consumed |

### Brand & Campaign Models

| Model | Purpose | Key Relationships | Lifecycle Notes |
|---|---|---|---|
| `Brand` | A brand entity (e.g. retailer using Shopify) | Has `BrandMember[]`, `Campaign[]`, `BrandRewardOffer[]`, `ShopifyRewardRedemption[]` | Token fields: `shopifyAdminAccessTokenEncrypted`, `shopifyRefreshTokenEncrypted` (AES-256-GCM); `shopifyAuthMode` enum (`LEGACY_OFFLINE` or `EXPIRING_OFFLINE`); `shopifyTokenRefreshLockedUntil` (CAS refresh lease); `shopifyConnectionStatus` drives all Shopify features; `REQUIRES_RECONNECT` for permanent refresh failure |
| `BrandMember` | User ↔ Brand membership | `User`, `Brand` | `role: ADMIN\|MANAGER\|VIEWER`; only ADMIN+MANAGER can take actions |

Brand-scoped requests resolve through `src/lib/brand-context.ts` and the HttpOnly `sqratch_active_brand_id` cookie. The cookie is accepted only when the current user still has the required membership; multi-brand requests without a selection return `ACTIVE_BRAND_REQUIRED` instead of choosing an arbitrary membership.
| `BrandRequest` | Request to become a brand admin | `User` (owner), `User` (reviewer) | `ApprovalStatus: PENDING\|APPROVED\|REJECTED` |
| `Campaign` | A marketing campaign tied to a brand | `Brand?`, `QRCode[]`, `CampaignExperience[]`, `CampaignUnlock[]`, `QRCodeBatch[]` | Can exist without a Brand (admin campaigns); `slug` is the URL identifier |
| `CampaignUnlock` | Records that a user (or anon) has unlocked a campaign | `Campaign`, `User?`, `QRCode?` | Unique on `(campaignId, userId)`. Anon unlocks use `anonKey`. Merged to userId on verify-email via `collectAnonMergeKeys`. Partial unique index `(campaignId, anonKey) WHERE anonKey IS NOT NULL AND userId IS NULL` in migration 20260615113320 (intentional Prisma/DB divergence) |

### QR Code Models

| Model | Purpose | Notes |
|---|---|---|
| `QRCode` | Individual QR code | `status: NEW\|USED\|INVALID`; `qrCodeData` is the unique scan token; transitions to USED atomically via `redeemQrCodeForUser` |
| `QRCodeBatch` | Group of QR codes for a campaign | Used for print management and bounded paginated listing + CSV export (formula-injection sanitised) |

### Experience / Content Models

| Model | Purpose | Key Relationships |
|---|---|---|
| `CreatorProfile` | Creator's public profile | `User`, `Experience[]` |
| `CreatorRequest` | Request to become a creator | `User` |
| `Experience` | Top-level content hub (video, courses, posts, QA) | `CreatorProfile`, `Course[]`, `Post[]`, `Question[]`, `CampaignExperience[]` |
| `Course` | A course within an experience | `Experience`, `Lesson[]`; `access: PUBLIC\|PRIVATE` |
| `Lesson` | A video lesson within a course | `Course`, `LessonProgress[]`, `CampaignLessonProduct[]` |
| `LessonProgress` | Per-user or per-session lesson progress | `User?`, `UserSession?`, `Lesson`; unique on `(userId, lessonId)` or `(sessionId, lessonId)` |
| `Post` | Community post on an experience | `Experience`, `PostComment[]` |

### Rewards Models

| Model | Purpose | Dangerous Fields |
|---|---|---|
| `BrandRewardOffer` | A reward offer created by a brand | `pointsCost`, `discountAmountCents`, `discountPercentageBasisPoints`, `maxTotalRedemptions`, `maxRedemptionsPerUser`; supports `FIXED_AMOUNT` and `PERCENTAGE` discount types; `appliesTo` supports `ALL_PRODUCTS` and `SPECIFIC_PRODUCTS` |
| `BrandRewardOfferProduct` | Specific Shopify products a reward applies to | `shopifyProductGid` must be a valid Shopify GID |
| `ShopifyRewardRedemption` | Single redemption event | `idempotencyKey` (unique); `status` state machine (8 states); `code` (unique discount code); `shopifyDiscountNodeId` links to Shopify; reconciliation fields: `reconcileLockedUntil`, `reconcileAttempts`, `needsManualReview`, `lastReconcileReason` |
| `PointTransaction` | Immutable audit log of point changes | `points` can be negative (debit); `reason` enum; **never delete rows**; unique on `(userId, qrCodeId)` prevents QR double-award; unique on `(shopifyRewardRedemptionId, reason)` prevents refund duplication |

### Points

`PointTransaction` is the **authoritative transaction history and audit ledger** (immutable, one row per event). `UserPointAccount` (`spendablePoints`, `lifetimeEarnedPoints`, `lifetimeSpentPoints`, `lifetimeRefundedPoints`) is the **authoritative current-balance aggregate**, one row per user, kept mathematically consistent with the ledger. `applyPointLedgerEvent()` in `src/lib/points.ts` is the only function that writes both, atomically, inside a transaction. There is no other balance field anywhere: the legacy `User.points` mirror column was removed from application code, the Prisma schema, and (migration `20260719061157_remove_legacy_user_points`, applied to production 2026-07-19) the physical database. See `docs/points-ledger.md` for full invariants and the completed migration record. The unique constraint `(userId, qrCodeId)` on `PointTransaction` is the primary QR double-award guard. The unique constraint `(shopifyRewardRedemptionId, reason)` is the refund exactly-once guard.

### Internal / Support Models

| Model | Purpose |
|---|---|
| `TokenStore` | Key-value store for short-lived tokens (Shopify OAuth state, pending install payloads — both LEGACY and EXPIRING shapes). Keyed by `service` string. Always check `expiresAt` |
| `EmailQueue` | Async email queue created after successful ordinary-user verification; processed by `/api/internal/email-worker` |
| `WaitlistEntry` | Marketing waitlist signups |
| `AnalyticsEvent` | Internal analytics events (QR scans, lesson views, etc.) |

### Enums Summary

| Enum | Values |
|---|---|
| `Role` | `USER`, `ADMIN`, `CREATOR`, `BRAND_ADMIN` |
| `ApprovalStatus` | `PENDING`, `APPROVED`, `REJECTED` |
| `QRStatus` | `NEW`, `USED`, `INVALID` |
| `ShopifyConnectionStatus` | `DISCONNECTED`, `CONNECTED`, `UNINSTALLED`, `REQUIRES_RECONNECT` |
| `ShopifyAuthMode` | `LEGACY_OFFLINE`, `EXPIRING_OFFLINE` |
| `ShopifyRewardRedemptionStatus` | `PENDING`, `POINTS_DEBITED`, `ISSUED`, `USED`, `EXPIRED`, `FAILED`, `REFUNDED`, `CANCELLED` |
| `PointReason` | `QR_SCAN`, `BONUS`, `REFERRAL`, `SHOPIFY_REWARD_REDEMPTION`, `SHOPIFY_REWARD_REFUND` |
| `RewardAppliesTo` | `ALL_PRODUCTS`, `SPECIFIC_PRODUCTS` |
| `RewardDiscountType` | `FIXED_AMOUNT`, `PERCENTAGE` |

---

## F. Core Business Flows

### 1. User Signup / Login

```
User submits signup form
→ POST /api/auth/signup (rate limited: 5/15 min)
  → Creates User (bcrypt cost 12, shared 8–72 letter+number policy, role=USER)
→ POST /api/auth/send-email-verification (rate limited: 5/15 min)
  → Replaces the HMAC challenge (expires in 10 minutes)
  → Sends six-digit code via SMTP
→ User submits code → POST /api/auth/verify-email
  → Atomically consumes the challenge, sets User.isEmailVerified=true
  → Queues one WELCOME job only for self-service USER accounts with no CreatorRequest or BrandRequest
  → Merges anonymous CampaignUnlocks via collectAnonMergeKeys (sqr_session first)
→ POST /api/internal/email-worker (CRON_SECRET)
  → Revalidates verified USER role and absence of Creator/Brand applications
  → Sends the welcome email with a /login CTA, marks ineligible jobs SKIPPED,
    or retries delivery failures after 5m, 15m, 1h, and 6h (five attempts max)
→ User signs in via next-auth credentials provider (email lowercased)
  → JWT contains: id, email, role, name, isActive, sessionVersion
  → JWT maxAge: 7 days
  → Every authenticated JWT callback: re-read role, isActive, email verification, and sessionVersion from DB
  → Deactivated users → forced sign-out (jwt callback returns null)
```

### 2. QR Scan / Campaign Unlock

```
Physical QR printed → encodes unique qrCodeData string
User scans → browser opens /q/[qrCodeData]
  → Page calls POST /api/public/scan { qrCodeData } (rate limited: 60/60 min)
    → Looks up QRCode + Campaign
    → Upserts UserSession (sets campaignId, qrCodeId)
    → If QR already USED: logs analytics, returns campaignSlug
    → If logged in:
      → Creates CampaignUnlock (campaignId, userId, qrCodeId)
      → TRANSACTION:
        → redeemQrCodeForUser (status: NEW → USED, atomic updateMany)
        → awardQrScanPoint → PointTransaction(+1, QR_SCAN) + UserPointAccount.spendablePoints++
    → If anonymous:
      → Creates CampaignUnlock (campaignId, anonKey=sessionId)
        → P2002 caught for concurrent duplicate (partial unique index dedup)
    → Logs AnalyticsEvent(qr_scan)
  → Browser redirects to /c/[campaignSlug]
```

### 3. Points Awarding

```
QR Scan (authenticated):
  → awardQrScanPoint() in src/lib/points.ts
  → Creates PointTransaction(+1, QR_SCAN, qrCodeId)
  → Unique constraint (userId, qrCodeId) prevents double-award
  → UserPointAccount.spendablePoints += 1

Points are always modified atomically:
  → PointTransaction row created first
  → UserPointAccount aggregate updated in same DB transaction
```

### 4. Shopify OAuth Install / Linking (Legacy Path)

```
Brand admin at /dashboard/brand/shopify clicks "Connect"
  → GET /api/shopify/oauth/start?shop=myshop.myshopify.com (rate limited: 20/60 min)
    → Validates shop domain format
    → Generates CSRF state, stores in TokenStore (10min TTL)
    → Redirects to https://myshop.myshopify.com/admin/oauth/authorize

Shopify redirects back:
  → GET /api/shopify/oauth/callback?shop=&code=&state=&hmac=&timestamp=
    → Verifies HMAC using safeHmacEqual (timing-safe)
    → Validates timestamp freshness (60s window)
    → State consumed by deleteMany BEFORE token exchange (replay prevention)
    → Validates scope match
    → Exchanges code for access_token (POST to Shopify)
    → Encrypts token (AES-256-GCM via APP_ENCRYPTION_KEY)
    → Stores LEGACY pending install in TokenStore (24hr TTL)
    → Redirects to /dashboard/brand/shopify/install?install=[id]

User confirms install:
  → POST /api/shopify/installations/[installId] { brandId }
    → Parses pending install payload (LEGACY or EXPIRING shape detection)
    → Rejects a `createBrand` payload outright (400) — installation only
      links to an existing eligible Brand, never creates one
    → Validates brand ownership against the shared Brand-management policy
    → Updates Brand (shopifyShopDomain, encrypted tokens, status=CONNECTED, authMode)
    → Deletes pending install TokenStore
    → Redirects to /dashboard/brand/shopify?connected=1

Wrong-role account (USER/CREATOR) reaches the install page:
  → dashboard/brand/layout.tsx renders a shared AccessDeniedPanel instead of
    the page (no silent redirect, pending install left untouched/reusable)
  → "Switch SQRATCH account" signs out of SQRATCH only, preserving the exact
    install URL as callbackUrl, so logging in as an eligible Brand Admin
    returns to the same installation
```

### 5. Shopify Embedded Auth (Public App Token Exchange)

```
Merchant opens app from Shopify Admin → /shopify?shop=...&host=...
  → embedded-shell-client.tsx detects embedded context (isEmbedded())
  → Requests App Bridge session token: window.shopify.idToken()
  → POST /api/shopify/embedded/session (Authorization: Bearer <sessionToken>)
    → verifySessionTokenFromRequest (HMAC-first, then claims, then dest/iss/sub)
    → Distribution guard: public only
    → Shop from verified token dest claim (never from query/body)
    → exchangeSessionTokenForOfflineToken → Shopify token endpoint
    → Scope check → hasSufficientScopes
    → Encrypt both access + refresh tokens
    → buildExpiringPendingInstall → TokenStore.create
    → Returns { data: { installId } } only — no token ever sent to browser
  → Client navigates to /dashboard/brand/shopify/install?install=[installId]
```

### 6. Shopify Token Refresh (Expiring Offline Tokens)

```
getValidAccessToken(brandId) called by any Shopify API consumer
  → LEGACY_OFFLINE: decrypt + return (no expiry check)
  → EXPIRING_OFFLINE:
    → Check isAccessTokenFresh (120s safety buffer before expiry)
    → If fresh: decrypt + return
    → If stale: acquire CAS refresh lock (30s duration, 3s wait, 250ms poll)
    → POST to Shopify /admin/oauth/access_token (refresh_token grant)
    → Encrypt new access + refresh tokens
    → Persist atomically with updateMany CAS on lock timestamp
    → On permanent failure (401, invalid_grant): markRequiresReconnect
    → Return fresh decrypted access token
```

### 7. Shopify Reward Redemption (critical path)

```
User at /x/[slug]/shop or /dashboard/points clicks "Redeem"
  → Client holds one idempotencyKey per offer (useRef map); reused on retry, fresh on new intent
  → POST /api/rewards/shopify/redeem { offerId, idempotencyKey, experienceSlug? }
    
    1. Auth: getServerSession → must be logged in
    2. Idempotency: check ShopifyRewardRedemption by idempotencyKey
       → If exists + same user + same offer: return cached result (idempotencyMatch)
       → If exists + mismatch: 409
    3. Load offer + brand (incl. encrypted token)
    4. getRewardClaimContext() → verify user has unlocked the campaign/experience
    5. Check brand.shopifyConnectionStatus === CONNECTED
    6. Availability check (getRewardOfferAvailability) using CLAIM_COUNTED_REDEMPTION_STATUSES
    7. Check getUserSpendablePointBalance() >= offer.pointsCost
    
    8. SERIALIZABLE TRANSACTION:
       → Re-check offer + Shopify connection (inside TX)
       → Re-check limits (inside TX)
       → Re-check concurrent idempotency (idempotencyMatch for P2002 on key)
       → Create ShopifyRewardRedemption (status=PENDING)
       → UserPointAccount.updateMany({ spendablePoints: { gte: pointsCost } }) → debit
         → If count !== 1: throw INSUFFICIENT_POINTS (race condition guard)
       → Create PointTransaction(-pointsCost, SHOPIFY_REWARD_REDEMPTION)
       → Update redemption status → POINTS_DEBITED
    
    9. Call createShopifyRewardDiscountCode() → Shopify GraphQL mutation
       → Bounded 3-attempt retry on generated code collision (P2002 on code only)
       → If fails: REFUND TRANSACTION:
          → UserPointAccount.spendablePoints += pointsCost
          → Create PointTransaction(+pointsCost, SHOPIFY_REWARD_REFUND)
          → Update redemption status → REFUNDED
          → Return error + refunded redemption
    
   10. If Shopify succeeds:
       → Update redemption: status=ISSUED, shopifyDiscountNodeId, issuedAt, expiresAt
       → Return redemption with discount code
```

### 8. Reward State Machine

```
         PENDING
        /       \
  POINTS_DEBITED  FAILED
    /   |    \      (terminal)
 ISSUED REFUNDED FAILED
  / \     (terminal) (terminal)
USED  EXPIRED
(terminal) (terminal)

         CANCELLED (terminal, from PENDING only)
```

Managed by `src/lib/reward-redemption-state.ts`. All transitions validated by `assertTransition()` before any DB write. Same-status transitions are idempotent no-ops.

### 9. Stuck-Redemption Reconciliation

```
Supabase Cron is manually managed outside this repository:
CRON: POST /api/internal/email-worker (x-cron-secret, every 5 min)
  → Recovers SENDING claims older than 15 min; bounded retry/backoff for WELCOME
CRON: POST /api/internal/reconcile-redemptions (x-cron-secret, every 10 min)
  → reconcileStuckRedemptions({ limit: 20, minAgeMs: 5*60*1000, maxAttempts: 5 })
  → Selects POINTS_DEBITED rows older than 5 min, not locked, not manual-review
  → For each: CAS lock (30s) → look up Shopify discount by nodeId or code
    → If discount found and active → assertTransition → ISSUED
    → If discount absent/definitive failure → exactly-once refund:
      → PointTransaction(+points, SHOPIFY_REWARD_REFUND) — catches P2002 OUTSIDE TX
      → assertTransition → REFUNDED
    → If Shopify unreachable/ambiguous → increment attempts, retry later
    → After maxAttempts → needsManualReview = true
```

### 10. Shopify Uninstall Webhook

```
Merchant uninstalls app from Shopify admin
  → POST /api/shopify/webhooks/app/uninstalled
    → verifyShopifyWebhookRequest() — HMAC check against SHOPIFY_API_SECRET
    → Brand.updateMany({ shopifyShopDomain: shop })
      → shopifyAdminAccessTokenEncrypted = null
      → shopifyConnectionStatus = UNINSTALLED
      → shopifyUninstalledAt = now()
    → Returns 200 (Shopify expects 200 regardless)
```

---

## G. Authentication Architecture

### NextAuth Session / JWT Lifecycle

- **Strategy:** JWT (no database sessions for auth)
- **Provider:** Credentials (email + bcrypt password)
- **JWT maxAge:** 7 days (explicit `session.maxAge` and `jwt.maxAge`)
- **Sign-in:** JWT contains `id`, `email`, `role`, `isEmailVerified`, `imageUrl`, `isTemporary`, `isActive`, `roleCheckedAt`
- **Subsequent requests:** Every 5 minutes (`RECHECK_MS`), the `jwt` callback re-reads `role`, `isActive`, `isEmailVerified` from the database
- **Deactivated users:** If `findUnique` returns `!isActive` or `null`, the callback returns `null` — forcing next-auth to invalidate the session
- **DB errors during recheck:** Caught and swallowed — existing token retained to avoid false sign-outs

### `src/lib/auth-session.ts`

Centralised session resolution. Exports the typed `AuthResolvers` dependency interface and `realAuthResolvers` (backed by NextAuth + brand-auth), plus the standalone `resolveSession()` / `resolveBrandAdminContext()` wrappers used by routes that do not need test injection. There are **no global test hooks** and no `NODE_ENV` auth bypass. Routes that tests exercise expose a `…Impl(req[, ctx], deps: AuthResolvers)` function; the production `GET`/`POST` export wraps it with `realAuthResolvers`, and tests pass mock resolvers explicitly.

### Middleware vs Route-Level Auth

- **Middleware** (`src/middleware.ts`): Only protects page routes (`/dashboard/**`, `/admin/**`, `/login`, `/signup`, `/verify-email`). Redirects unauthenticated users and non-admins. Passes through Shopify webhook routes without JWT check.
- **API routes:** Individually responsible for auth checks via `getServerSession(authOptions)`, `getBrandAdminContext()`, `getAdminContext()`, etc. Middleware does NOT protect API routes.

### Email Normalization

All email inputs are lowercased: sign-in (`authorize`), signup, admin PATCH, send-verify-email, waitlist. The canonical form is `email.trim().toLowerCase()`.

---

## H. Shopify Architecture

### Distribution Modes

| Mode | Env Var | Auth Flow | Token Type | Config |
|---|---|---|---|---|
| **Public** | `SHOPIFY_APP_DISTRIBUTION=public` | App Bridge session token → token exchange | Expiring offline (1h access, 90d rotating refresh) | `shopify.app.toml` |
| **Custom** | `SHOPIFY_APP_DISTRIBUTION=custom` | OAuth code exchange | Legacy non-expiring offline | `shopify.app.custom.toml` |

### Scopes

Exactly: `read_products`, `read_discounts`, `write_discounts`. Do NOT add customer/order/payment/billing/write_products scopes.

### Token Storage (Brand model)

| Field | Purpose |
|---|---|
| `shopifyAdminAccessTokenEncrypted` | AES-256-GCM encrypted access token |
| `shopifyAccessTokenExpiresAt` | Expiry timestamp (expiring mode only) |
| `shopifyRefreshTokenEncrypted` | AES-256-GCM encrypted refresh token (expiring mode only) |
| `shopifyRefreshTokenExpiresAt` | Refresh token expiry (90 days) |
| `shopifyGrantedScopes` | Comma-separated granted scopes |
| `shopifyClientId` | Client ID used for this installation |
| `shopifyAuthMode` | `LEGACY_OFFLINE` or `EXPIRING_OFFLINE` |
| `shopifyTokenRefreshLockedUntil` | CAS lock for concurrent refresh prevention |

### Webhook Management

All webhooks are TOML-managed (`shopify.app.toml` / `shopify.app.custom.toml`). The `registerShopifyWebhooks` function was removed. Compliance topics (`CUSTOMERS_DATA_REQUEST`, `CUSTOMERS_REDACT`, `SHOP_REDACT`) cannot be subscribed via the GraphQL API — they must be in the Partner Dashboard or TOML config.

---

## I. Rate Limiting

### Implementation

`src/lib/rate-limit.ts` — in-memory fixed-window rate limiter using a module-level `Map`. Bounded to 10,000 keys with automatic pruning.

### Protected Routes

| Endpoint | Key | Limit | Window |
|---|---|---|---|
| `/api/auth/signup` | `signup:{ip}` | 5 | 15 min |
| `/api/auth/send-email-verification` | `send-verify-email:{ip}` | 5 | 15 min |
| `/api/public/waitlist` | `waitlist:{ip}` | 10 | 60 min |
| `/api/shopify/oauth/start` | `shopify-oauth-start:{ip}` | 20 | 60 min |
| `/api/public/scan` | `scan:{ip}` | 60 | 60 min |

### Limitations

On Vercel serverless, each function instance has its own `Map` that resets on cold start. The effective limit is per-instance, not per-deployment. This is sufficient for abuse prevention (spam, enumeration) but not global hard-cap enforcement. For stricter limits, replace the `store` Map with Upstash Redis or Vercel KV.

---

## J. Testing and CI

### Test Framework

Node.js built-in test runner (`node:test` + `assert/strict`). All tests in `tests/*.test.ts`, executed via `tsx --test tests/*.test.ts`.

### Current Test Files

The number of test files and individual tests changes as the codebase grows — `npm test` (and `npm run verify`, which runs it as part of the full pipeline) is the current source of truth for how many exist and whether they pass; do not rely on any count recorded in this document. Coverage areas include: account/session integrity, anonymous-merge and QR-scan flows, points ledger and account reconstruction (including a real-Postgres-gated concurrency test — see below), reward redemption/reconciliation/state-machine, Shopify token management and session-token verification, Shopify store-compatibility and connection-transition history, lesson video upload/playback, email/welcome-worker delivery, and route-level integration coverage (`integration-coverage.test.ts`, `qr-routes-hardening.test.ts`).

### CI Pipeline (`.github/workflows/ci.yml`)

Runs on push to `main` and all PRs:
1. `npm ci`
2. `npx prisma generate`
3. `npx prisma validate`
4. `npm run typecheck` (`tsc --noEmit`)
5. `npm run lint`
6. `npm test`
7. `npm run build`
8. `npm audit --omit=dev`

No database is required for the standard CI run — nearly all tests use mocked Prisma and injected dependencies.

### Test Architecture

- **Pure unit tests:** Most tests import pure functions and test them with injected mock dependencies (no real DB, no HTTP).
- **Route integration tests (mocked persistence/services):** `integration-coverage.test.ts` and `qr-routes-hardening.test.ts` import a route's `…Impl` function and call it directly, injecting a typed `AuthResolvers` object for auth and mutating the shared Prisma singleton's methods for persistence. Shopify network calls are mocked via injected `deps` or `globalThis.fetch` stubs. These are NOT real end-to-end tests — no Next.js server, no HTTP layer, no database, and no live Shopify API are exercised.
- **One real-database-gated test:** `point-account-concurrency.test.ts` exercises actual PostgreSQL uniqueness/transaction behavior (concurrent account-creation races) that a mocked client cannot faithfully reproduce. It is skipped by default (and in standard CI) and only runs when pointed at a real, disposable database — see the file header for the exact opt-in procedure. This is currently the only test in the suite that touches a real database.
- **No end-to-end (full server + live Shopify) tests:** There is no test that drives the running Next.js server or the live Shopify API. The flows that require those (embedded launch, token exchange/refresh, real discount creation/redemption, SMTP delivery, webhook delivery) must be verified manually — see the manual-test list in any pre-merge review.
- **Shopify network mocking:** Token manager, session token verifier, and reconciliation tests use injected `deps` objects instead of real Shopify API calls.
- **Auth injection:** No global hooks. Each route's `…Impl(req[, ctx], deps: AuthResolvers)` takes the resolvers explicitly; production `GET`/`POST` wrappers bind `realAuthResolvers`; tests pass mock resolvers.

---

## K. Database Migrations

### Local Migration Folders

`prisma/migrations/` currently contains the following folders, oldest first (verify with `ls prisma/migrations`, since this list will grow):

`20250909_clean_baseline`, `20260324050853_rename_shopify_admin_token`, `20260327160420_add_campaign_why_video_fields`, `20260329153000_optimize_public_experience_queries`, `202604_lms_migration`, `20260505120000_move_why_video_to_experience`, `20260530120000_add_shopify_connection_status`, `20260601120000_add_shopify_reward_offers`, `20260614120000_add_lesson_video_storage_reference`, `20260615075700_add_percentage_rewards`, `20260615113320_campaign_unlock_anon_unique`, `20260615120000_shopify_expiring_tokens`, `20260615140000_redemption_reconciliation`, `20260615150000_evidence_based_indexes`, `20260703120000_add_user_point_account_lifetime_rewards`, `20260716120000_harden_auth_sessions_and_verification`, `20260716130000_remove_external_role`, `20260716131000_verified_user_welcome_queue`, `20260717140000_welcome_email_worker_retries`, `20260718120000_shopify_store_reward_compatibility`, `20260719061157_remove_legacy_user_points`.

**A local migration folder existing in this list is not, by itself, evidence that it has been applied to production.** The only migration in this list independently confirmed applied to production (verified `migrate status` up to date, empty `migrate diff`, and matching row/column counts before and after) is `20260719061157_remove_legacy_user_points`, on 2026-07-19 — see `docs/points-ledger.md`. For the status of any other migration, its deployment history, and the historical local/production divergence this repository has previously had, see **`docs/prisma-migrations.md`** — treat that file, not this table, as authoritative for migration deployment status. Never infer that every earlier migration was applied merely because a later one was.

### Key Index Summary

### Key Index Summary

| Table | Index | Purpose |
|---|---|---|
| `ShopifyRewardRedemption` | `(offerId, status)` | Global offer cap query |
| `ShopifyRewardRedemption` | `(offerId, userId, status)` | Per-user offer cap query |
| `ShopifyRewardRedemption` | `(status, needsManualReview, createdAt)` | Reconciliation batch selection |
| `PointTransaction` | `(shopifyRewardRedemptionId, reason)` UNIQUE | Exactly-once refund guard |
| `CampaignUnlock` | `(campaignId, anonKey) WHERE anonKey IS NOT NULL AND userId IS NULL` PARTIAL UNIQUE | Anonymous unlock dedup |
| `EmailVerificationToken` | `(userId)` | User-based token lookup |
| `TokenStore` | `(expiresAt)` | Expiry-based cleanup |

---

## L. Risk Map

### Auth-Sensitive Files
- `src/middleware.ts` — route protection; removing a route from `matcher` or `isProtectedRoute` exposes it publicly
- `src/lib/auth-session.ts` — typed `AuthResolvers` DI seam; `realAuthResolvers` is the only production resolver. No global hooks, no `NODE_ENV` bypass — tests inject mocks by calling `…Impl` functions directly
- `src/lib/brand-auth.ts` — `getBrandAdminContext()` / `getBrandManagementContext()` — one shared implementation, called in every Brand/Shopify-management API and the `/dashboard/brand/**` layout (see "Brand-management authorization policy" in `docs/agent-context.md`)
- `src/lib/admin-auth.ts` — `getAdminContext()` — called in every admin API
- `src/lib/creator-auth.ts` — creator gating; deliberately no ADMIN override
- `src/lib/security/timing-safe-equal.ts` — generic constant-time secret comparison (`timingSafeEqualString`); used by both internal worker `x-cron-secret` checks and `src/lib/shopify.ts`'s `safeHmacEqual`
- `src/lib/auth/credential-login.ts` — pure, injectable credential-login policy used by NextAuth's `authorize()`; always runs a bcrypt comparison (real hash or a fixed dummy hash) before revealing email-verification/approval state, so a wrong password can't be used to enumerate account state
- `src/app/api/auth/[...nextauth]/options.ts` — JWT callback adds `role`, `isActive`, `roleCheckedAt` to token; deactivated/missing users set `token.accountInvalidated = true`, and the session callback then returns `user: undefined` (forced sign-out)

### Payment / Discount / Points-Sensitive Files
- `src/app/api/rewards/shopify/redeem/route.ts` — **HIGHEST RISK** — serializable transaction, point debit, Shopify discount creation, idempotency, bounded code-collision retry, refund logic
- `src/lib/points.ts` — `awardQrScanPoint()` — idempotency relies on unique DB constraint
- `src/lib/reward-offers.ts` — `getRewardOfferAvailability()` — gating logic checked inside TX
- `src/lib/reward-access.ts` — `getRewardClaimContext()` — determines which brands a user can redeem from
- `src/lib/reward-redemption-state.ts` — all status transitions must go through `assertTransition()`
- `src/lib/reward-reconciliation.ts` — exactly-once refund catches P2002 OUTSIDE the transaction

### Webhook / HMAC-Sensitive Files
- `src/lib/shopify.ts` — `verifyShopifyWebhookHmac()`, `safeHmacEqual()` — timing-safe compare
- `src/lib/shopify-webhooks.ts` — `verifyShopifyWebhookRequest()` — called by all 4 webhook handlers
- `src/lib/shopify-session-token.ts` — `timingSafeBase64urlEqual()` — signature verified BEFORE claims parsed
- `src/app/api/shopify/webhooks/app/uninstalled/route.ts` — clears Shopify tokens from DB
- `src/middleware.ts:7` — webhook bypass; do not remove this without understanding consequences

### Encryption-Sensitive Files
- `src/lib/crypto.ts` — AES-256-GCM; key is derived from `APP_ENCRYPTION_KEY`; changing the key breaks all existing encrypted tokens
- `prisma/schema.prisma` — `Brand.shopifyAdminAccessTokenEncrypted` and `Brand.shopifyRefreshTokenEncrypted` — contains encrypted Shopify tokens; never log or return raw

### Rate-Limiting Risks
- In-memory `Map` resets per serverless cold start; not deployment-wide enforcement
- Legitimate high-volume QR campaigns need 60/hr headroom per IP — adjust if campaigns exceed this
- No rate limit on `/api/rewards/shopify/redeem` (relies on point balance + idempotency instead)

### Production Exposure Risks
- `/dev/email-preview` and `/dev/email-preview/invite` — dev-only; both return HTTP 404 when `NODE_ENV === "production"`
- User deletion returns 409 for users with campaigns/QR codes — deactivation is the recommended alternative
- Forced sign-out uses the `token.accountInvalidated` flag (JWT callback) + `user: undefined` (session callback); this relies on next-auth v4 runtime behavior — monitor on next-auth upgrades

### Files That Can Break Shopify Review
- `src/app/api/shopify/webhooks/` — all 4 GDPR webhooks must respond 200 (Shopify tests these)
- `src/lib/shopify.ts:SHOPIFY_SCOPES` — only `read_products`, `read_discounts`, `write_discounts` are requested
- `src/lib/shopify-session-token.ts` — embedded auth; removing signature verification fails review

---

## M. Token-Saving Agent Guide

### General Rules

- **Before editing any API route**, check which auth context function it calls (`getAdminContext`, `getBrandAdminContext`, `getBrandManagementContext`, `getServerSession`, `resolveSession`, `resolveBrandAdminContext`) — that's your auth contract.
- **Before touching point balances**, read `src/lib/points.ts` and understand the `PointTransaction` unique constraints. `User.points` is deprecated, unused by application code, and removed from the Prisma schema; its physical column is dropped only once migration `20260719061157_remove_legacy_user_points` is applied (an environment may still physically retain the unused column before then). `UserPointAccount` is the sole balance store in application logic. Any direct `UserPointAccount.update` outside `applyPointLedgerEvent`, without a matching `PointTransaction`, will corrupt the ledger.
- **Never change these without checking everything that uses them:**
  - `User.role` enum values → used in middleware, all auth helpers, JWT callback
  - `ShopifyRewardRedemptionStatus` state machine → redemption UI, refund logic, reconciliation, status refresh
  - `CLAIM_COUNTED_REDEMPTION_STATUSES` → all limit-checking code
  - `CampaignUnlock` unique constraints → QR idempotency + anonymous dedup

### For Shopify Work

Read these files first:
1. `src/lib/shopify.ts` — API version, scopes, HMAC helpers, OAuth helpers
2. `src/lib/shopify-session-token.ts` — App Bridge JWT verification
3. `src/lib/shopify-token-manager.ts` — Token lifecycle, CAS refresh, scope check
4. `src/lib/crypto.ts` — encryption/decryption for access tokens
5. `src/lib/shopify-webhooks.ts` — webhook HMAC verification
6. `src/lib/pending-install.ts` — LEGACY + EXPIRING install payload shapes
7. `src/app/api/shopify/embedded/session/route.ts` — token exchange endpoint

**Never:**
- Store `decryptSecret(...)` in any log or response body
- Bypass HMAC verification on webhooks
- Remove `timingSafeEqual` / `timingSafeBase64urlEqual` from any HMAC check
- Change `SHOPIFY_API_VERSION` without testing all GraphQL queries/mutations
- Add scopes beyond `read_products`, `read_discounts`, `write_discounts`

### For Points / Rewards Work

Read these files first:
1. `src/lib/reward-redemption-state.ts` — state machine (single source of truth for all status logic)
2. `src/lib/reward-reconciliation.ts` — stuck-redemption recovery
3. `src/lib/points.ts` — `awardQrScanPoint()`
4. `src/lib/reward-access.ts` — `getRewardClaimContext()`
5. `src/lib/reward-offers.ts` — `getRewardOfferAvailability()`, `generateRewardCode()`
6. `src/lib/shopify-discounts.ts` — `createShopifyRewardDiscountCode()`
7. `src/app/api/rewards/shopify/redeem/route.ts` — full redemption transaction

**Never:**
- Remove the `isolationLevel: Serializable` from the redemption transaction
- Remove the `debit.count !== 1` guard (race condition protection)
- Skip the idempotency key check at the top of the redeem handler
- Modify `CLAIM_COUNTED_REDEMPTION_STATUSES` without auditing all limit-checking code
- Delete `PointTransaction` rows — they are an immutable audit ledger
- Weaken the composite unique `(shopifyRewardRedemptionId, reason)` — it's the exactly-once refund guard
- Alter accepted reconciliation/state-machine code without a new test proving a defect

### For QR / Campaign Work

Read these files first:
1. `src/lib/qr-redemption.ts` — atomic QR status transition
2. `src/app/api/public/scan/route.ts` — full scan handler
3. `src/lib/anon-merge-keys.ts` — anonymous merge-key collection
4. `prisma/schema.prisma` — `QRCode`, `CampaignUnlock`, `PointTransaction` models

**Never:**
- Change `QRCode` status transitions outside of `redeemQrCodeForUser()`
- Remove the `status: "NEW"` filter in `updateMany` — it's the atomic guard against double-redemption
- Remove the partial unique index migration for anonymous unlock dedup

---

## Assumptions

1. Deployment is Vercel (based on env structure).
2. Supabase project handles both PostgreSQL and file storage.
3. The Shopify app has two configurations: public (for Shopify app review) and custom (for testing).
4. `APP_ENCRYPTION_KEY` is the sole server-only Shopify credential encryption key. `NEXTAUTH_SECRET` independently signs authentication sessions; it is not an encryption fallback.
5. Migration deployment status should always be re-verified with `prisma migrate status` / `prisma migrate diff` rather than assumed from this document — see `docs/prisma-migrations.md`.
