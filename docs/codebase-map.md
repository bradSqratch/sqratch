# SQRATCH Codebase Map

> Updated: 2026-06-15 · Next.js 15 · Prisma 7 · next-auth 4

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
| **Shopify** | Public embedded session-token/token-exchange flow plus legacy custom-app compatibility; Admin GraphQL API v2026-04 |
| **Encryption** | AES-256-GCM via `APP_ENCRYPTION_KEY`; used to store Shopify access tokens at rest |
| **Analytics** | Internal `AnalyticsEvent` table + Google Analytics (`NEXT_PUBLIC_GA_MEASUREMENT_ID`) |
| **Deployment** | Assumed Vercel (env structure, `NEXTAUTH_URL`, `VERCEL` reference) |

---

## B. Directory Map

```
sqratch/
├── prisma/
│   ├── schema.prisma          ← AUTHORITATIVE data model; edit with care
│   └── seed.ts                ← Dev seed only; never run in prod
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
│   │   │   ├── public/        ← Unauthenticated APIs (scan, experience viewer)
│   │   │   ├── rewards/       ← Reward redemption APIs
│   │   │   ├── shopify/       ← Shopify OAuth + webhooks
│   │   │   ├── qr/            ← QR code admin APIs
│   │   │   ├── uploads/       ← Supabase storage upload APIs
│   │   │   └── user/          ← User profile / points APIs
│   │   ├── c/[campaignSlug]/  ← Campaign landing page (public, post-scan)
│   │   ├── q/[qrCodeData]/    ← QR scan entry point (public)
│   │   ├── redeemQR/          ← Legacy QR redeem page
│   │   ├── x/[experienceSlug]/← Public experience pages
│   │   ├── shopify/           ← Shopify embedded app page (install landing)
│   │   └── (legal pages)      ← /privacy, /terms, /support, /about, /contact
│   ├── components/
│   │   ├── experience/        ← All public experience UI (hub, course, lesson, shop)
│   │   ├── brand/             ← Brand dashboard UI forms
│   │   ├── creator/           ← Creator dashboard UI forms
│   │   ├── admin/             ← Admin page shells
│   │   ├── rewards/           ← Shopify reward redemption UI
│   │   ├── ui/                ← shadcn/ui primitives — DO NOT edit directly
│   │   └── (root level)       ← Shared layout components (sidebar, navbar, etc.)
│   ├── lib/                   ← Server-side business logic (safe to import in API routes)
│   │   ├── prisma.ts          ← Singleton Prisma client
│   │   ├── session.ts         ← Anonymous session cookie management
│   │   ├── points.ts          ← Point award / overview logic
│   │   ├── qr-redemption.ts   ← QR code redemption atomics
│   │   ├── experience-access.ts ← Experience gating / viewer context
│   │   ├── reward-access.ts   ← Reward eligibility gating
│   │   ├── reward-offers.ts   ← Offer availability, code generation, payload parsing
│   │   ├── shopify.ts         ← OAuth helpers, HMAC, webhook registration
│   │   ├── shopify-discounts.ts ← Shopify Admin GraphQL discount CRUD
│   │   ├── shopify-products.ts  ← Shopify Admin GraphQL product fetch
│   │   ├── shopify-webhooks.ts  ← Webhook HMAC verification helper
│   │   ├── crypto.ts          ← AES-256-GCM encrypt/decrypt (Shopify tokens)
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
├── docs/                      ← THIS directory (AI agent context docs)
├── .shopify/                  ← Shopify CLI metadata (deploy bundle, project.json)
├── prisma.config.ts           ← Prisma config (points to schema.prisma)
├── .env                       ← Secret env vars — NEVER commit
└── .env.example               ← Public env template
```

**Casual-edit safe:** `src/components/ui/`, `src/content/legal/`, `src/data/`, `src/app/(home)/`, `src/app/about/`, `src/app/contact/`

**Edit with care (business logic):** `src/lib/`, `src/app/api/`, `prisma/schema.prisma`

