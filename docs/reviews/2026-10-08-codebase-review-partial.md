# SQRATCH codebase review — partial (2026-10-08)

Status: **incomplete**. The security pass is mostly done; the UI/UX and business-logic passes were only started. Read-only review; nothing below has been changed in code.

## Security

| # | Severity | Finding | Where | Recommended change |
| --- | --- | --- | --- | --- |
| S1 | High | Credential sign-in has no rate limit, backoff or lockout (bcrypt cost is the only brake) | `src/app/api/auth/[...nextauth]/options.ts` `authorize` | Per-email and per-IP limits backed by a shared store (Upstash/Redis or a Postgres table), exponential backoff after failures |
| S2 | Medium | All rate limits are in-memory per serverless instance (documented in the code), so limits on signup, verification resend, scan and waitlist are weak on Vercel | `src/lib/rate-limit.ts` | Move to a shared store; keep the same call sites |
| S3 | Medium | No global security headers: no `frame-ancestors`/X-Frame-Options outside the two Commerce7 pages, no `X-Content-Type-Options`, no CSP | `next.config.ts` | Global `frame-ancestors 'self'` (exempt the Shopify embedded and Commerce7 connect routes), `nosniff`, a Referrer-Policy, then a report-only CSP |
| S4 | Medium (privacy) | Display names fall back to the user's email, exposing it to other users: commenters to every experience viewer; question askers and answerers to creators | `src/app/api/posts/[postId]/comments/route.ts`, `src/app/api/questions/route.ts` (`name \|\| email`) | One display-name helper that never returns an email (e.g. "SQRATCH member") |
| S5 | Medium | No password reset flow exists | — | Token-based reset (hashed, single-use, short TTL) that bumps `sessionVersion` |
| S6 | Low | Admins can demote or deactivate themselves or the last admin; admin role changes are not audit-logged | `src/app/api/admin/users/route.ts` | Block self-changes, keep at least one active admin, add an audit table |
| S7 | Low | Comment bodies have no length cap and comment creation has no rate limit | `src/app/api/posts/[postId]/comments/route.ts` | Max length (e.g. 2,000) and a per-user limit |
| S8 | Low | `POST /api/public/session` creates an anonymous session row for every cookie-less request, with no limit | `src/app/api/public/session/route.ts` | Rate-limit, and prune stale anonymous sessions |
| S9 | Low | Signup reports "Email is already registered" (enumeration); name and application fields have no length caps | `src/app/api/auth/signup/route.ts` | Generic response plus email; cap field lengths; validate email format |
| S10 | Low | Upload type checks trust the client-declared MIME type; four near-duplicate upload routes | `src/app/api/uploads/*`, `creator/experiences/[id]/cover` | Magic-byte check and one shared upload helper |
| S11 | Info | `getCreatorContext` does not check `creatorProfile.isActive` | `src/lib/creator-auth.ts` | Require an active profile |

Verified sound: login timing (dummy bcrypt), session revocation via `sessionVersion`, email-code crypto (randomInt, peppered HMAC, constant-time compare, 5-attempt lock), Shopify OAuth (HMAC, single-use state bound to the shop), constant-time cron secrets, click redirects pinned to the storefront origin, QR tokens (21-char nanoid, single use), per-user ledger idempotency, no `dangerouslySetInnerHTML`, no unsafe raw SQL or `eval`.

## Business logic

| # | Severity | Finding | Recommended change |
| --- | --- | --- | --- |
| B1 | High (if lesson rewards matter) | Lesson completion is taken from the client (`isCompleted: true`) and immediately awards lesson and course points; the anonymous-progress merge also awards them. Points buy real discounts | Require server-side evidence (a server-recorded start time plus minimum watch time or progress heartbeats), or cap daily earnable points |
| B2 | Medium | Commerce7 purchase observer checks one claim per 10-minute run, so linking latency grows linearly (about 50 min with 5 claims) | Process several due claims per run within the time budget |
| B3 | Medium | Brands cannot invite teammates; memberships come only from admin approval | Brand team management (invite, role, remove) |
| B4 | Low | The Brand rewards view badges selected-product discount offers "Open for claims" even when a product became unavailable (the claim itself refuses) | Pass product availability into `commerce7OfferEligibility` once the catalog query is not capped at 500 |
| B5 | Low | Comment authors cannot delete their own comments; `canDeleteComment` is duplicated in two routes | Allow author deletion; share one helper |
| B6 | Low | Claimant listing does per-offer connection lookups and counts (N+1, up to 100 offers); the JWT callback queries the DB on every session read | Batch the lookups; consider short revalidation caching |

## UI / UX

| # | Finding | Recommended change |
| --- | --- | --- |
| U1 | "Revoke coupon" (irreversible) runs on one click without confirmation | Confirmation dialog stating the coupon is deleted and points are not refunded |
| U2 | Five destructive actions use native `window.confirm`; the app's AlertDialog is used only by the legacy admin page | Use AlertDialog consistently |
| U3 | Middleware sets `x-pathname` on the response, but the Brand layout reads request headers, so the Shopify-install access-denied message never shows | Use `NextResponse.next({ request: { headers } })` |
| U4 | Duplicate legacy surfaces: `/admin/*` vs `/dashboard/admin/*`, `/generateQR`, `/redeemQR/...`, `/home`, legacy `/api/qr/*` | Retire the legacy routes after redirects |
| U5 | No "Forgot password" link or show-password toggle; signup holds three near-duplicate forms (766 lines) | Add both; extract one form component |
| U6 | Experience client components (lesson, shop, posts, Q&A, course, learn) have almost no ARIA attributes | Accessibility pass: live regions for loading and errors, labelled controls, focus management |

## Not yet reviewed

UI/UX of the remaining pages (dashboard home, brand analytics, campaigns, products, creator tools, points), Shopify rewards and webhook code paths, campaign/experience access gating in depth, analytics privacy, and data retention.