**Never edit without full context:** `src/lib/crypto.ts`, `src/lib/shopify.ts`, `src/lib/shopify-discounts.ts`, `src/app/api/rewards/shopify/redeem/route.ts`, `src/app/api/shopify/webhooks/`

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
| `/x/[experienceSlug]/shop` | `...shop/page.tsx` | Experience shop tab (Shopify products) |
| `/x/[experienceSlug]/posts` | `...posts/page.tsx` | Experience posts/community |
| `/x/[experienceSlug]/qa` | `...qa/page.tsx` | Experience Q&A |
| `/shopify` | `shopify/page.tsx` | Shopify app install landing (embedded) |
| `/approval-pending` | `approval-pending/page.tsx` | Brand/creator approval pending screen |

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
| `/dashboard/points` | `.../points/page.tsx` | User points + transaction history |
| `/profile` | `(withSidebar)/profile/page.tsx` | User profile edit |

### Brand Dashboard Routes (auth + `BRAND_ADMIN` role)

| Route | Purpose |
|---|---|
| `/dashboard/brand/campaigns` | Campaign list + management |
| `/dashboard/brand/campaigns/new` | Create campaign |
| `/dashboard/brand/campaigns/[id]/edit` | Edit campaign |
| `/dashboard/brand/campaigns/[id]/experiences` | Attach experiences to campaign |
| `/dashboard/brand/rewards` | Reward offers management |
| `/dashboard/brand/qr-batches` | QR batch list |
| `/dashboard/brand/qr-batches/new` | Create QR batch |
| `/dashboard/brand/shopify` | Shopify integration status |
| `/dashboard/brand/shopify/install` | Shopify install confirmation UI |
| `/dashboard/brand/profile` | Brand profile edit |
| `/dashboard/brand/analytics` | Brand analytics |

### Creator Dashboard Routes (auth + `CREATOR` role)

| Route | Purpose |
|---|---|
| `/dashboard/creator/experiences` | Experience list |
| `/dashboard/creator/experiences/new` | Create experience |
| `/dashboard/creator/experiences/[id]/edit` | Edit experience |
| `/dashboard/creator/experiences/[id]/courses` | Manage courses |
| `/dashboard/creator/courses/[id]/lessons` | Manage lessons |
| `/dashboard/creator/posts` | Creator posts |
| `/dashboard/creator/analytics` | Creator analytics |

### Admin Routes (auth + `ADMIN` role, enforced in middleware)

| Route | Purpose |
|---|---|
| `/admin/qr-management` | QR code admin tools |
| `/admin/user-management` | User admin |
| `/admin/campaigns-management` | Campaign admin |
| `/admin/print-qr` | QR printing tool |
| `/dashboard/admin/approvals` | Brand/creator approval queue |
| `/dashboard/admin/brands` | Brand list |
| `/dashboard/admin/users` | User list |
| `/dashboard/admin/campaigns` | Campaign list |

### Key API Routes

See **Section D** for full API map.

---

## D. API Map

### Auth APIs

| Method | Path | Auth | Purpose | Side Effects |
|---|---|---|---|---|
| POST | `/api/auth/signup` | None | User signup (email+password) | Creates `User`, queues welcome email |
| POST | `/api/auth/send-email-verification` | Session | Triggers email verification send | Creates `EmailVerificationToken`, queues email |
| POST | `/api/auth/verify-email` | None | Consume email token | Sets `isEmailVerified=true` on `User` |
| GET | `/api/auth/check-roles-login` | None | Resolves role after next-auth login | None |
| * | `/api/auth/[...nextauth]` | — | next-auth handler (signin/signout/session) | Creates/updates `UserSession` |

### Public APIs (no auth required)

| Method | Path | Purpose | Key DB Tables | Notes |
|---|---|---|---|---|
| POST | `/api/public/scan` | Process QR scan | `QRCode`, `CampaignUnlock`, `PointTransaction`, `AnalyticsEvent`, `UserSession` | Core scan flow; awards points if logged in |
| GET | `/api/public/experience/[experienceSlug]` | Fetch experience data | `Experience`, `Campaign`, `Course` | Returns viewer context incl. unlock status |
| GET | `/api/public/experience/[slug]/courses/[courseSlug]` | Fetch course + lessons | `Course`, `Lesson` | |
| GET | `/api/public/experience/[slug]/lessons/[lessonId]` | Fetch lesson | `Lesson`, `LessonProgress` | |
| GET | `/api/public/experience/[slug]/products` | Fetch experience shop products | `ExperienceProductLink`, Shopify API | Calls Shopify for product data |
| GET | `/api/public/experience/[slug]/lessons/[id]/products` | Fetch lesson products | `LessonProductLink`, Shopify API | |
| GET | `/api/public/campaign/[campaignSlug]` | Fetch campaign data | `Campaign`, `Experience` | |
| GET | `/api/public/get-campaign-from-qrid` | Resolve QR → campaign | `QRCode`, `Campaign` | |
| GET | `/api/public/viewer-status` | Get viewer unlock status | `CampaignUnlock` | |
| POST | `/api/public/session` | Create/update session cookie | `UserSession` | Sets `sqr_session` cookie |
| POST | `/api/public/waitlist` | Join waitlist | `WaitlistEntry` | |

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
| GET/POST | `/api/brand/qr-batches` | BRAND_ADMIN | List / create QR batches | Creates `QRCodeBatch`, bulk generates `QRCode` rows |
| GET/PATCH | `/api/brand/qr-batches/[id]` | BRAND_ADMIN | Get/update batch | |
| PATCH | `/api/brand/qr-codes/[id]` | BRAND_ADMIN | Update single QR code | |
| GET/PATCH | `/api/brand/profile` | BRAND_ADMIN | Get/update brand profile | Updates `Brand` |
| GET/POST | `/api/brand/rewards/offers` | BRAND_ADMIN | List / create reward offers | Creates `BrandRewardOffer` + `BrandRewardOfferProduct` |
| GET/PATCH/DELETE | `/api/brand/rewards/offers/[offerId]` | BRAND_ADMIN + ownership | Manage offer | Modifies offer |
| GET | `/api/brand/shopify/status` | BRAND_ADMIN | Shopify connection status | None |
| GET | `/api/brand/shopify/products` | BRAND_ADMIN | Fetch products from Shopify | Calls Shopify Admin GraphQL |
| POST | `/api/brand/shopify/disconnect` | BRAND_ADMIN | Disconnect Shopify | Sets `shopifyConnectionStatus=DISCONNECTED` |
| GET | `/api/brand/analytics` | BRAND_ADMIN | Brand analytics | None |

### Shopify OAuth & Install APIs

| Method | Path | Auth | Purpose | Side Effects |
|---|---|---|---|---|
| GET | `/api/shopify/oauth/start` | None | Begin OAuth; redirect to Shopify | Creates `TokenStore` (state, 10min TTL) |
| GET | `/api/shopify/oauth/callback` | None | Receive Shopify callback; HMAC verify | Exchanges code for token; creates pending install `TokenStore` (24hr TTL) |
| GET | `/api/shopify/installations/[installId]` | Session | Load pending install options | None |
| POST | `/api/shopify/installations/[installId]` | Session + BRAND_ADMIN | Link install to brand | Updates `Brand`, registers webhooks, deletes pending `TokenStore` |

### Shopify Webhook APIs (no auth — HMAC verified)

| Method | Path | Trigger | DB Effect |
|---|---|---|---|
| POST | `/api/shopify/webhooks/app/uninstalled` | Shop uninstalls app | Sets `Brand.shopifyConnectionStatus=UNINSTALLED`, nulls token |
| POST | `/api/shopify/webhooks/customers/data_request` | GDPR data request | Logged/acknowledged |
| POST | `/api/shopify/webhooks/customers/redact` | GDPR customer redact | Logged/acknowledged |
| POST | `/api/shopify/webhooks/shop/redact` | GDPR shop redact | Logged/acknowledged |

### Reward APIs (auth required)

| Method | Path | Auth | Purpose | Side Effects |
|---|---|---|---|---|
| GET | `/api/rewards/shopify` | Session | List available reward offers for viewer | None |
| POST | `/api/rewards/shopify/redeem` | Session | Redeem reward (debit points + issue discount) | Creates `ShopifyRewardRedemption`, debits `User.points`, calls Shopify GraphQL |
| GET | `/api/rewards/shopify/redemptions` | Session | List user's redemptions | None |
| POST | `/api/rewards/shopify/redemptions/[id]/refresh-status` | Session | Re-check discount usage from Shopify | Calls Shopify GraphQL; may update `ShopifyRewardRedemption.status` |

### Progress APIs (session or auth)

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/progress/lesson` | Record lesson progress (anonymous or logged in) |
| POST | `/api/progress/merge` | Merge anonymous progress into user after login |

---

## E. Prisma / Data Model Map

### Core Identity Models

| Model | Purpose | Key Relationships | Lifecycle Notes |
|---|---|---|---|
| `User` | End user, brand admin, creator, or SQRATCH admin | Has many `BrandMember`, `CreatorProfile`, `CampaignUnlock`, `PointTransaction`, `ShopifyRewardRedemption`, `UserSession` | `role` enum controls access everywhere; `points` is a denormalized counter backed by `PointTransaction` |
| `UserSession` | Anonymous + authenticated browsing session | Belongs to `User?`, `Campaign?`, `QRCode?` | Created on QR scan; promoted to userId on login via `/api/progress/merge` |
| `EmailVerificationToken` | Email verification token | Belongs to `User` | Consumed on verify; `expires` field must be checked |

### Brand & Campaign Models

| Model | Purpose | Key Relationships | Lifecycle Notes |
|---|---|---|---|
| `Brand` | A brand entity (e.g. retailer using Shopify) | Has `BrandMember[]`, `Campaign[]`, `BrandRewardOffer[]`, `ShopifyRewardRedemption[]` | `shopifyAdminAccessTokenEncrypted` is AES-256-GCM encrypted; `shopifyConnectionStatus` drives all Shopify features |
| `BrandMember` | User ↔ Brand membership | `User`, `Brand` | `role: ADMIN\|MANAGER\|VIEWER`; only ADMIN+MANAGER can take actions |
| `BrandRequest` | Request to become a brand admin | `User` (owner), `User` (reviewer) | `ApprovalStatus: PENDING\|APPROVED\|REJECTED` |
| `Campaign` | A marketing campaign tied to a brand | `Brand?`, `QRCode[]`, `CampaignExperience[]`, `CampaignUnlock[]`, `QRCodeBatch[]` | Can exist without a Brand (admin campaigns); `slug` is the URL identifier |
| `CampaignUnlock` | Records that a user (or anon) has unlocked a campaign | `Campaign`, `User?`, `QRCode?` | Unique on `(campaignId, userId)`. Anon unlocks use `anonKey`. Merged to userId on login |

### QR Code Models

| Model | Purpose | Notes |
|---|---|---|
| `QRCode` | Individual QR code | `status: NEW\|USED\|INVALID`; `qrCodeData` is the unique scan token; transitions to USED atomically via `redeemQrCodeForUser` |
| `QRCodeBatch` | Group of QR codes for a campaign | Used for print management and bulk CSV export |

### Experience / Content Models

| Model | Purpose | Key Relationships |
|---|---|---|
| `CreatorProfile` | Creator's public profile | `User`, `Experience[]` |
| `CreatorRequest` | Request to become a creator | `User` |
| `Experience` | Top-level content hub (video, courses, posts, QA) | `CreatorProfile`, `Course[]`, `Post[]`, `Question[]`, `CampaignExperience[]` |
| `Course` | A course within an experience | `Experience`, `Lesson[]`; `access: PUBLIC\|PRIVATE` |
| `Lesson` | A video lesson within a course | `Course`, `LessonProgress[]`, `LessonProductLink[]` |
| `LessonProgress` | Per-user or per-session lesson progress | `User?`, `UserSession?`, `Lesson`; unique on `(userId, lessonId)` or `(sessionId, lessonId)` |
| `Post` | Community post on an experience | `Experience`, `PostComment[]` |
| `ExperienceProductLink` | Shopify product link for experience shop tab | `Experience`, `Brand?` |
| `LessonProductLink` | Shopify product link for lesson shop tab | `Lesson`, `Brand?` |

### Rewards Models

| Model | Purpose | Dangerous Fields |
|---|---|---|
| `BrandRewardOffer` | A reward offer created by a brand | `pointsCost`, `discountAmountCents`, `maxTotalRedemptions`, `maxRedemptionsPerUser` — changing these after offers are live can break user expectations |
| `BrandRewardOfferProduct` | Specific Shopify products a reward applies to | `shopifyProductGid` must be a valid Shopify GID |
| `ShopifyRewardRedemption` | Single redemption event | `idempotencyKey` (unique); `status` state machine; `code` (unique discount code); `shopifyDiscountNodeId` links to Shopify |
| `PointTransaction` | Immutable audit log of point changes | `points` can be negative (debit); `reason` enum; **never delete rows**; unique on `(userId, qrCodeId)` prevents double-award |

### Points

`User.points` is a **denormalized counter**. The source of truth for point history is `PointTransaction`. Always update both atomically inside a transaction. The unique constraint `(userId, qrCodeId)` on `PointTransaction` is the primary double-award guard.

### Internal / Support Models

| Model | Purpose |
|---|---|
| `TokenStore` | Key-value store for short-lived tokens (Shopify OAuth state, pending install payloads). Keyed by `service` string. Always check `expiresAt` |
| `EmailQueue` | Async email queue; processed by `/api/internal/email-worker` |
| `WaitlistEntry` | Marketing waitlist signups |
| `AnalyticsEvent` | Internal analytics events (QR scans, lesson views, etc.) |

### Enums Summary

| Enum | Values |
|---|---|
| `Role` | `USER`, `CREATOR`, `BRAND_ADMIN`, `ADMIN`, `EXTERNAL` |
| `ApprovalStatus` | `PENDING`, `APPROVED`, `REJECTED` |
| `QRStatus` | `NEW`, `USED`, `INVALID` |
| `ShopifyConnectionStatus` | `DISCONNECTED`, `CONNECTED`, `UNINSTALLED` |
| `ShopifyRewardRedemptionStatus` | `PENDING`, `POINTS_DEBITED`, `ISSUED`, `USED`, `EXPIRED`, `FAILED`, `REFUNDED`, `CANCELLED` |
| `PointReason` | `QR_SCAN`, `BONUS`, `REFERRAL`, `SHOPIFY_REWARD_REDEMPTION`, `SHOPIFY_REWARD_REFUND` |
| `RewardAppliesTo` | `ALL_PRODUCTS`, `SPECIFIC_PRODUCTS` |

---

## F. Core Business Flows

### 1. User Signup / Login

```
User submits signup form
→ POST /api/auth/signup
  → Creates User (bcrypt password hash, role=USER)
  → Queues WELCOME email (EmailQueue)
→ POST /api/auth/send-email-verification
  → Creates EmailVerificationToken (expires in 24h)
  → Sends email via Resend
→ User clicks email link → POST /api/auth/verify-email
  → Validates token, sets User.isEmailVerified=true
→ User signs in via next-auth credentials provider
  → JWT contains: id, email, role, name
```

### 2. QR Scan / Campaign Unlock

```
Physical QR printed → encodes unique qrCodeData string
User scans → browser opens /q/[qrCodeData]
  → Page calls POST /api/public/scan { qrCodeData }
    → Looks up QRCode + Campaign
    → Upserts UserSession (sets campaignId, qrCodeId)
    → If QR already USED: logs analytics, returns campaignSlug
    → If logged in:
      → TRANSACTION:
        → redeemQrCodeForUser (status: NEW → USED, atomic)
        → Creates CampaignUnlock (campaignId, userId, qrCodeId)
        → awardQrScanPoint → PointTransaction(+1, QR_SCAN) + User.points++
    → If anonymous:
      → Creates CampaignUnlock (campaignId, anonKey=sessionId)
    → Logs AnalyticsEvent(qr_scan)
  → Browser redirects to /c/[campaignSlug]
```

### 3. Points Awarding

```
QR Scan (authenticated):
  → awardQrScanPoint() in src/lib/points.ts
  → Creates PointTransaction(+1, QR_SCAN, qrCodeId)
  → Unique constraint (userId, qrCodeId) prevents double-award
  → User.points += 1

Points are always modified atomically:
  → PointTransaction row created first
  → User.points updated in same DB transaction
```

### 4. Brand Approval / Admin Flow

```
User requests brand status:
  → POST /api/admin/approvals (or UI form)
  → Creates BrandRequest (status=PENDING)

SQRATCH admin reviews at /dashboard/admin/approvals
  → PATCH /api/admin/approvals/brand/[requestId]
  → If APPROVED: Updates User.role=BRAND_ADMIN, creates Brand + BrandMember
  → If REJECTED: Updates BrandRequest.status=REJECTED
```

### 5. Shopify OAuth Install / Linking

```
Brand admin at /dashboard/brand/shopify clicks "Connect"
  → GET /api/shopify/oauth/start?shop=myshop.myshopify.com
    → Validates shop domain format
    → Generates CSRF state, stores in TokenStore (10min TTL)
    → Redirects to https://myshop.myshopify.com/admin/oauth/authorize

Shopify redirects back:
  → GET /api/shopify/oauth/callback?shop=&code=&state=&hmac=
    → Verifies HMAC against SHOPIFY_API_SECRET
    → Validates state in TokenStore (CSRF check)
    → Exchanges code for access_token (POST to Shopify)
    → Encrypts token (AES-256-GCM via APP_ENCRYPTION_KEY)
    → Stores pending install in TokenStore (24hr TTL)
    → Redirects to /dashboard/brand/shopify/install?install=[id]
      (or /login?next=... if not logged in)

User confirms install:
  → GET /api/shopify/installations/[installId] (load options)
  → POST /api/shopify/installations/[installId] { brandId or createBrand }
    → Validates brand ownership
    → Updates Brand (shopifyShopDomain, shopifyAdminAccessTokenEncrypted, status=CONNECTED)
    → Deletes pending install TokenStore
    → Calls registerShopifyWebhooks() → subscribes 4 Shopify webhooks
    → Redirects to /dashboard/brand/shopify?connected=1
```

### 6. Shopify Product Fetch

```
Brand dashboard → "Products" tab
  → GET /api/brand/shopify/products
    → getBrandAdminContext() — validates session + BRAND_ADMIN role
    → Fetches Brand with shopifyAdminAccessTokenEncrypted
    → decryptSecret(encryptedToken) → plain token
    → POST to https://{shop}/admin/api/2026-04/graphql.json
      → GraphQL: products(first:250) with images, variants, handle
    → Returns product list; updates Brand.shopifyLastProductSyncAt
```

### 7. Shopify Reward Offer Creation

```
Brand admin at /dashboard/brand/rewards → "New Offer"
  → POST /api/brand/rewards/offers
    → getBrandAdminContext() + brand ownership check
    → parseRewardOfferPayload() — validates all fields
    → Creates BrandRewardOffer (isActive=false by default)
    → If appliesTo=SPECIFIC_PRODUCTS: creates BrandRewardOfferProduct rows
```

### 8. Shopify Reward Redemption (critical path)

```
User at /x/[slug]/shop or /dashboard/points clicks "Redeem"
  → POST /api/rewards/shopify/redeem { offerId, idempotencyKey, experienceSlug? }
    
    1. Auth: getServerSession → must be logged in
    2. Idempotency: check ShopifyRewardRedemption by idempotencyKey
       → If exists + same user: return cached result
    3. Load offer + brand (incl. encrypted token)
    4. getRewardClaimContext() → verify user has unlocked the campaign/experience
    5. Check brand.shopifyConnectionStatus === CONNECTED
    6. Check user.points >= offer.pointsCost
    7. Check offer limits (maxTotalRedemptions, maxRedemptionsPerUser)
    
    8. SERIALIZABLE TRANSACTION:
       → Re-check offer + Shopify connection (inside TX)
       → Re-check limits (inside TX)
       → Create ShopifyRewardRedemption (status=PENDING)
       → User.updateMany({ points: { gte: pointsCost } }) → debit
         → If count !== 1: throw INSUFFICIENT_POINTS (race condition guard)
       → Create PointTransaction(-pointsCost, SHOPIFY_REWARD_REDEMPTION)
       → Update redemption status → POINTS_DEBITED
    
    9. Call createShopifyRewardDiscountCode() → Shopify GraphQL mutation
       → If fails: REFUND TRANSACTION:
          → User.points += pointsCost
          → Create PointTransaction(+pointsCost, SHOPIFY_REWARD_REFUND)
          → Update redemption status → REFUNDED
          → Return error + refunded redemption
    
   10. If Shopify succeeds:
       → Update redemption: status=ISSUED, shopifyDiscountNodeId, issuedAt, expiresAt
       → Return redemption with discount code
```

### 9. Shopify Uninstall Webhook

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

**Note:** Shopify webhooks bypass the middleware JWT check (explicit passthrough in `src/middleware.ts:9`).

### 10. Public Experience Shop (Product Display)

```
User at /x/[slug]/shop
  → Component: src/components/experience/shop-client.tsx
    → Calls GET /api/public/experience/[slug]/products
      → Loads ExperienceProductLink[] (stored Shopify product metadata)
      → Optionally re-fetches live data from Shopify products API
    → Renders src/components/rewards/shopify-shop-reward-card.tsx
      → Shows available reward offers for brands linked to this experience
      → "Redeem" button triggers the redemption flow above
```

---

## G. Dependency Graph

### Scan Flow
```
/q/[qrCodeData]/page.tsx
  → POST /api/public/scan
    → lib/qr-redemption.ts → prisma (QRCode, CampaignUnlock)
    → lib/points.ts → prisma (PointTransaction, User)
    → prisma (AnalyticsEvent, UserSession)
```

### Reward Redemption Flow
```
components/rewards/shopify-rewards-client.tsx
  → POST /api/rewards/shopify/redeem
    → lib/reward-access.ts → lib/experience-access.ts → prisma (CampaignUnlock)
    → lib/reward-offers.ts (availability check, code generation)
    → prisma.$transaction (ShopifyRewardRedemption, PointTransaction, User)
    → lib/shopify-discounts.ts → lib/crypto.ts → Shopify Admin GraphQL API
```

### Shopify OAuth Flow
```
/dashboard/brand/shopify/page.tsx
  → GET /api/shopify/oauth/start → lib/shopify.ts (HMAC, state) → prisma (TokenStore)
  → GET /api/shopify/oauth/callback → lib/shopify.ts (HMAC verify) → Shopify token endpoint
    → lib/crypto.ts (encryptSecret) → prisma (TokenStore)
  → /dashboard/brand/shopify/install → GET+POST /api/shopify/installations/[id]
    → lib/crypto.ts (decryptSecret) → prisma (Brand, BrandMember, TokenStore)
    → lib/shopify.ts (registerShopifyWebhooks) → Shopify Admin GraphQL API
```

### Auth Gate Pattern
```
Any brand API route
  → lib/brand-auth.ts::getBrandAdminContext()
    → next-auth getServerSession → prisma (BrandMember → Brand)
    → Returns BrandAdminContext or null
```

---

## H. Risk Map

### Auth-Sensitive Files
- `src/middleware.ts` — route protection; removing a route from `matcher` or `isProtectedRoute` exposes it publicly
- `src/lib/brand-auth.ts` — `getBrandAdminContext()` / `getBrandManagementContext()` — called in every brand API
- `src/lib/admin-auth.ts` — `getAdminContext()` — called in every admin API
- `src/lib/creator-auth.ts` — creator gating
- `src/app/api/auth/[...nextauth]/options.ts` — JWT callback adds `role` to token; tampering breaks RBAC

### Payment / Discount / Points-Sensitive Files
- `src/app/api/rewards/shopify/redeem/route.ts` — **HIGHEST RISK** — serializable transaction, point debit, Shopify discount creation, refund logic
- `src/lib/points.ts` — `awardQrScanPoint()` — idempotency relies on unique DB constraint
- `src/lib/reward-offers.ts` — `getRewardOfferAvailability()` — gating logic checked inside TX
- `src/lib/reward-access.ts` — `getRewardClaimContext()` — determines which brands a user can redeem from

### Webhook / HMAC-Sensitive Files
- `src/lib/shopify.ts` — `verifyShopifyWebhookHmac()`, `buildShopifyHmac()` — timing-safe compare
- `src/lib/shopify-webhooks.ts` — `verifyShopifyWebhookRequest()` — called by all 4 webhook handlers
- `src/app/api/shopify/webhooks/app/uninstalled/route.ts` — clears Shopify tokens from DB
- `src/middleware.ts:9` — webhook bypass; do not remove this without understanding consequences

### Encryption-Sensitive Files
- `src/lib/crypto.ts` — AES-256-GCM; key is derived from `APP_ENCRYPTION_KEY`; changing the key breaks all existing encrypted tokens
- `prisma/schema.prisma` — `Brand.shopifyAdminAccessTokenEncrypted` — contains encrypted Shopify tokens; never log or return raw

### DB Migration-Sensitive Files
- `prisma/schema.prisma` — any change to `PointTransaction`, `ShopifyRewardRedemption`, `CampaignUnlock` unique constraints could break idempotency guards
- Adding nullable fields is safe; making nullable → non-nullable requires migration + backfill
- `User.points` is a denormalized counter — never migrate it without also migrating `PointTransaction` in sync

### Files That Can Break Shopify Review
- `src/app/api/shopify/webhooks/` — all 4 GDPR webhooks must respond 200 (Shopify tests these)
- `src/lib/shopify.ts` — HMAC verification must remain; removing it fails Shopify security review
- `src/lib/shopify.ts:SHOPIFY_SCOPES` — only `read_products`, `read_discounts`, `write_discounts` are requested; adding scopes requires Shopify app review update

### Files That Can Break Public Experience Pages
- `src/components/experience/experience-shell.tsx` — shared wrapper for all /x/ pages
- `src/components/experience/shop-client.tsx` — experience shop; depends on `BrandRewardOffer` + Shopify product data
- `src/lib/public-experience.ts` — public experience data fetching
- `src/app/api/public/experience/[experienceSlug]/route.ts` — viewer context endpoint used by all experience pages

---

## I. Token-Saving Agent Guide

### General Rules

- **Before editing any API route**, check which auth context function it calls (`getAdminContext`, `getBrandAdminContext`, `getBrandManagementContext`, `getServerSession`) — that's your auth contract.
- **Before touching `User.points`**, read `src/lib/points.ts` and understand the `PointTransaction` unique constraint. Direct `User.update` on points without a `PointTransaction` will corrupt the ledger.
- **Never change these without checking everything that uses them:**
  - `User.role` enum values → used in middleware, all auth helpers, JWT callback
  - `ShopifyRewardRedemptionStatus` state machine → redemption UI, refund logic, status refresh
  - `CampaignUnlock` unique constraints → QR idempotency

### For Shopify Work

Read these files first:
1. `src/lib/shopify.ts` — API version, scopes, HMAC helpers, OAuth helpers
2. `src/lib/crypto.ts` — encryption/decryption for access tokens
3. `src/lib/shopify-webhooks.ts` — webhook HMAC verification
4. `src/app/api/shopify/oauth/start/route.ts` + `callback/route.ts` — full OAuth flow
5. `src/app/api/shopify/installations/[installId]/route.ts` — brand linking logic
6. `docs/shopify-testing.md` — testing instructions

**Never:**
- Store `decryptSecret(brand.shopifyAdminAccessTokenEncrypted)` in any log or response body
- Bypass HMAC verification on webhooks
- Change `SHOPIFY_API_VERSION` without testing all GraphQL queries/mutations

### For Points / Rewards Work

Read these files first:
1. `src/lib/points.ts` — `awardQrScanPoint()`
2. `src/lib/reward-access.ts` — `getRewardClaimContext()`
3. `src/lib/reward-offers.ts` — `getRewardOfferAvailability()`, `generateRewardCode()`
4. `src/lib/shopify-discounts.ts` — `createShopifyRewardDiscountCode()`
5. `src/app/api/rewards/shopify/redeem/route.ts` — full redemption transaction

**Never:**
- Remove the `isolationLevel: Serializable` from the redemption transaction
- Remove the `debit.count !== 1` guard (race condition protection)
- Skip the idempotency key check at the top of the redeem handler
- Modify `CLAIM_COUNTED_REDEMPTION_STATUSES` without auditing all limit-checking code

### For Public Experience Work

Read these files first:
1. `src/lib/experience-access.ts` — `getExperienceAccessContext()`, `ViewerContext`
2. `src/lib/session.ts` — `sqr_session` cookie and anonymous session management
3. `src/components/experience/experience-shell.tsx` — shared wrapper
4. `src/app/api/public/experience/[experienceSlug]/route.ts` — public data endpoint

**Never:**
- Remove the anonymous session (`sqr_session`) from QR scan flow — it tracks pre-login progress
- Make experience data endpoints require auth without checking anonymous viewer logic

### For QR / Campaign Work

Read these files first:
1. `src/lib/qr-redemption.ts` — atomic QR status transition
2. `src/app/api/public/scan/route.ts` — full scan handler
3. `prisma/schema.prisma` — `QRCode`, `CampaignUnlock`, `PointTransaction` models

**Never:**
- Change `QRCode` status transitions outside of `redeemQrCodeForUser()`
- Remove the `status: "NEW"` filter in `updateMany` — it's the atomic guard against double-redemption

---

## Files Created / Changed by This Document

- `docs/codebase-map.md` (this file) — **created**
- `docs/agent-context.md` — **created** (companion quick-reference)

## Assumptions

1. Deployment is Vercel (based on env structure).
2. Supabase project handles both PostgreSQL and file storage.
3. The Shopify app is a custom public app (not Shopify Plus partner app).
4. `APP_ENCRYPTION_KEY` is the primary encryption key; `NEXTAUTH_SECRET` is the fallback.

## Recommended Next Docs

1. `docs/env-vars.md` — document every env var, its purpose, and which services use it
2. `docs/prisma-migrations.md` — migration safety checklist, dangerous patterns to avoid
3. `docs/shopify-app-review.md` — checklist for Shopify partner review requirements
4. `docs/points-ledger.md` — detailed points accounting rules and audit procedures
