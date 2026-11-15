# SQRATCH improvement backlog

This is the remaining implementation backlog. Original review evidence is historical; check the current source before applying any proposed change. Phase and finding identifiers are stable.

## 1. Current baseline

P00–P08 implement disposable database tests, QR history safeguards, publication enforcement, atomic approvals, active-administrator protection, safer media persistence, brand-context preconditions and community display-name privacy. Manual acceptance covered the principal QR conflicts, private/public access, approval conflict, administrator self-demotion, cross-tab brand conflict and display-name privacy. Some browser and provider checks remain below. Draft experiences must return 404 on public viewer routes for everyone; authenticated creator-management screens retain editing and publishing access. Owner activity must not earn points or count as learner activity.

## 2. Outstanding issues

- **P1 — P13 / F-03b, C-04:** Media reference checks are not atomic with attachment; staged asset claiming is needed. Unknown save outcomes can leave orphans. Real isolated object-storage integration, response-loss and failure-path browser verification remain outstanding (X-12); do not claim immediate signed-URL revocation.
- **P1 — P07 / F-08:** Expected-brand headers remain optional for old tabs. After the compatibility release require them on all applicable brand mutations, retaining membership authorization and clear 409 conflicts. Browser-check rewards, products, uploads, global ADMIN and VIEWER cases.
- **P1 — P01/P02:** Browser-check deletion of untouched batches, individual deletion, all history blockers, stale eligibility conflicts, image failure and legacy printed redirects. Never destroy historical QR evidence.
- **P1 — P03/P04/P05/P08:** Complete remaining browser acceptance: non-owner and owner draft management, private/inactive content, no owner analytics or awards; concurrent decision UI; admin history deletion and simultaneous actions; nameless comment/question/answer displays. Existing PostgreSQL and mocked tests do not replace browser or external-service checks.
- **P2 — X-10:** Operator must verify migration/index deployment status before P38; local migration folders do not establish live state.
- **P2 — X-16:** Design global security headers with Shopify/Commerce7 embedding exemptions and report-only CSP; separate work, not part of the numbered phases.
- **P1 — D-16 / X-11:** Decide reward funding and budget; creator self-award prevention does not stop collusion with another account.
- **P2 — Past ledger drift:** Owner should run the read-only drift query in `docs/points-ledger.md`; any repair requires a separate data decision.
- **P2 — Deferred analytics:** C-07/A-04/A-05 captured payments and A-11 payment/refund activity need provider sandbox evidence and appropriate timestamps. A-17 conversion rates need a defined cohort, window and anonymous/account deduplication. A-22 product-health measures need instrumentation and baselines.
- **P2 — External verification:** GA4 live provider receipt, real storage behavior and deployed provider journeys require owner-authorized sandbox verification. Do not use production for automated QA.
- **P3 — O-06 / O-04 / F-08a:** Defer worker throughput changes until P40 measurements; any future cache keys include brand, connection, filters and permission-sensitive state. Retryable QR/profile-image cleanup remains future work beyond P13.
- Other previously noted but unverified issues (signup enumeration, comment length/author deletion, upload content sniffing) require separate verification; do not silently classify as resolved.

### Pending finding index

These rows retain review identifiers and proposed phase mappings. The mapped phase specifications below remain authoritative for intended scope; revalidate historical evidence.

| ID | Outstanding finding | Priority | Action | Phase |
|---|---|---|---|---|
| C-01 | QR list limits are 100 codes, 500 batch and campaign options | P2 | Paginate and search codes; load options independently | P26 |
| C-03 | Archive and revocation differ | P1 | Separate archive state from redemption availability | P11, P12 |
| C-04 | A reference check alone is not race-safe | P1 | Stop unsafe cleanup first, then claim-based cleanup | P06, P13 |
| C-05 | Qualification must be a staged transition | P1 | Additive policy per lesson, default legacy | P16–P19 |
| C-06 | Route verification-time awards through the qualification contract | P1 | One policy-aware award service used by both transfer paths now | P09 |
| C-07 | Correct labels first; captured-payment metrics later | P2 | Rename labels; defer payment metrics | P36, H |
| C-08 | Filters are not identical across panels | P2 | Share controls only where semantics match | P39 |
| C-09 | Fix behavior before reorganizing navigation | — | Navigation consolidation is last | P43 |
| F-01b | Archive, stop-new-redemptions, delete-unused-draft semantics | P1 | Additive archive state; per-code revocation; retain the existing strict unused-draft deletion predicate | P01, P11, P12 |
| F-01c | `isActive` is not enforced by scan or redemption; inspect values first | P1 | Do not reuse `isActive`. Add explicit state after a read-only value audit | P12 |
| F-01d | External image cleanup must follow persistence and be retryable | P1 | Reorder; make cleanup best-effort and later retryable | P01, P02, P13 |
| F-02 | Verification and login use different merge paths | P1 | One idempotent transfer service | P09 |
| F-02a | Verification consumes anonymous completions without awards | P1 | Shared policy-aware award step | P09 |
| F-02b | Merge consumes rows before awards and does not recover | P1 | Claim rows by id inside a transaction; settle awards idempotently | P09 |
| F-02c | Verification code is consumed before merge work | P1 | Separate verification outcome from transfer outcome | P09, P10 |
| F-02d | Authentication success and transfer success are separate outcomes | P2 | Report transfer state truthfully | P10 |
| F-03b | Staged assets, claim-before-delete, retryable deletion | P2 | Staged-asset table and sweeper | P13 |
| F-04b | Record actor, time and reason; separate applicant and internal notes | P2 | Additive fields | P15 |
| F-05 | Client completion authorizes spendable rewards | P1 | Server-evaluated checkpoint policy, staged | P16–P19 |
| F-05a | Transition rules: preserve config, ledger, legacy labelling, no re-earning | P1 | Keep ledger keys; add policy enum | P16–P19 |
| F-07a | Explain blocked actions; record administrative changes | P2 | Error copy in P05; audit table in P15 | P05, P15 |
| F-08a | Brand scope in caches and request identities; clear on switch | P3 | Guard covers the risk today; keep as a rule for future caching | P07 |
| U-01 | Customer home shows counts without destinations | P2 | Return resume targets and link them | P23 |
| U-02 | No forgotten-password recovery | P1 | Token-based recovery with session invalidation | P20 |
| U-03 | Login ignores transfer response; artificial delay | P2 | Check response; remove delay | P10 |
| U-04 | Pending approval is a static screen | P3 | Refreshable status | P24 |
| U-05 | Product failure hides rewards; reward errors look empty | P2 | Independent panel states | P22 |
| U-07 | Comment refresh returns early | P3 | Explicit refetch with in-flight guard | P22 |
| U-08 | Featured-video seek input has no accessible name | P3 | Label and `aria-valuetext` | P22 |
| U-09 | Creator post errors hide the editor | P2 | Inline error; keep form mounted | P25 |
| U-10 | Filtered results narrow selector options | P2 | Load options independently of the filter | P25 |
| U-11 | Late responses overwrite newer filters | P2 | Apply the existing guard pattern | P25 |
| U-12 | Q&A count then create allows overrun | P2 | Atomic capacity check | P21 |
| U-13 | QR inventory shows first 100 codes | P2 | See C-01 | P26 |
| U-14 | 50-result discovery can omit attached experiences | P2 | Separate attached list from discovery | P27 |
| U-15 | Store overview shows one preferred connection | P2 | Show all authorized connections | P28 |
| U-16 | Connection trouble switches or hides the rewards workspace | P2 | Preserve provider workspace and history | P29 |
| U-17 | Limited product subsets drive selection and diagnostics | P2 | Paginated canonical picker; resolve offer references by id | P29 |
| U-18 | Newest-100 caps hide older claims | P2 | Pagination and status filters for Commerce7; bound the customer list | P29 |
| U-19 | Preview fetch updates the canonical sync timestamp | P2 | Stop preview from writing the canonical field | P28 |
| U-20 | Provider panels have inconsistent surrounding controls | P3 | Move the selector inside the shell | P29 |
| U-21 | Working functionality described as future work | P3 | Link to the working task | P28 |
| U-22 | Admin brands shows Shopify only | P2 | Canonical connections with status | P30 |
| U-23 | Mail failure reports failure after the account is saved | P2 | Return created account plus delivery state; resend | P14 |
| U-24 | Only three memberships shown, no total | P3 | Count and full detail view | P30 |
| U-25 | Decision reason missing from the UI | P2 | Reason input, required on reject | P15 |
| U-26 | Catalog truncation is not a redemption bypass | — | Confirm in P29 by reading the claim route before changing pickers | P29 |
| N-01 | Customer organizing principle: resume and benefits | P2 | First step is U-01 | P23 |
| N-02 | Creator: manage one experience | P3 | Experience context header | P34 |
| N-03 | Brand: operate one campaign | P3 | Campaign workspace nav | P33 |
| N-04 | Superadmin: actionable queue | P3 | State and history via P15, P30, P40 | P15, P30, P40 |
| N-05 | Consolidated navigation sets per role | P3 | Last | P43 |
| K-01 | Campaign flow as contextual guidance, not a wizard | P3 | Guidance strip | P33 |
| K-02 | Readiness tiers: blocker, warning, optional, provider limitation | P3 | Server-computed readiness | P33 |
| K-03 | Do not block content campaigns lacking commerce | — | Acceptance criterion | P33 |
| K-04 | Attachment stays immediate; show creator identity | P3 | Show creator name in attach UI | P27 |
| S-01 | Preserve filters in URLs | P3 | URL-backed filters | P32 |
| S-02 | Preserve unsaved work after recoverable errors | P2 | Covered per surface | P25, P31 |
| S-03 | Warn before brand switch or navigation that discards edits | P3 | Dirty-form guard | P31 |
| S-04 | Consistent destructive confirmation | P3 | Shared AlertDialog with stated consequences | P31 |
| S-05 | Show partial success explicitly | P3 | Per surface | P14, P31 |
| S-06 | Panel-level retries | P3 | Per surface | P22, P25, P31 |
| S-07 | Consolidate Contact and Support | P3 | Merge content, keep both URLs | P43 |
| S-08 | Consolidate overlapping admin routes after parity | P3 | Consolidate with redirects | P43 |
| A-01 | Creator engagement and commerce default to different periods | P2 | Explicit shared default, displayed | P36 |
| A-02 | Completion counts use mutable timestamps | P2 | Label current state; add immutable timestamp | P36, P37 |
| A-03 | Conversion reporting uses ingestion date | P2 | Label now; provider-date basis next | P36, P38 |
| A-04 | "Gross revenue" includes unpaid order totals | P2 | Rename to attributed order value | P36 |
| A-05 | Partially paid orders contribute full value | P2 | Rename to current net attributed order value | P36 |
| A-06 | Drilldown loses date and filter context | P3 | Carry supported scope | P39 |
| A-07 | All matching orders are materialized | P3 | Measure first | P42 |
| A-08 | Do not silently change a field's financial meaning | — | Additive names, deprecate old | P36 |
| A-09 | Every report states period, timezone, basis, scope, statuses, currency, freshness | P3 | Shared response metadata | P39 |
| A-10 | Provider order date with visible fallback and count | P2 | Basis parameter and fallback count | P38 |
| A-11 | Separate order cohort from payment and refund activity | P3 | Cohort in P38; activity reporting deferred pending provider evidence | P38, H |
| A-13 | Entry, product-authorizing and managed campaign are distinct | P3 | Section-specific scope labels | P39 |
| A-14 | Shared filter controls only where semantics match | P3 | Scope labels per panel | P39 |
| A-15 | Product breakdown must state orders-containing versus allocated value | P3 | Read the label in P39; state "orders containing" | P39 |
| A-16 | Place reporting beside decisions (ten surfaces) | P3 | Delivered incrementally | P23, P33, P34, P40 |
| A-17 | Funnels only where evidence supports them | P3 | Stage counts only | P41 |
| A-18 | Attribution is not incrementality or commission | — | Acceptance criterion | P39, P41 |
| A-19 | Minimum reporting response contract | P3 | Shared metadata type | P39 |
| A-20 | Immutable business events; no manufactured history | P2 | Add `completedAt`, set once, never backfilled | P37 |
| ST-B | Stage B: shared correctness contracts | P1–P2 | Kept; qualification split into four phases | P09–P19 |
| ST-C | Stage C: daily workflow friction | P2–P3 | Kept | P20–P35 |
| ST-D | Stage D: correct analytics | P2–P3 | Kept | P36–P41 |
| ST-E | Stage E: consolidate and optimize | P3 | Conditional phases | P42–P45 |
| I-03 | Shared anonymous-transfer state and pending award work | P1 | Derived status; no new table (D-02) | P09 |
| I-04 | Versioned qualification and checkpoint records | P1 | Additive models | P16 |
| I-05 | Separate archival and redemption-availability semantics | P1 | Additive columns | P11, P12 |
| I-06 | Accurate analytics names, basis, coverage, pagination metadata | P2 | Additive fields | P36–P39 |
| O-01 | Sidebar uses plain anchors | P3 | `next/link` | P35 |
| O-02 | Workspace loading and error boundaries | P3 | Add at dashboard segment level | P35 |
| O-03 | Debounce searches; reject superseded results | P3 | Apply to remaining lists | P32 |
| O-05 | Monitor worker backlog and oldest pending age | P3 | Read-only operations panel | P40 |
| O-07 | Shared rate limiting where deployment-wide enforcement is required | P2 | Shared store; login throttle | P44 |
| O-08 | Keep revocation checks; remove redundant per-request work | P3 | Conditional on measurement | P45 |
| O-09 | Scale risks are not measured outages | — | Baselines before optimizing | P42 |
| T-01 | QR lifecycle acceptance | — | Phase tests | P11, P12 |
| T-02 | QR concurrency: consistent winner | — | Phase tests | P12 |
| T-03 | Transfer retries and concurrent progress award once | — | Phase tests | P09 |
| T-04 | Recovery without reusing a consumed code | — | Phase tests | P09, P10 |
| T-05 | Participation: client completion and seeking do not qualify | — | Phase tests | P16–P18 |
| T-06 | Media: lost response keeps committed media; cleanup cannot race | — | Phase tests | P06, P13 |
| T-10 | List completeness beyond 100, 500, 50, 100 | — | Phase tests | P26, P27, P29 |
| T-11 | Provider failures preserve history and context | — | Phase tests | P28, P29 |
| T-12 | Analytics truthfulness cases | — | Phase tests | P36–P39 |
| T-13 | UI recovery | — | Phase tests | P25, P31, P32 |
| T-14 | Accessibility | — | Manual browser pass | P22, P31 |
| T-15 | Performance comparison before and after | — | Baseline first | P42 |
| X-04 | Scan and public campaign ignore `Campaign.isActive` and `Brand.isActive` | P2 | Product decision D-04 before any enforcement | P12 |
| X-06 | Verification accepts a body-supplied anonymous key | P2 | Accept cookie-bound keys only | P09 |
| X-08 | Creator analytics end-of-day uses server-local time; no date validation | P2 | Use the strict UTC resolver | P36 |
| X-09 | Voided and cancelled orders count in "gross"; `cancelledAt` is unread | P2 | Covered by renaming plus a status breakdown | P36 |
| X-10 | `(brandId, createdAt)` order index is documented as not applied | P2 | Confirm before analytics phases | E |
| X-11 | Creator reward budgets remain undecided; colluding accounts can earn points | P1 | Preserve the owner-award exclusion and decide funding and limits | D-16 |
| X-12 | Missing-object behavior of storage signing remains unverified | P2 | Verify per-lesson fallback with isolated storage | P06, P13 |
| X-14 | Middleware sets `x-pathname` on the response, so layouts cannot read it | P3 | Forward as a request header | P35 |
| X-15 | Q&A daily window uses the server-local day | P3 | Define as UTC day | P21 |
| X-16 | No global `nosniff`, frame or CSP headers | P2 | Separate hardening work | H |
| DEP-01 | `xlsx` high-severity advisories, no fix, dev-only | P3 | Replace or isolate | P46 |
| DEP-02 | Moderate advisories in `@typescript-eslint/*` and `minimatch` | P3 | Align versions | P46 |

## 3. Remaining implementation phases

### P09 — Unified anonymous transfer service

- **Priority and complexity:** P1, L. Reward correctness and durable recovery across two entry points.
- **Problem and evidence:** Two implementations exist. Verification (`src/app/api/auth/verify-email/route.ts:11-106,184-234`) transfers lesson progress with no award call and wraps a ledger call in `try/catch` inside a transaction (`:93-103`), which cannot recover in PostgreSQL once a statement has failed. Login (`src/app/api/progress/merge/route.ts:59-131`) upserts without a transaction, deletes every row for the session at `:101-105` including rows written after the read at `:39`, and only logs award errors at `:126-131`. A merge error during verification returns 500 "error during verification" although the code is consumed and the account verified (`:130-137,241-246`). Verification also merges a body-supplied key (`:114,164`).
- **Desired outcome:** One service moves anonymous progress and unlocks to an account. It is safe to call repeatedly and concurrently, never deletes rows it did not claim, awards once, and reports `complete` or `retry_required`. Verification success never depends on transfer success.
- **Scope:** new `src/lib/anonymous-transfer.ts`; `src/app/api/auth/verify-email/route.ts`; `src/app/api/progress/merge/route.ts`; `src/app/api/progress/lesson/route.ts` (atomic progress merge only); `src/lib/anon-merge-keys.ts`; `tests/integration-coverage.test.ts` merge scenario; `tests/anon-merge-keys.test.ts`.
- **Implementation requirements:**
  1. `transferAnonymousState({ userId, userEmail, sessionId, legacyUnlockKeys })` returns `{ status, mergedLessons, mergedUnlocks, pointsAwarded }`.
  2. Lesson rows: read the session's row ids, then for each row run one transaction that (a) claims it with `deleteMany({ where: { id, sessionId } })` and continues only when `count === 1`, and (b) merges it into the user's row atomically. The merge must not be a read followed by a write, because two transfers or a concurrent progress save could lose an update. Use one raw statement: `INSERT ... ON CONFLICT ("userId", "lessonId") DO UPDATE SET "lastPositionSeconds" = GREATEST(...), "isCompleted" = "LessonProgress"."isCompleted" OR EXCLUDED."isCompleted"`. Never delete by `sessionId` alone.
  3. The progress route has the same read-then-write shape (`src/app/api/progress/lesson/route.ts:400-420`) and can write a stale `isCompleted: false` over a value the transfer just set. Change it to use the same atomic merge helper, so `isCompleted` is only ever raised, never lowered.
  4. Unlocks: move the existing per-unlock transaction logic from the two routes into the service unchanged in behavior, with two corrections. First, no `try/catch` around ledger calls inside a transaction: a failure rolls that unlock's transaction back, leaves the anonymous unlock in place, and marks the result `retry_required`. Second, before `awardQrScanPoint`, check for an existing ledger row with the same `userId` and `qrCodeId`. Historical rows can lack an `idempotencyKey`, slip past the key pre-check (`src/lib/points.ts:336-349`) and then fail on `@@unique([userId, qrCodeId])` (`prisma/schema.prisma:1520`) on every retry. Treat that case as already awarded.
  5. Awards: after the row moves, call `settleOutstandingCompletionAwards(userId)`. It finds the user's completed lessons that have a positive reward and no ledger row for `lesson-completion:{lessonId}`, awards them, then evaluates the affected courses. It considers only lessons that are active, in an active course, in a published experience that the user does not own. Without that filter it would undo the P03 rules at every sign-in. Both awards use the existing idempotent helpers (`src/lib/points.ts:573-649`). Any error marks the result `retry_required`. Because the function derives its work from committed user rows, a later call finishes what an earlier call could not.
  6. Known consequence, to confirm under D-02: if a creator adds a reward to a lesson after a learner completed it, that learner is paid at their next sign-in. Today the same learner is paid on their next progress save for that lesson, so the outcome is the same and only the timing differs.
  7. Durable state is the unconsumed source rows plus the existing `UserSession.userId` link. No transfer table is added (D-02).
  8. `POST /api/progress/merge` becomes a thin wrapper and returns `{ data: { status, mergedLessons, mergedUnlocks, pointsAwarded } }`. Existing fields keep their names.
  9. Verification: after `verifyAndConsumeEmailVerificationCode` returns `verified`, call the service inside its own `try/catch`. Always return 200 with `{ ok: true, transfer: { status } }` once verified. A thrown transfer yields `retry_required`.
  10. Verification uses cookie-derived keys only. Drop `bodyAnonKey` from `collectAnonMergeKeys` input. Keep the legacy `anonKey` and `deviceKey` cookies for unlocks. The current verification page does not send a body key, so no client change is needed.
  11. Policy: both entry points award under the lesson's current policy. Today that is the legacy self-reported policy for every lesson. P16 replaces the award call with the policy-aware service without changing this file's structure.
- **Dependencies:** P00.
- **Compatibility and migration:** no schema change. Accounts verified before this phase whose completions were never awarded are healed the next time they sign in, because item 5 settles outstanding awards. That is a behavior change in the user's favor and is consistent with what a progress save already does (`src/app/api/progress/lesson/route.ts:446-455`). Rollback is a code revert.
- **Acceptance criteria:**
  - Running the transfer twice, or twice concurrently, yields one user progress row per lesson, one ledger row per reward, and no error.
  - A progress row written by the anonymous session during the transfer is still present afterward and moves on the next call.
  - A forced transient ledger failure leaves anonymous unlock rows intact, returns `retry_required`, and a second call completes.
  - A historical ledger row for the same user and code with no idempotency key does not leave the unlock in `retry_required` forever.
  - Signing in never awards points to an owner for their own lesson, or for an inactive lesson or a draft experience.
  - Two concurrent writers to the same user progress row never lower `isCompleted` or `lastPositionSeconds`.
  - Verification returns 200 `ok: true` when the code is valid even if the transfer throws.
  - A request body cannot nominate a session to merge.
- **Testing:** L1 for wrapper contracts and key collection. L2: concurrent double transfer; transfer racing a progress save; forced failure then retry; duplicate-award check against the unique index. Update the mock merge scenario in `tests/integration-coverage.test.ts`.
- **Regression risks:** QR redemption on login for anonymous scanners (`redeemQrCodeForUser` inside the unlock transaction); the redeemed-by-someone-else path, which deletes the anonymous unlock today and must keep doing so; `UserSession.campaignId` must not be overwritten.
- **Decision blockers:** D-02. Proposed default: award in both paths now under current policy, with no new table.

### P10 — Truthful transfer status in sign-in flows

- **Priority and complexity:** P2, S.
- **Problem and evidence:** The login page awaits the merge call but never reads the response, then shows "Login successful! Redirecting…" and waits 600 ms (`src/app/(auth)/login/page.tsx:145-157`). The verification page shows a generic failure for a 500 from the merge step.
- **Desired outcome:** Sign-in proceeds immediately. If the transfer needs a retry, the user is told their earlier progress is still being attached and can retry from the destination page.
- **Scope:** `src/app/(auth)/login/page.tsx`; `src/app/(auth)/verify-email/page.tsx`; a small retry notice component used on `src/app/(withSidebar)/dashboard/page.tsx`.
- **Implementation requirements:**
  1. Read the merge response. On `complete`, redirect with no timer. On `retry_required` or a failed request, redirect and pass a non-sensitive flag (for example `?transfer=pending`) that the dashboard notice reads.
  2. The notice offers "Retry" (calls `POST /api/progress/merge`) and disappears on `complete`.
  3. Verification page: when the response is `ok: true` with `transfer.status: "retry_required"`, show "Email verified" and continue to sign-in. Never show "unable to verify" for a verified account.
  4. Remove the 600 ms timer. Keep the bounded session poll.
- **Dependencies:** P09.
- **Compatibility and migration:** none.
- **Acceptance criteria:** sign-in with a failing merge still lands on the destination and shows the notice; a successful retry clears it; no artificial delay remains.
- **Testing:** L1 component tests for the three states. L3: block the merge request in dev tools and sign in.
- **Regression risks:** `next` path handling and approval-pending redirects on login.
- **Decision blockers:** none.

### P11 — QR batch archive

- **Priority and complexity:** P2, S. Restores list hygiene removed by P01.
- **Problem and evidence:** There is no archive state. `QRCodeBatch.isActive` exists but nothing reads or writes it (`prisma/schema.prisma:167`).
- **Desired outcome:** A brand can archive a batch. Archived batches and their codes leave default lists. Scanning, redemption, existing access, history and exports are unchanged.
- **Scope:** migration adding `QRCodeBatch.archivedAt DateTime?` and `archivedById String?`; `src/app/api/brand/qr-batches/route.ts` (GET filter); new `POST src/app/api/brand/qr-batches/[id]/archive` and `.../unarchive`; `src/app/(withSidebar)/dashboard/brand/qr-batches/page.tsx`.
- **Implementation requirements:**
  1. Do not reuse `isActive`. Leave it untouched.
  2. GET excludes archived batches and their codes by default. `?archived=include|only` shows them.
  3. Archive and unarchive are conditional updates scoped by `campaign: { brandId }` and call `assertExpectedBrand` (P07).
  4. No scan, redemption or public route reads `archivedAt`. Add a test that fails if `archivedAt` appears under `src/app/api/public` or `src/lib/qr-redemption.ts`.
  5. The blocked-delete message from P01 offers "Archive instead".
- **Dependencies:** P01. P07 if already shipped.
- **Compatibility and migration:** additive nullable columns; no backfill. Rollback: stop reading the column.
- **Acceptance criteria:** an archived batch's code still scans, redeems, awards and exports; the batch is absent from the default list and present with the filter.
- **Testing:** L1 route tests. L3: archive, scan a code from that batch.
- **Regression risks:** the 500-batch option list and the code pagination totals in the same GET.
- **Decision blockers:** none.

### P12 — Stop new QR redemptions

- **Priority and complexity:** P1, L. New enforcement on the public scan path with a concurrency requirement.
- **Problem and evidence:** No revocation exists. Scan loads the code and checks only `status === "USED"` (`src/app/api/public/scan/route.ts:35-64`). Redemption matches `id` and `status: "NEW"` only (`src/lib/qr-redemption.ts:25-36`). The anonymous path creates an unlock without touching the code row (`src/app/api/public/scan/route.ts:170-200`). The merge paths redeem on login and delete the anonymous unlock when redemption fails (`src/app/api/progress/merge/route.ts:174-191`).
- **Desired outcome:** A brand can stop new redemptions for a batch or a single code. After the stop, no new unlock or point is created from those codes. People who already unlocked keep access and points. Someone scanning a stopped code sees a clear explanation. Redemption racing a stop has exactly one winner.
- **Scope:** migration adding `QRCode.redemptionStoppedAt DateTime?`, `QRCodeBatch.redemptionStoppedAt DateTime?` and `redemptionStoppedById String?`; `src/lib/qr-redemption.ts`; `src/lib/qr-lifecycle.ts`; `src/app/api/public/scan/route.ts`; `src/lib/anonymous-transfer.ts`; new brand routes `POST .../qr-batches/[id]/stop-redemptions`, `.../resume-redemptions` and the per-code equivalents; `src/app/q/[qrCodeData]/page.tsx`; `src/app/(withSidebar)/dashboard/brand/qr-batches/page.tsx`.
- **Implementation requirements:**
  1. State lives on the code row. Stopping a batch runs one transaction: set the batch timestamp, then `updateMany` codes `where: { batchId, status: "NEW", redemptionStoppedAt: null }` to the same timestamp. USED codes are not modified.
  2. `redeemQrCodeForUser` adds `redemptionStoppedAt: null` to its existing `updateMany` predicate, unless the caller passes `honorExistingAnonymousUnlock: true` (item 6). Because the stop and the redemption both update the same row, PostgreSQL's row lock and predicate recheck give a strict winner in both orderings. Keep the `status: "NEW"` filter.
  3. When the update count is 0, return a distinct `stopped: true` result if the row is NEW with a stop timestamp.
  4. Scan, signed-in path: on `stopped`, create no unlock and no point; respond `409 { code: "QR_REDEMPTION_STOPPED", campaignSlug }` unless the viewer already holds an unlock for the campaign, in which case respond as today.
  5. Scan, anonymous path: in one transaction, first run a conditional no-op update on the code (`where: { id, redemptionStoppedAt: null }`, setting `updatedAt`) and require `count === 1`, then create the anonymous unlock. This puts the anonymous path under the same row lock. The existing `P2002` handler for a concurrent duplicate unlock (`src/app/api/public/scan/route.ts:189-199`) must move outside the transaction, because a failed statement aborts the transaction in PostgreSQL.
  6. Transfer on login: an anonymous unlock that still exists is the evidence. After this phase every surviving anonymous unlock was created either before any stop existed or under the row lock while the code was not stopped. So the transfer calls `redeemQrCodeForUser` with `honorExistingAnonymousUnlock: true` and the stop predicate is skipped for it (D-03). Do not compare timestamps: the stop timestamp is chosen before a batch update that can take time, so a timestamp comparison would reject unlocks that legitimately won the row lock.
  7. `/q/{code}` shows: "This code is no longer accepting new redemptions. If you already unlocked this campaign, sign in to continue." Record a `qr_scan_stopped` analytics event.
  8. Resuming a batch clears only the codes whose `redemptionStoppedAt` equals the batch's stop timestamp, then clears the batch. A code stopped individually keeps its own timestamp and is not resumed by a batch resume. Both actions are recorded (P15 audit if shipped).
  9. Before authoring the migration, include in the phase notes a read-only query for the owner that counts rows where `QRCode.isActive`, `QRCodeBatch.isActive` or `Campaign.isActive` is false. This phase does not enforce those fields. The counts inform D-04.
- **Dependencies:** P00, P02, P09, P11.
- **Compatibility and migration:** additive nullable columns; all existing codes remain redeemable. The scan API gains one new 409 code; the existing page treats any non-OK response as invalid, so deploy the page change in the same release. Rollback: remove the predicate; columns can stay.
- **Acceptance criteria:**
  - After a stop, a new signed-in scan creates no unlock, no ledger row and no status change.
  - After a stop, a new anonymous scan creates no unlock.
  - A user who unlocked before the stop keeps private-course access and points, and re-scanning takes them to the campaign.
  - An anonymous unlock that exists converts on login whether or not the code was stopped afterward; an anonymous request that lost the row lock to the stop created no unlock.
  - Fifty concurrent redemptions against a concurrent stop produce a state where every code is either USED with a ledger row for its redeemer, or NEW and stopped. Never both, never neither. (A redeemer who already held an unlock for the campaign gets no second unlock, as today.)
  - Resuming a batch does not resume a code that was stopped on its own.
  - Two concurrent anonymous scans of the same code from one session return success, not 500.
  - Archive (P11) alone never blocks redemption.
- **Testing:** L1 for each branch. L2: stop versus signed-in redemption in both lock orders; stop versus anonymous scan; a slow batch stop with an anonymous scan that wins a row lock mid-update, followed by login transfer; batch resume with an individually stopped code. L3: scan message.
- **Regression risks:** the double-redemption guard; anonymous unlock partial unique index (migration `20260615113320`); `hasRedeemedQrWarning`; legacy `/redeemQR` redirect.
- **Decision blockers:** D-03 (honor earlier anonymous unlocks; proposed yes) and D-04 (whether `Campaign.isActive` and `Brand.isActive` should affect visitors; proposed: not in this phase).

### P13 — Staged asset ownership and safe cleanup

- **Priority and complexity:** P2, L.
- **Problem and evidence:** Nothing records an upload between authorization and attachment. Server-side deletions of replaced or removed videos only log on failure (`src/app/api/creator/lessons/route.ts:69-87,513-515,592-594`). After P06, unknown-outcome uploads accumulate with no owner.
- **Desired outcome:** Every lesson-video object has a tracked state. Attachment and cleanup compete for the same row, so an object is never deleted after it is attached. Failed deletions retry.
- **Scope:** migration adding `StagedAsset`; `src/lib/lesson-video-upload-handler.ts` and `src/app/api/uploads/video/route.ts` (issue); `src/app/api/creator/lessons/route.ts` (attach, replace, remove); `src/app/api/creator/courses/route.ts` (course delete removes lesson videos inline at `:11-19,366`); `src/app/api/uploads/storage-object/route.ts` lesson branch and ADMIN branch (`:201-204`); new `src/lib/asset-sweeper.ts` and `src/app/api/internal/asset-sweeper/route.ts`; `docs/lesson-video-uploads.md`; `docs/env-vars.md`.
- **Implementation requirements:**
  1. `StagedAsset { id, bucket, path, kind, ownerUserId, courseId, lessonId?, status, createdAt, attachedAt?, cleanupClaimedAt?, deletedAt?, attempts, lastError? }` with `@@unique([bucket, path])` and status `STAGED | ATTACHED | CLEANUP_CLAIMED | DELETED`.
  2. Issue: create a `STAGED` row when the signed upload URL is created.
  3. Attach: the lesson create and update are bare calls today (`src/app/api/creator/lessons/route.ts:318,480`), so first wrap each in a transaction. Inside it, `updateMany({ where: { bucket, path, status: "STAGED" }, data: { status: "ATTACHED", lessonId, attachedAt } })`. Accept `count === 1`, or an existing row already `ATTACHED` to the same lesson (idempotent retry). Fail the transaction with `409 { code: "ASSET_UNAVAILABLE" }` when the row is `CLEANUP_CLAIMED` or `DELETED`, or is `ATTACHED` to a different lesson. One object belongs to at most one lesson.
  4. Transition rule for uploads authorized before deployment: when no row exists, fall back to the existing existence check and insert an `ATTACHED` row, but only if no other lesson already references that bucket and path. Remove this fallback in a later release.
  5. Replace, remove and course delete: after commit, release the old object with a conditional update, `updateMany({ where: { bucket, path, status: "ATTACHED", lessonId: oldLessonId }, data: { status: "CLEANUP_CLAIMED" } })`. When no row exists (an object from before this phase), insert a `CLEANUP_CLAIMED` row only if no remaining lesson references that bucket and path. Never claim a row attached to another lesson. Do not delete inline.
  5a. The ADMIN branch of the storage delete endpoint must refuse lesson-video objects that have an `ATTACHED` row or a referencing lesson, and otherwise go through the same claim.
  5b. Before this phase ships, the owner runs a read-only check for lessons that share a storage path (`GROUP BY "videoStorageBucket", "videoStoragePath" HAVING count(*) > 1`). Lesson saves currently accept any existing object under the course path (`src/app/api/creator/lessons/route.ts:29-66`), so shared references are possible. If any exist, they are handled before the one-object-one-lesson rule is enforced.
  6. Client cleanup request (the P06 "rejected" case): `updateMany({ where: { bucket, path, status: "STAGED", ownerUserId }, data: { status: "CLEANUP_CLAIMED" } })`. If the count is 0, respond `409 ASSET_IN_USE`. The endpoint no longer deletes directly.
  7. Sweeper: authenticated with the cron secret like the existing internal routes. Each run (a) claims `STAGED` rows older than a configurable age (proposal: 24 hours) with a conditional update, and (b) processes a bounded batch of `CLEANUP_CLAIMED` rows: delete from storage, set `DELETED`; on failure increment `attempts` and store `lastError`. A claimed row never returns to `STAGED`.
  8. Lesson videos only. QR images (Cloudinary) and profile images are out of scope and listed under outstanding issues.
- **Dependencies:** P00, P06. An external scheduler must call the new internal route; there is no `vercel.json` in the repository.
- **Compatibility and migration:** additive table. Objects uploaded before this phase have no row and are never swept. Rollback: stop calling the sweeper; inline deletes can be restored by revert.
- **Acceptance criteria:**
  - Attach racing a sweep claim: exactly one wins; an attached object is never deleted.
  - A storage deletion failure is retried on the next run and the row shows the attempt count.
  - A replaced video is deleted by the sweeper, not inline.
  - Replacing or removing the video on one lesson never claims an object that another lesson references.
  - Deleting a course releases its lesson videos through the same claim.
  - A save retry after an unknown outcome attaches the same object without error.
- **Testing:** L1 for state transitions with an injected storage client. L2: attach versus claim race. L4 is not needed; storage calls are injected.
- **Regression risks:** upload authorization response shape; lesson update with unchanged video (`src/app/api/creator/lessons/route.ts:507-511` must still skip cleanup); playback signing.
- **Decision blockers:** none. Proposed sweep age: 24 hours.

### P14 — Account creation independent of email delivery

- **Priority and complexity:** P2, S.
- **Problem and evidence:** The user and verification challenge commit, then `sendVerificationEmail` runs inside the same `try`. A mail failure returns 500 "Failed to create user", and a retry returns 409 (`src/app/api/admin/user-management/get-or-create-users/route.ts:126-192`). The email-transfer route already handles this correctly (`src/app/api/admin/user-management/transfer-email/[id]/route.ts:88-110`).
- **Desired outcome:** Creation returns 201 with `emailSent: true | false`. The admin can resend.
- **Scope:** the create route; new `POST src/app/api/admin/user-management/resend-verification/[id]`; `src/app/(withSidebar)/admin/user-management/page.tsx`.
- **Implementation requirements:**
  1. Wrap only the send in its own `try/catch`. Respond `201 { data, emailSent, message }`.
  2. Resend: admin-only; issues a fresh challenge with the existing helper and sends; refuses for verified users; rate limited per target.
  3. UI shows "Account created. Verification email could not be sent." with a Resend button.
- **Dependencies:** none.
- **Compatibility and migration:** response gains a field; status stays 201 on success.
- **Acceptance criteria:** with a failing mailer the account exists, the response is 201 with `emailSent: false`, and resend succeeds once the mailer works.
- **Testing:** L1 with an injected mailer.
- **Regression risks:** duplicate-email 409 path.
- **Decision blockers:** none.

### P15 — Admin audit trail and decision metadata

- **Priority and complexity:** P2, M.
- **Problem and evidence:** No audit model exists. Requests store `reviewedById` and one `reason` but no decision time, and applicant-facing text is not separated from internal notes (`prisma/schema.prisma:46-70`). The approvals page has no reason input although the API accepts one (`src/app/api/admin/approvals/brand/[requestId]/route.ts:56`).
- **Desired outcome:** Every approval decision and every access change writes an immutable audit row in the same transaction. Rejections require an applicant-facing reason. Internal notes are stored separately and never shown to applicants.
- **Scope:** migration adding `AdminAuditEvent` and, on both request models, `reviewedAt DateTime?` and `internalNote String?`; both approval routes; `src/lib/admin-user-mutations.ts`; approvals page; user-management page; a read-only `GET /api/admin/audit`.
- **Implementation requirements:**
  1. `AdminAuditEvent { id, actorId, action, targetType, targetId, before Json?, after Json?, reason?, createdAt }`, indexed on `(targetType, targetId, createdAt)`. No update or delete path exists in code.
  2. Write the event inside the P04 and P05 transactions. `before` and `after` hold only role, active state and request status. No emails or names beyond ids.
  3. Approval body accepts `reason` (applicant-facing) and `internalNote`. Reject requires a non-empty `reason` (400 otherwise).
  4. UI: decision dialog with both fields; history list per request and per user.
  5. Existing `reason` values are treated as applicant-facing. Existing rows have null `reviewedAt`; show "date not recorded". Do not copy `updatedAt` into it.
- **Dependencies:** P04, P05.
- **Compatibility and migration:** additive. Old clients that send only `reason` keep working for approvals.
- **Acceptance criteria:** each decision and access change produces exactly one audit row; a failed or conflicting request produces none; internal notes never appear in any non-admin response.
- **Testing:** L1 for route and serialization. L2: audit row count under the P04 and P05 races.
- **Regression risks:** approval email content; P24 status page reads `reason` only.
- **Decision blockers:** D-13. Proposed default: existing `reason` is applicant-facing; add `internalNote`.

### P16 — Qualification foundation

- **Priority and complexity:** P1, L. Schema and service only. No user-visible change.
- **Problem and evidence:** A client boolean authorizes spendable points (`src/app/api/progress/lesson/route.ts:290,417,446-455`). The browser sets it at 95% of duration, reachable by seeking (`src/components/experience/lesson-client.tsx:344-345,587-603`). Award calls are made directly from two places (the progress route and, after P09, the transfer service). No qualification model exists.
- **Desired outcome:** One service decides whether a user has earned a lesson or course reward, according to a per-lesson policy. Every lesson starts on the legacy policy, so behavior is identical after this phase.
- **Scope:** migration; new `src/lib/learning-awards.ts`; `src/app/api/progress/lesson/route.ts`; `src/lib/anonymous-transfer.ts`; `docs/points-ledger.md`.
- **Implementation requirements:**
  1. Schema, all additive:
     - enum `LessonParticipationPolicy { LEGACY_SELF_REPORTED, CHECKPOINT }` and `Lesson.participationPolicy` defaulting to `LEGACY_SELF_REPORTED`.
     - `LessonCheckpoint { id, lessonId, version, prompt, options Json, correctOptionIndex, status (DRAFT | PUBLISHED | RETIRED), publishedAt?, createdAt }` with `@@unique([lessonId, version])`.
     - `LessonQualification { id, userId, lessonId, checkpointId, checkpointVersion, qualifiedAt }` with `@@unique([userId, lessonId])`.
     - `LessonCheckpointAttempt { id, userId, checkpointId, isCorrect, createdAt }` indexed on `(userId, checkpointId, createdAt)`.
  2. `settleLessonAward({ userId, lessonId, db? })`: returns without awarding when the user owns the experience. For `LEGACY_SELF_REPORTED` it requires the user's `LessonProgress.isCompleted`. For `CHECKPOINT` it requires a `LessonQualification` row. It then calls `awardLessonCompletionPoints`. The ledger key stays `lesson-completion:{lessonId}`.
  3. `settleCourseAward({ userId, courseId, db? })`: returns without awarding when the user owns the experience. A legacy lesson is satisfied by `LessonProgress.isCompleted`. A checkpoint lesson is satisfied by a `LessonQualification` row, or by an existing `lesson-completion:{lessonId}` ledger row for that user. The second case matters: a learner who earned the lesson reward under the legacy policy has no qualification row after the lesson switches, and without this rule their course reward would be stranded. Otherwise identical to today's rule (all active lessons). Key stays `course-completion:{courseId}`.
  4. Replace the direct award calls in the progress route and in `settleOutstandingCompletionAwards` with these functions.
  5. Add a test that fails if any file outside `learning-awards.ts` and `src/lib/points.ts` calls `awardLessonCompletionPoints` or `awardCourseCompletionPoints`.
  6. `correctOptionIndex` must never be selected by any route outside the creator-owned authoring API. Add a test for that once P17 and P18 exist; note it here.
- **Dependencies:** P09.
- **Compatibility and migration:** additive; default policy preserves behavior; no backfill; no clawback. Rollback: revert code; columns and tables can remain unused.
- **Acceptance criteria:**
  - With every lesson on the legacy policy, awards for all existing flows are unchanged (same ledger rows for the same inputs).
  - With a lesson set to `CHECKPOINT` in a fixture, `isCompleted: true` alone produces no ledger row; a qualification row produces exactly one.
  - A user already awarded under legacy receives nothing further after the lesson's policy changes.
  - A user awarded a lesson under legacy can still complete the course reward after that lesson switches to the checkpoint policy, without answering its checkpoint.
  - An owner receives no course reward on their own course.
- **Testing:** L1 with fixtures for both policies. L2: concurrent settle calls produce one ledger row.
- **Regression risks:** reward redemption and refund paths share the ledger but not these helpers; they must be untouched.
- **Decision blockers:** D-05 fixes the checkpoint shape before the migration is written. Proposed default: one multiple-choice question per lesson.

### P17 — Checkpoint authoring for creators

- **Priority and complexity:** P1, M.
- **Problem and evidence:** Creators configure rewards per lesson in the lessons page (`src/app/(withSidebar)/dashboard/creator/courses/[id]/lessons/page.tsx:220-231`) but have no way to define a server-evaluated requirement.
- **Desired outcome:** A creator can write, preview and publish a checkpoint for a lesson, then switch that lesson to the checkpoint policy. Nothing changes for learners until the switch.
- **Scope:** new `src/app/api/creator/lessons/[id]/checkpoint/route.ts`; the lessons page; `src/app/api/creator/lessons/route.ts` (accept `participationPolicy`).
- **Implementation requirements:**
  1. GET returns the creator's draft and latest published version, including the correct answer, to the owning creator only.
  2. PUT saves a draft. POST `publish` creates the next version as `PUBLISHED` and retires the previous one. Published versions are immutable.
  3. A lesson may be set to `CHECKPOINT` only when a published checkpoint exists. The switch is one-way through the API (D-06).
  4. Editing content or publishing a new checkpoint version never deletes `LessonQualification` rows.
  5. The editor states plainly what learners will see and that points are granted only after a correct answer.
- **Dependencies:** P16.
- **Compatibility and migration:** none beyond P16.
- **Acceptance criteria:** a non-owner creator and any learner receive 404 from the authoring API; the policy cannot be set to `CHECKPOINT` without a published version; publishing twice yields versions 1 and 2 with only 2 published.
- **Testing:** L1 for ownership, versioning and the switch precondition. L3: author and publish.
- **Regression risks:** lesson save and video upload flow in the same page (P06 behavior).
- **Decision blockers:** D-06 (one-way switch; proposed yes).

### P18 — Learner checkpoint flow and policy disclosure

- **Priority and complexity:** P1, M. This is the phase that changes reward behavior for transitioned lessons.
- **Problem and evidence:** See P16. Learner copy today does not say how a reward is earned.
- **Desired outcome:** On a checkpoint lesson, a signed-in learner with access answers the checkpoint; a correct answer records qualification on the server and grants the reward once. Completion flags and seeking grant nothing on these lessons. Legacy lessons continue to work and are described accurately.
- **Scope:** new `GET` and `POST src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/checkpoint`; `src/app/api/progress/lesson/route.ts`; `src/components/experience/lesson-client.tsx`; lesson API response (`src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/route.ts`) to expose `participationPolicy` and reward copy.
- **Implementation requirements:**
  1. GET returns prompt and options for the published version. Never the answer.
  2. POST requires a signed-in user, a published experience (P03), an active lesson and course, and private-course access where applicable. It records an attempt, enforces an attempt limit (proposal: 3 attempts per 10 minutes per user per checkpoint, 429 beyond), and on a correct answer creates the qualification row (unique per user and lesson, so repeats are no-ops) and calls `settleLessonAward` then `settleCourseAward`.
  3. The progress route keeps saving position and `isCompleted` for every lesson. For checkpoint lessons it does not call the award service.
  4. Anonymous viewers can watch and see the checkpoint prompt. Submitting requires sign-in. Anonymous completion flags on checkpoint lessons transfer as progress only (D-05).
  5. Copy: legacy lessons say "Finish this lesson to earn N points". Checkpoint lessons say "Answer the checkpoint to earn N points". No surface uses the word "verified" for a legacy lesson.
  6. State the limit honestly in `docs/points-ledger.md`: a multiple-choice checkpoint shows engagement with the content. It does not prove attention.
- **Dependencies:** P17. P03 for the publication and owner rules.
- **Compatibility and migration:** existing ledger rows and legacy progress are untouched. A learner who self-reported completion on a lesson before it transitioned keeps `isCompleted` and, if already awarded, their points; if not awarded, P19 handles the claim.
- **Acceptance criteria:**
  - On a checkpoint lesson, posting `isCompleted: true` or seeking to the end creates no ledger row.
  - A correct answer creates one qualification row and one ledger row; repeating it creates neither.
  - A wrong answer creates an attempt row only; the fourth attempt inside the window returns 429.
  - The answer index never appears in any learner response.
  - The owner answering their own checkpoint earns nothing.
- **Testing:** L1 for every branch and the serialization check. L2: concurrent correct submissions yield one ledger row. L3: learner walk-through on uploaded and YouTube lessons.
- **Regression risks:** resume position, course progress percentages, `lesson_completed` analytics events.
- **Decision blockers:** D-05 (attempt limits, sign-in requirement).

### P19 — Course qualification and legacy transition

- **Priority and complexity:** P2, M.
- **Problem and evidence:** Course rewards are evaluated against whatever lessons are active at the moment of the call (`src/lib/points.ts:612-637`), so the requirement shifts as lessons are added or removed. When a lesson moves to the checkpoint policy, learners with a legacy completion and no award have a claim that current code would neither grant nor record.
- **Desired outcome:** Course rewards are evaluated against a recorded requirement version. Legacy completions without an award at transition time become explicit reviewable claims. Nothing is auto-granted, dropped or clawed back.
- **Scope:** migration adding `CourseRequirementVersion { id, courseId, version, lessonIds Json, createdAt }`, `CourseQualification { userId, courseId, requirementVersion, qualifiedAt, @@unique([userId, courseId]) }` and `LegacyRewardClaim { id, userId, lessonId, status (PENDING_REVIEW | GRANTED | DECLINED), decidedById?, decidedAt?, createdAt, @@unique([userId, lessonId]) }`; `src/lib/learning-awards.ts`; the P17 policy switch; an admin review list; every writer that changes a course's set of active lessons: lesson create, update and delete in `src/app/api/creator/lessons/route.ts`, and course update and delete in `src/app/api/creator/courses/route.ts`.
- **Implementation requirements:**
  1. Create a new requirement version whenever the set of active lessons in a rewarded course changes, inside the same transaction as that change, through one helper called by every writer listed in Scope. `settleCourseAward` evaluates the latest version and writes `CourseQualification` with that version before awarding.
  1a. A rewarded course that has no version yet (every existing course at deployment) gets version 1 created lazily, from its active lessons at that moment, the first time it is evaluated or changed. No versions are created at deploy time and none are dated in the past.
  2. On a lesson's switch to `CHECKPOINT`, in the same transaction, insert a `LegacyRewardClaim` (`PENDING_REVIEW`) for each user with `isCompleted` on that lesson and no `lesson-completion:{lessonId}` ledger row, when the lesson's reward is positive.
  3. Admin review grants or declines through a function in `learning-awards.ts`, so the P16 rule that only that module calls the award helpers still holds. A grant awards with the unchanged key. Both outcomes write an audit event (P15).
  3a. A granted claim produces a `lesson-completion` ledger row, which P16 item 3 already counts toward the course. A declined or pending claim does not count; the learner can still qualify by answering the checkpoint.
  4. Learners see "Reward under review" for a pending claim on that lesson.
  5. Do not create claims retroactively for lessons that never transition.
- **Dependencies:** P18. P15 for audit.
- **Compatibility and migration:** additive. Users already holding the course reward never re-earn it (ledger key). Requirement versions start at the time of deployment; no historical versions are invented.
- **Acceptance criteria:** adding a lesson to a course does not revoke an awarded course reward and does not let an awarded user earn again; a transition with three unsettled legacy completions creates three pending claims and zero ledger rows; granting one creates one ledger row and lets that learner's course reward settle; an existing rewarded course with no version is evaluated correctly on first use.
- **Testing:** L1 and L2 (transition transaction atomicity).
- **Regression risks:** course progress display; P09 settlement must skip lessons with a pending claim.
- **Decision blockers:** D-06 (who reviews legacy claims; proposed: superadmin).

### P20 — Password recovery

- **Priority and complexity:** P1, M. Account recovery is security-sensitive and currently impossible without an administrator.
- **Problem and evidence:** No reset route, page or model exists. Only authenticated change-password does (`src/app/api/user/change-password/route.ts:66-85`), which shows the session-invalidation pattern to reuse (`sessionVersion` increment, checked at `src/app/api/auth/[...nextauth]/options.ts:105-128`).
- **Desired outcome:** A user requests recovery by email and always sees the same response. A valid link sets a new password once, within a short window, and signs out every existing session.
- **Scope:** migration adding `PasswordResetToken { id, userId, tokenHash, expires, consumedAt?, createdAt }`; new `src/lib/auth/password-reset.ts`; `POST /api/auth/forgot-password`; `POST /api/auth/reset-password`; pages `(auth)/forgot-password` and `(auth)/reset-password`; a link on the login page; a mail template beside the verification mailer; `src/lib/analytics-policy.ts` test.
- **Implementation requirements:**
  1. Request: normalize the email, rate limit by IP and by email, and always return the same 200 body and take similar time whether or not the account exists, is inactive, or is unverified. Send mail only for active accounts.
  2. Token: at least 32 random bytes, stored only as a keyed hash using the same pepper approach as verification codes (`src/lib/auth/email-verification.ts`). Proposed lifetime: 30 minutes. Issuing a new token invalidates earlier unconsumed ones.
  3. Reset: one transaction that conditionally consumes the token (`updateMany where consumedAt: null and expires > now`, count must be 1), stores the bcrypt hash, and increments `sessionVersion`.
  4. Apply the existing password rules from change-password. Do not change `isEmailVerified`.
  5. The reset page must stay outside the third-party analytics allowlist. Add an assertion to `tests/analytics-privacy.test.ts` that the forgot and reset paths resolve to "not tracked". The global `Referrer-Policy: no-referrer` (`next.config.ts:63`) already prevents token leakage by referrer.
  6. Never log the token or the email address.
- **Dependencies:** none. P44 strengthens the rate limit across instances; until then the in-memory limiter applies.
- **Compatibility and migration:** additive table. No existing flow changes.
- **Acceptance criteria:** identical responses for existing and unknown emails; a token works once; an expired or reused token fails with a generic message; after reset, an old session is rejected on its next request and the new password signs in.
- **Testing:** L1 with injected mailer and clock. L2: concurrent double submit of the same token changes the password once. L3: full flow with the dev mail preview.
- **Regression risks:** credential login timing protections; admin email-transfer flow (also increments `sessionVersion`).
- **Decision blockers:** D-11 (token lifetime). Proposed default: 30 minutes.

### P21 — Atomic Q&A daily capacity

- **Priority and complexity:** P2, S.
- **Problem and evidence:** The route counts today's questions, compares to the limit, then creates, with no transaction (`src/app/api/questions/route.ts:371-393`). The day window is the server's local day (`:5-13`).
- **Desired outcome:** Concurrent submissions cannot exceed the limit. The window is a UTC day.
- **Scope:** `src/app/api/questions/route.ts`.
- **Implementation requirements:** run the count and create in one `Serializable` transaction with up to three retries on `P2034`; return the existing 429 when the limit is reached; compute the window in UTC; keep the `|| 1` default.
- **Dependencies:** P00.
- **Compatibility and migration:** none. Around deployment a user could gain or lose a few hours of window once because of the UTC change.
- **Acceptance criteria:** ten concurrent submissions with a limit of 1 create exactly one question; the others receive 429.
- **Testing:** L2 for the race; L1 for the window calculation.
- **Regression risks:** `remainingToday` in the GET response must use the same window.
- **Decision blockers:** none.

### P22 — Experience viewer recovery fixes

- **Priority and complexity:** P2, S. Three small viewer-facing defects in the same component family.
- **Problem and evidence:** Reward cards render only in the product success branch, so a product failure hides rewards (`src/components/experience/shop-client.tsx:215-249`). Reward load errors render nothing (`src/components/rewards/shopify-shop-reward-card.tsx:111-118,188-189`; `src/components/rewards/commerce7-rewards-client.tsx:30,61,83`). Comments cannot be refetched (`src/components/experience/posts-client.tsx:64-67`). The featured-video seek range has no accessible name (`src/components/experience/hub-client.tsx:912-922`).
- **Desired outcome:** Products and rewards each show loading, empty, failed or unavailable on their own, with a retry. Comments can be refreshed without duplicate requests. The seek control is announced with a name and readable time.
- **Scope:** the four components named above.
- **Implementation requirements:**
  1. Render the reward section regardless of product state. Give each reward component an explicit failed state with a Retry button and a distinct "no rewards available" state.
  2. `loadComments({ force })`: skip only while a request is in flight; `force` bypasses the cached check. Add a Refresh control.
  3. Seek input: `aria-label="Seek"`, `aria-valuetext` such as "1 minute 20 seconds of 4 minutes". Confirm arrow keys move it.
- **Dependencies:** none.
- **Compatibility and migration:** none.
- **Acceptance criteria:** with the products request failing, rewards still render; with a rewards request failing, an error and retry appear instead of an empty area; a second click on Refresh while loading sends no second request.
- **Testing:** L1 component tests. L3: keyboard and screen-reader spot check of the seek control.
- **Regression risks:** reward claim flows inside the same components.
- **Decision blockers:** none.

### P23 — Actionable customer home

- **Priority and complexity:** P2, M.
- **Problem and evidence:** The customer dashboard shows three counts and a text-only activity list (`src/app/(withSidebar)/dashboard/page.tsx:516-575`). The API returns labels with no ids or links (`src/app/api/me/dashboard-summary/route.ts:215-385`).
- **Desired outcome:** The home page offers "Continue" for the most recent unfinished lesson with its saved position, a list of unlocked experiences, and a rewards entry showing balance and the next action.
- **Scope:** the USER branch of `dashboard-summary`; `src/app/(withSidebar)/dashboard/page.tsx`.
- **Implementation requirements:**
  1. Add `resume: { experienceSlug, lessonId, lessonTitle, lastPositionSeconds } | null`, chosen as the most recently updated incomplete progress row on an active lesson in a published experience the user can access.
  2. Add `unlockedExperiences[]` (slug, title, cover) derived from the user's campaign unlocks and published attached experiences, bounded to a small page with a "view all" link.
  3. Add `rewards: { spendablePoints, href: "/dashboard/points" }`.
  4. Activity items gain an optional `href`. Keep existing fields.
  5. Show the P10 transfer notice here.
- **Dependencies:** P03 (publication filter in this route).
- **Compatibility and migration:** additive response fields.
- **Acceptance criteria:** a user with an unfinished lesson sees a working Continue link to `/x/{slug}/lessons/{lessonId}`; a user with nothing started sees an explicit empty state with a pointer to scan a code; no draft experience appears.
- **Testing:** L1 for the selection logic. L3: click-through.
- **Regression risks:** the creator, brand and admin branches of the same route.
- **Decision blockers:** none.

### P24 — Pending-approval status

- **Priority and complexity:** P3, S.
- **Problem and evidence:** `src/app/approval-pending/page.tsx` renders static text and a sign-out button. The redirect comes from `src/app/(withSidebar)/layout.tsx:26-34` using `src/lib/approval-gating.ts:3-25`. Some pending applicants are refused at sign-in instead (`src/lib/auth/credential-login.ts:95-101`) and never reach this page.
- **Desired outcome:** A signed-in applicant sees their current application status, submission date, any applicant-facing reason, and the next action. A Refresh button re-checks.
- **Scope:** new `GET /api/me/application-status`; the page.
- **Implementation requirements:** authenticated only; returns the caller's own latest creator and brand requests with `status`, `createdAt` and `reason`. Never `internalNote` (P15). On APPROVED, prompt to continue to the dashboard. On REJECTED, show the reason and the support contact. Do not add any unauthenticated status lookup.
- **Dependencies:** none. Reads better after P15.
- **Compatibility and migration:** none.
- **Acceptance criteria:** status changes appear after Refresh without signing out; the response contains no other user's data and no internal note.
- **Testing:** L1.
- **Regression risks:** the layout redirect loop conditions.
- **Decision blockers:** none.

### P25 — Creator dashboard recovery and filters

- **Priority and complexity:** P2, M.
- **Problem and evidence:** A failed post save replaces the editor with an error card (`src/app/(withSidebar)/dashboard/creator/experiences/[id]/posts/page.tsx:130,165-168`). The analytics and Q&A selectors are built from the filtered response, so choosing one experience removes the others (`src/app/api/creator/analytics/route.ts:33-41,186`; `src/app/api/questions/route.ts:55`). Engagement, click and Q&A loads have no stale-response guard (`src/app/(withSidebar)/dashboard/creator/analytics/page.tsx:113-174`; `src/app/(withSidebar)/dashboard/creator/qa/page.tsx:56-77`), while the conversion load already has one (`:188-220`).
- **Desired outcome:** A failed save shows an inline message and keeps the form and its text. Selectors always list every experience the creator owns. A slow old response never overwrites a newer selection.
- **Scope:** the creator posts page; the two API routes; the analytics and Q&A pages.
- **Implementation requirements:**
  1. Split load errors from mutation errors in the posts page. Mutation errors render above the still-mounted form.
  2. Both routes return an `options.experiences` list computed without the `experienceId` filter. Pages read selectors from it.
  3. Extract the existing sequence-guard pattern into a small hook and apply it to all four loads.
  4. Each panel shows its own loading, empty and failed state with a retry.
- **Dependencies:** none.
- **Compatibility and migration:** additive response field.
- **Acceptance criteria:** after selecting one experience the selector still lists all; with responses forced to arrive out of order the UI shows the latest selection's data; a failed post save leaves the typed text visible.
- **Testing:** L1 for routes and the hook. L3: throttled network check.
- **Regression risks:** deep link `creator/qa?experienceId=` (`src/app/(withSidebar)/dashboard/creator/qa/page.tsx:47-49`).
- **Decision blockers:** none.

### P26 — QR inventory pagination and search

- **Priority and complexity:** P2, M.
- **Problem and evidence:** The API paginates codes (default 100, maximum 200) and caps batch and campaign options at 500 (`src/app/api/brand/qr-batches/route.ts:39-46,59,86`). The page requests no page and filters client-side over the first 100 (`src/app/(withSidebar)/dashboard/brand/qr-batches/page.tsx:104,127-143,160`).
- **Desired outcome:** Every code is reachable by paging, filtering and search performed on the server. Batch and campaign selectors are searchable and complete.
- **Scope:** `src/app/api/brand/qr-batches/route.ts`; new `GET /api/brand/qr-batches/options`; the page.
- **Implementation requirements:**
  1. Add server-side filters: `batchId`, `campaignId`, `status`, `q` (prefix match on `qrCodeData`), and the P11 archive filter. Keep `page` and `pageSize` and the existing pagination metadata.
  2. Options endpoint returns batches or campaigns with search and cursor pagination. Remove the option arrays from the main response only after the page stops reading them.
  3. The page drives all filtering through the API and shows total counts and page controls.
- **Dependencies:** P11 (archive filter).
- **Compatibility and migration:** response fields are added before any are removed.
- **Acceptance criteria:** with 250 codes, the 201st is reachable; with 600 batches, the 600th can be found by search; filters return server totals.
- **Testing:** L1 with fixtures above each cap; extend `tests/qr-routes-hardening.test.ts`.
- **Regression risks:** CSV export; brand scoping of every query.
- **Decision blockers:** none.

### P27 — Campaign experiences: attached versus discovery

- **Priority and complexity:** P2, S.
- **Problem and evidence:** One query returns "active or already attached", ordered by `updatedAt`, limited to 50 (`src/app/api/brand/campaigns/[id]/attach-experience/route.ts:74-93`). An attached experience can fall outside the limit.
- **Desired outcome:** Attached experiences always display in full. Discovery of other experiences is a separate, paginated, searchable list. The creator's name is shown.
- **Scope:** the route's GET; `src/app/(withSidebar)/dashboard/brand/campaigns/[id]/experiences/page.tsx`.
- **Implementation requirements:** return `attached[]` (all rows for the campaign with status and creator display name) and `discover` (published, not attached, cursor paginated, searchable). Attachment stays immediate and still rejects drafts (`:171-175`). Do not rename sponsorship fields. Do not add approval, invitation or email steps.
- **Dependencies:** P03 (so a draft shown as attached is known to be hidden from visitors; show a "hidden until republished" badge).
- **Compatibility and migration:** additive response fields; keep the old `experiences` array until the page is switched.
- **Acceptance criteria:** with 60 attached experiences all 60 display; discovery pages beyond 50.
- **Testing:** L1.
- **Regression risks:** `tests/campaign-product-curation.test.ts` and sort-order handling.
- **Decision blockers:** none.

### P28 — Commerce connection overview and sync truthfulness

- **Priority and complexity:** P2, M.
- **Problem and evidence:** The Store page reads one connection chosen by `getActiveCommerceConnectionAnyProvider` (`src/app/api/brand/commerce/status/route.ts:53-77`; `src/lib/commerce/connection-service.ts:247-272`), although a full list endpoint exists (`src/app/api/brand/commerce/connections/route.ts:66-83`). The Shopify product preview calls `adapter.syncProducts`, which writes `lastProductSyncAt` (`src/app/api/brand/shopify/products/route.ts:117`; `src/lib/commerce/providers/shopify-commerce-adapter.ts:433-436`), and the rewards page triggers it on each visit (`src/app/(withSidebar)/dashboard/brand/rewards/page.tsx:313,330`). That field is displayed as the last sync (`src/app/(withSidebar)/dashboard/brand/commerce/BrandCommerceClient.tsx:279,507`). Copy on the products page says campaign-level selection is future work (`src/app/(withSidebar)/dashboard/brand/products/BrandProductsClient.tsx:936-937`) although `campaigns/[id]/products` exists.
- **Desired outcome:** The Store page lists every authorized connection with its real state. "Last catalog sync" reflects completed canonical syncs only. The stale copy links to the working page.
- **Scope:** `src/app/(withSidebar)/dashboard/brand/commerce/BrandCommerceClient.tsx`; the Shopify products preview route; the commerce adapter interface (`src/lib/commerce/types.ts`) and both provider adapters; `src/app/(withSidebar)/dashboard/brand/shopify/BrandShopifyClient.tsx`; `src/app/(withSidebar)/dashboard/brand/products/BrandProductsClient.tsx`; `src/app/api/me/dashboard-summary/route.ts:137-138`.
- **Implementation requirements:**
  1. Store page fetches the connections list and renders one card per connection: provider, status, last completed sync, last attempt. Keep the single-connection `status` response for other consumers.
  2. Split the adapter contract: a read-only preview method that never writes connection timestamps, and the existing sync method. The preview route uses the preview method. Apply the same contract to the Commerce7 adapter (`src/lib/commerce/providers/commerce7-commerce-adapter.ts:262-276`); trace its callers first, since they were not verified in this review.
  3. Display "last completed sync" from the latest successful `CommerceProductSyncRun` and "last attempt" from the latest run of any status (`prisma/schema.prisma:657-683`). No migration.
  4. Replace the "later phase" sentence with a link to the campaign products page.
- **Dependencies:** none.
- **Compatibility and migration:** no schema change. Existing `lastProductSyncAt` values may be later than the true last sync; they are not rewritten. The display switches source instead.
- **Acceptance criteria:** a brand with Shopify and Commerce7 sees both; opening the rewards page ten times leaves "last completed sync" unchanged; a failed sync shows as an attempt, not a completion.
- **Testing:** L1 with injected adapters. L4 optional: sandbox store preview. L3: Store page.
- **Regression risks:** product config fingerprint and connection row lock, which depend on when the connection row changes (`src/lib/commerce/product-config-fingerprint.ts:8-15`; `src/lib/commerce/connection-row-lock.ts:55`); dashboard readiness that reads `lastProductSyncAt`.
- **Decision blockers:** none.

### P29 — Rewards workspace completeness

- **Priority and complexity:** P2, L. Several caps and a provider-switching rule in one workspace. Split into two commits if review size requires: (a) provider stability and claims, (b) catalog selection.
- **Problem and evidence:** The page defaults to Shopify and switches to Commerce7 only when Shopify is not usable, hiding the Shopify workspace and its history (`src/app/(withSidebar)/dashboard/brand/rewards/page.tsx:1131-1136`). Commerce7 claims and offers are limited to the newest 100 with no pagination or status filter (`src/app/api/brand/rewards/commerce7/route.ts:18-19`). The Commerce7 catalog is limited to 500 by title and drives product pickers and the `securityUnknownCount` diagnostic (`:20,27-33`); offer product titles fall back to raw ids outside that window (`src/components/rewards/commerce7-brand-rewards.tsx:217`). The customer's Shopify redemption list is unbounded (`src/app/api/rewards/shopify/redemptions/route.ts:15-37`). The provider selector renders outside the shared shell (`src/app/(withSidebar)/dashboard/brand/rewards/page.tsx:1136`).
- **Desired outcome:** Each provider's rewards workspace stays reachable whenever that provider has a connection or history, with a repair action when disconnected. Claims paginate, filter by status, and surface unresolved work first. Product selection pages through the full canonical catalog. Diagnostics are computed over all products.
- **Scope:** the rewards page; `src/app/api/brand/rewards/commerce7/route.ts` (split into offers, claims and catalog endpoints or add parameters); `src/components/rewards/commerce7-brand-rewards.tsx`; `src/app/api/rewards/shopify/redemptions/route.ts` and its client.
- **Implementation requirements:**
  1. Before changing any picker, read the claim routes and confirm in the phase notes that claim-time eligibility is enforced server-side independent of the picker list (U-26).
  2. Provider tabs: show a provider when it has any connection, offer or claim. Selection is explicit, kept in the URL, and never switches automatically. A disconnected provider shows its history read-only and a reconnect action.
  3. Claims: cursor pagination, status filter, default order that lists claims needing action first.
  4. Catalog picker: paginated and searchable over `ConnectedCommerceProduct`. Resolve titles for products referenced by existing offers with a direct lookup by id.
  5. Compute `securityUnknownCount` with a database count, not from the limited list.
  6. Bound and paginate the customer redemption list.
  7. Render the provider selector inside `BrandPageShell`.
- **Dependencies:** P28 (connection states).
- **Compatibility and migration:** no schema change. Keep the existing response keys until the client is switched.
- **Acceptance criteria:** with Shopify disconnected and Commerce7 connected, the Shopify tab still shows past offers and redemptions; the 101st claim is reachable; a product beyond position 500 can be selected and its title displays on its offer; diagnostics match a direct count.
- **Testing:** L1 with fixtures above each cap. L3: provider outage walk-through. L4 is not required; no provider calls change.
- **Regression risks:** Commerce7 exclusive-access logic and edit-safety counts in the same route (`:21-24`); reward claim and reconciliation state machines must not be touched.
- **Decision blockers:** none.

### P30 — Admin display completeness

- **Priority and complexity:** P3, S.
- **Problem and evidence:** Admin brands returns only the Shopify domain (`src/app/api/admin/brands/route.ts:60-68`; `src/app/(withSidebar)/dashboard/admin/brands/page.tsx:88-104`). User lists show three memberships with no total (`take: 3` at `src/app/api/admin/users/route.ts:60` and two sibling routes).
- **Desired outcome:** Admin brands shows every canonical connection with provider and status. User rows show the membership total and can expand to the full list.
- **Scope:** the admin brands route and page; the three user routes; the user-management page.
- **Implementation requirements:** add `connections[]` (provider, status, external account label) from the canonical connection service for all providers; keep `shopifyShopDomain` until the page is switched. Add `_count` of memberships and a details endpoint or expanded query for one user.
- **Dependencies:** none.
- **Compatibility and migration:** additive fields.
- **Acceptance criteria:** a brand with Commerce7 only shows as connected; a user with seven memberships shows "7" and all seven on expand.
- **Testing:** L1.
- **Regression risks:** batched connection query performance for the brand list.
- **Decision blockers:** none.

### P31 — Shared confirmation and unsaved-work behavior

- **Priority and complexity:** P3, M.
- **Problem and evidence:** Destructive actions use native `confirm` at five page sites (`src/app/(withSidebar)/dashboard/creator/experiences/[id]/courses/page.tsx:136`, `src/app/(withSidebar)/dashboard/creator/courses/[id]/lessons/page.tsx:319`, `src/app/(withSidebar)/dashboard/brand/commerce/BrandCommerceClient.tsx:322`, `src/app/(withSidebar)/dashboard/brand/qr-batches/page.tsx:201,228`) while an `AlertDialog` component exists. No page warns before discarding edits; the brand selector reloads immediately (`src/components/brand/brand-selector.tsx:58`).
- **Desired outcome:** One confirmation dialog pattern that states the real consequence. Forms with unsaved edits warn before navigation, reload or brand switch. Operations that partly succeed say which parts did.
- **Scope:** a shared `ConfirmDestructive` component and `useUnsavedChanges` hook under `src/components`; the five sites; campaign form, lesson editor, post editor and reward offer forms; the brand selector.
- **Implementation requirements:**
  1. Replace the five native confirms. Each dialog names the object and the consequence that is true after P01 and P02 (for example "Codes with history cannot be deleted; archive instead").
  2. Audit every other destructive button in dashboard pages for a missing confirmation and list the results in the commit message.
  3. `useUnsavedChanges` registers dirty state, handles `beforeunload`, and exposes it to `BrandPageShell` so the selector asks before switching.
  4. A small partial-result component for multi-step saves, used first in the experience form (details saved, cover failed).
- **Dependencies:** P07 (shell context).
- **Compatibility and migration:** none.
- **Acceptance criteria:** no `window.confirm` remains in dashboard pages; switching brand with a dirty form asks first; dialogs are keyboard operable and return focus to the trigger.
- **Testing:** L1 component tests. L3: keyboard pass on each dialog.
- **Regression risks:** the embedded script in `src/app/shopify/route.ts:571` is not a dashboard page and stays as is.
- **Decision blockers:** none.

### P32 — URL-persisted filters and superseded-request handling

- **Priority and complexity:** P3, M.
- **Problem and evidence:** Filters live in component state on almost every list and analytics page; only `src/app/(withSidebar)/dashboard/creator/qa/page.tsx:47-49` reads a filter from the URL. Search is debounced on product pages only (`src/app/(withSidebar)/dashboard/brand/products/BrandProductsClient.tsx:411`; `src/app/(withSidebar)/dashboard/brand/campaigns/[id]/products/page.tsx:125`).
- **Desired outcome:** Applicable filters survive refresh, back navigation and sharing within the team. Searches are debounced and stale results are ignored.
- **Scope:** a `useUrlFilters` hook; brand analytics, creator analytics, QR inventory, rewards claims, commerce orders; the request-guard hook from P25.
- **Implementation requirements:** store only non-sensitive values (dates, status, own entity ids, search text). Never tokens, emails or customer identifiers. Use `router.replace` so typing does not flood history. Debounce at about 300 ms. Add a test asserting that dashboard paths remain untracked by `src/lib/analytics-policy.ts`, so URL parameters never reach third parties.
- **Dependencies:** P25, P26.
- **Compatibility and migration:** existing URLs without parameters behave as today.
- **Acceptance criteria:** refresh keeps filters; back restores the previous filter set; a fast typist triggers one request per pause.
- **Testing:** L1 for the hook. L3: refresh and back checks.
- **Regression risks:** OAuth result flags read from the URL on the Shopify page (`src/app/(withSidebar)/dashboard/brand/shopify/BrandShopifyClient.tsx:71-123`).
- **Decision blockers:** none.

### P33 — Campaign workspace and readiness

- **Priority and complexity:** P3, L. New contextual structure over existing screens. Review after the layout lands, before readiness rules.
- **Problem and evidence:** Campaign work is spread across `campaigns/[id]/edit`, `campaigns/[id]/experiences`, `campaigns/[id]/products`, the global `qr-batches` page, the global rewards page and the global analytics page, with no shared campaign context and no readiness concept.
- **Desired outcome:** Inside a campaign, a persistent header and tabs link identity, experiences, products, rewards, QR distribution and analytics, each scoped to that campaign. A readiness summary guides without forcing an order.
- **Scope:** a layout at `src/app/(withSidebar)/dashboard/brand/campaigns/[id]/layout.tsx`; new `GET /api/brand/campaigns/[id]/readiness`; scoped links into existing global pages using their filters (P26, P29, P32).
- **Implementation requirements:**
  1. Tabs link to existing pages. No page is removed. Global QR and content lists stay for bulk work.
  2. Readiness items carry one of four levels. Blocker: no published experience attached. Warning: an attached experience is a draft; no QR codes exist; codes exist but were never exported. Optional: no curated products; no reward offer. Provider limitation: connection lacks the scope or capability needed for order attribution.
  3. Readiness is advisory. It never disables saving or activating a campaign. A campaign with experiences and no commerce shows no blocker.
  4. Show creator identity on attached experiences.
- **Dependencies:** P26, P27, P29.
- **Compatibility and migration:** all existing URLs keep working.
- **Acceptance criteria:** every tab opens the existing screen filtered to the campaign; a content-only campaign reports ready; each readiness item links to the place to fix it.
- **Testing:** L1 for readiness rules with fixtures. L3: walk the flow in any order.
- **Regression risks:** brand layout access gating (`src/app/(withSidebar)/dashboard/brand/layout.tsx:14-47`).
- **Decision blockers:** none beyond confirming the readiness rule list above.

### P34 — Experience workspace for creators

- **Priority and complexity:** P3, M.
- **Problem and evidence:** Creator pages for one experience (edit, courses, posts, Q&A, analytics) do not share context; Q&A and analytics are global pages with an optional experience filter.
- **Desired outcome:** Inside an experience, a persistent header shows its title and publication state, with links to content, posts, questions and analytics scoped to it, and a public-view link for published experiences.
- **Scope:** a layout at `src/app/(withSidebar)/dashboard/creator/experiences/[id]/layout.tsx`; creator overview additions (unanswered question count, drafts with attached campaigns).
- **Implementation requirements:** link to `creator/qa?experienceId=` and `creator/analytics?experienceId=`; For published experiences, open `/x/{slug}`; drafts stay in authenticated creator-management screens and have no public-route preview; overview counts come from existing queries.
- **Dependencies:** P25. P03 for publication enforcement.
- **Compatibility and migration:** existing URLs keep working.
- **Acceptance criteria:** from any experience page the creator reaches its Q&A and analytics already filtered; a draft shows "Draft" and remains editable in authenticated management; its public viewer returns 404.
- **Testing:** L1 for overview counts. L3.
- **Regression risks:** creator layout role guard.
- **Decision blockers:** none.

### P35 — Dashboard shell behavior

- **Priority and complexity:** P3, S.
- **Problem and evidence:** Sidebar items are plain anchors, forcing full page loads (`src/components/app-sidebar.tsx:88-89`). No `loading.tsx` or `error.tsx` exists under `src/app`. Middleware sets `x-pathname` on the response (`src/middleware.ts:65-67`), so the brand layout that reads it from request headers always gets an empty string (`src/app/(withSidebar)/dashboard/brand/layout.tsx:21`).
- **Desired outcome:** Sidebar navigation is client-side. Dashboard segments have a loading state and an error boundary with retry. The brand layout receives the pathname.
- **Scope:** `src/components/app-sidebar.tsx`; `loading.tsx` and `error.tsx` at `(withSidebar)/dashboard`; `src/middleware.ts`.
- **Implementation requirements:** use `next/link` inside `SidebarMenuButton asChild`, preserving `aria-current`. Place boundaries at the segment root only, so in-page panel states are not replaced. Forward the pathname with `NextResponse.next({ request: { headers } })`.
- **Dependencies:** none.
- **Compatibility and migration:** none.
- **Acceptance criteria:** sidebar clicks do not reload the document; a thrown render error shows the boundary with a retry; the Shopify-install access-denied message appears on the intended route.
- **Testing:** L1 for middleware header forwarding. L3 for navigation.
- **Regression risks:** middleware matcher and auth redirects; webhook early return (`src/middleware.ts:25-27`).
- **Decision blockers:** none.

### P36 — Analytics naming and date-range truthfulness

- **Priority and complexity:** P2, M. Financial labels currently overstate what the data shows.
- **Problem and evidence:** "Gross attributed revenue" sums `totalMinor` for every attributed order regardless of status, including pending, authorized, voided and cancelled orders (`src/lib/commerce/order-analytics.ts:264`; labels at `src/app/(withSidebar)/dashboard/brand/analytics/page.tsx:822-824` and `src/app/(withSidebar)/dashboard/creator/analytics/page.tsx:683-685`). "Net attributed revenue" includes partially paid orders at full remaining value (`src/lib/commerce/order-analytics.ts:78-85,266`). The period is filtered on SQRATCH's ingestion time (`src/app/api/brand/analytics/conversions/route.ts:201-203`). Creator engagement is all-time when no dates are given while the commerce panels default to 30 UTC days (`src/app/api/creator/analytics/route.ts:52-64`; `src/lib/commerce/commerce-click-analytics.ts:98`). The creator engagement end date uses server-local time and no validation (`src/app/api/creator/analytics/route.ts:9-14`). "Completed lessons" counts rows by mutable `updatedAt` (`:133-152`).
- **Desired outcome:** Every money figure is named for what it is. Every panel states its period, timezone and date basis. Creator panels share one default period. No number changes meaning silently.
- **Scope:** `src/lib/commerce/order-analytics.ts`; brand and creator conversions routes; `src/app/api/creator/analytics/route.ts`; both analytics pages; `tests/conversion-breakdown-naming.test.ts`, `tests/order-analytics.test.ts`, `tests/brand-analytics-ux.test.ts`, `tests/creator-analytics-conversions.test.ts`.
- **Implementation requirements:**
  1. Add response fields `attributedOrderValueByCurrency`, `refundedAttributedValueByCurrency` and `currentNetAttributedOrderValueByCurrency` with the same values as today's three fields. Keep the old fields for one release, marked deprecated in the type. Do the same for the trend series fields (`src/lib/commerce/order-analytics.ts:222-224`).
  2. UI labels: "Attributed order value", "Refunded", "Current net attributed order value". Each has a one-line definition stating that order value is not captured payment.
  3. Add a count breakdown by `financialStatus` including voided, cancelled (`cancelledAt` set) and unknown status, so readers can see what the order value contains.
  4. Conversion panels state "Orders by date received by SQRATCH (UTC)" until P38.
  5. Creator engagement uses the strict UTC resolver already used by the commerce panels, defaults to the same 30 days, validates input with a 400 response, and displays the applied range.
  6. Rename the completion figure to "Lessons marked complete, last updated in period" until P37.
  7. Keep per-currency separation and the `UNKNOWN` bucket exactly as they are.
- **Dependencies:** none.
- **Compatibility and migration:** additive response fields; no schema change. Creator engagement no longer defaults to all-time; a longer range is still selectable within the existing 400-day cap.
- **Acceptance criteria:** no UI string says "revenue" for an order-value figure; old and new field values are equal in tests; an invalid creator date returns 400; all creator panels show the same default range.
- **Testing:** L1, including updates to tests that assert label text.
- **Regression risks:** `tests/analytics-privacy.test.ts` must stay green; daily trend totals must still sum to the headline.
- **Decision blockers:** D-14 (deprecation window; proposed one release).

### P37 — Immutable completion time

- **Priority and complexity:** P2, M.
- **Problem and evidence:** `LessonProgress` has `isCompleted` and `updatedAt` only (`prisma/schema.prisma:313-320`). Any later progress save moves `updatedAt`, so period completion counts drift. Owner activity is counted with learners.
- **Desired outcome:** Completion in a period is counted from a timestamp written once. Historical completions with no recorded time are reported as such. Owner rows are excluded from learner reports.
- **Scope:** migration adding `LessonProgress.completedAt DateTime?`; `src/app/api/progress/lesson/route.ts`; `src/lib/anonymous-transfer.ts`; creator and brand analytics routes; `src/app/api/me/dashboard-summary/route.ts`.
- **Implementation requirements:**
  1. Set `completedAt` to now only in the write that changes `isCompleted` from false to true. Never update it afterward.
  2. Transfer keeps the earliest non-null `completedAt` of the two rows. If both are null, leave null.
  3. No backfill. Existing completed rows keep null.
  4. Reports show "completed in period" from `completedAt`, plus "completion date not recorded: N" for completed rows with null, and "currently complete" as a separate current-state figure.
  5. Exclude rows whose user is the experience's creator from all learner counts.
  6. Where P16 to P18 are shipped, add "qualified in period" from `LessonQualification.qualifiedAt` as a separate figure.
- **Dependencies:** P03 (owner rule), P36 (labels).
- **Compatibility and migration:** additive nullable column. Readers tolerate null from the first deploy.
- **Acceptance criteria:** re-saving progress on a completed lesson does not change `completedAt`; a lesson completed last month and re-watched today counts in last month only; historical rows appear in the "not recorded" figure.
- **Testing:** L1; L2 for the set-once write under concurrent saves.
- **Regression risks:** course completion award logic reads `isCompleted` and must not change.
- **Decision blockers:** none.

### P38 — Provider-order-date reporting basis

- **Priority and complexity:** P2, M.
- **Problem and evidence:** Conversions are filtered and bucketed by `createdAt`, the ingestion time (`src/app/api/brand/analytics/conversions/route.ts:201-203,217`). `providerCreatedAt` exists, is indexed with `brandId`, and is filled by both normalizers except for partial placeholder orders (`prisma/schema.prisma:1099,1121`; `src/lib/commerce/providers/shopify-order-normalizer.ts:548,695`; `src/lib/commerce/providers/commerce7-order-normalizer.ts:427,468`).
- **Desired outcome:** Reports can show orders placed in a period (an order cohort with its current financial outcome), using the provider's order time, with a visible count of orders that fell back to ingestion time.
- **Scope:** brand and creator conversions routes; `src/lib/commerce/order-analytics.ts` trend builder; both analytics pages.
- **Implementation requirements:**
  1. Add `dateBasis=provider|ingested`. For `provider`, select orders where `providerCreatedAt` is in range, or `providerCreatedAt` is null and `createdAt` is in range. Bucket by the same effective date.
  2. Respond with `dateBasis` and `fallbackOrderCount`. The UI shows "N orders used the date SQRATCH received them because the store did not supply an order date."
  3. Describe the figures as an order cohort: "Orders placed in this period, with their current refund state." A refund on an older order changes that older cohort and is not shown as a new order.
  4. Do not add payment or refund activity-by-period reporting. The schema holds no provider refund or payment timestamps (see outstanding issues).
- **Dependencies:** P36. Operator check of X-10 (the `(brandId, createdAt)` index) before release, because the fallback branch filters on `createdAt`.
- **Compatibility and migration:** no schema change. The default basis is a visible behavior change (D-14); the ingestion basis remains selectable.
- **Acceptance criteria:** an order placed on the 30th and ingested on the 2nd appears in the earlier month under the provider basis and the later month under the ingestion basis; orders with no provider date are counted in the fallback figure; trend totals equal headline totals under each basis.
- **Testing:** L1 with fixtures for delayed ingestion, null provider date, refunds and several currencies.
- **Regression risks:** the tenant filter on attribution (`src/app/api/brand/analytics/conversions/route.ts:205-210`) must be unchanged.
- **Decision blockers:** D-14 (default basis; proposed provider date).

### P39 — Scope, attribution and drilldown consistency

- **Priority and complexity:** P3, M.
- **Problem and evidence:** Brand engagement accepts a campaign filter (`src/app/api/brand/analytics/route.ts:35,43`); commerce and conversions panels do not, yet they sit on one page. Entry-campaign and product-campaign breakdowns exist separately in the response (`src/lib/commerce/order-analytics.ts:268-269`) and need matching labels. The product breakdown counts orders containing a product (`:273-280`). Drilldown links carry no period (`src/app/(withSidebar)/dashboard/brand/analytics/page.tsx:777,786`).
- **Desired outcome:** Each panel states its scope. A filter that a panel does not apply is shown as not applied rather than implied. Drilldowns open the destination with the same supported scope.
- **Scope:** a shared `ReportMeta` type in `src/lib`; analytics routes; analytics pages; the orders explorer query parameters.
- **Implementation requirements:**
  1. `ReportMeta { period: { start, end, timezone }, dateBasis, scope, appliedFilters, unsupportedFilters, includedStatuses, generatedAt, coverage }` returned by every analytics route.
  2. Panels render a one-line scope caption from it. When a campaign filter is set, panels that cannot apply it say "Not filtered by campaign: shows the whole brand."
  3. Label the two campaign breakdowns "By entry campaign (how the visitor arrived)" and "By product campaign (which campaign promoted the product)".
  4. Label the product breakdown "Orders containing this product. An order with several products is counted once for each, so rows do not add up to total orders." Read the current label first and record it (A-15 was not verified).
  5. Drilldown links pass period, basis and attribution filter. Check whether the orders explorer accepts a date range; if it does not, add one that matches its existing `createdAt` keyset ordering and say so in the caption.
  6. Add the sentence "Attributed orders followed a tracked SQRATCH link. Attribution does not show that SQRATCH caused the sale and is not a commission statement."
- **Dependencies:** P36, P38.
- **Compatibility and migration:** additive response metadata.
- **Acceptance criteria:** every panel shows period, timezone and basis; a campaign filter never silently appears to apply to a whole-brand panel; following a drilldown shows the same period.
- **Testing:** L1.
- **Regression risks:** order explorer pagination (`src/lib/commerce/order-list.ts`).
- **Decision blockers:** none.

### P40 — Operations visibility

- **Priority and complexity:** P3, M.
- **Problem and evidence:** Workers run in bounded batches with ownership claims (email 25 per run at `src/lib/welcome-email-worker.ts:3`; reward reconciliation 20 at `src/lib/reward-reconciliation.ts:243`; Commerce7 provisioning 1 per run at `src/lib/commerce7-rewards.ts:577`), but nothing reports backlog size or the age of the oldest pending item. Approval age and connection health are not summarized anywhere.
- **Desired outcome:** A superadmin operations view shows, read-only: pending email count and oldest age; stuck redemptions and oldest age; Commerce7 reconciliation backlog; per-connection sync freshness and unhealthy connections; oldest pending approval; staged-asset backlog when P13 is shipped. A brand commerce view shows sync freshness, ingestion lag and attribution coverage for that brand.
- **Scope:** new `GET /api/admin/operations`; a page under `dashboard/admin`; additions to the brand Store page.
- **Implementation requirements:** read-only aggregate queries only; admin-gated; no customer personal data; no change to worker batch sizes, claims or locks. Ingestion lag is `createdAt - providerCreatedAt` summarized as median and maximum for recent orders.
- **Dependencies:** P15 (approval timestamps), P28 (sync run display).
- **Compatibility and migration:** none.
- **Acceptance criteria:** figures match direct counts in a fixture; the page performs no writes.
- **Testing:** L1.
- **Regression risks:** query cost on large tables; keep each query indexed or bounded.
- **Decision blockers:** none.

### P41 — Funnel stage counts

- **Priority and complexity:** P3, M.
- **Problem and evidence:** Stage data exists in separate tables: scans and views (`AnalyticsEvent`), unlocks (`CampaignUnlock`), lesson starts and completions (`AnalyticsEvent`, `LessonProgress`), merchant handoff (`CommerceClickAttribution`), orders (`CommerceOrder`). No report lines them up, and no cohort join exists that would justify a rate.
- **Desired outcome:** Campaign and experience analytics show a count for each stage in a period, each with its own stated date basis. No stage-to-stage percentage is shown.
- **Scope:** a new builder in `src/lib`; brand campaign analytics and creator experience analytics panels.
- **Implementation requirements:** stages are entry, unlock, learning start, completion (and qualification when available), merchant handoff, attributed order, order with positive current net value. Label counts as events, not people, because anonymous and signed-in activity is not deduplicated. Add the caption "Stage counts for the period. These are not conversion rates." Do not divide one stage by another.
- **Dependencies:** P37, P38, P39.
- **Compatibility and migration:** none.
- **Acceptance criteria:** each stage count equals a direct query for the same period and basis; no percentage between stages appears.
- **Testing:** L1.
- **Regression risks:** none beyond query cost.
- **Decision blockers:** none. A true conversion rate needs a defined cohort and observation window and is deferred (see outstanding issues).

### P42 — Measured aggregation performance

- **Priority and complexity:** P3, M. Conditional on measurement.
- **Problem and evidence:** Conversion routes load every matching order with line items and aggregate in application code (`src/app/api/brand/analytics/conversions/route.ts:201-232`; `src/lib/commerce/order-analytics.ts:245-282`). The only bound is the 400-day range cap. No latency or volume baseline exists.
- **Desired outcome:** A recorded baseline of rows loaded, response size and server time for representative brands. Database-side aggregation is introduced only if the baseline crosses a threshold agreed with the owner.
- **Scope:** lightweight timing and row-count logging in the conversions routes; a short results note appended to this plan's follow-up or to `docs/commerce`; optionally `src/lib/commerce/order-analytics.ts`.
- **Implementation requirements:** log counts and durations only, with no identifiers beyond brand id. If aggregation is justified, move sums and counts to `groupBy` or SQL while keeping per-currency separation, the tenant filter and identical outputs, verified by running old and new builders side by side in tests.
- **Dependencies:** P38.
- **Compatibility and migration:** none unless an index is proposed, in which case it is its own reviewed migration.
- **Acceptance criteria:** baseline recorded; if code changes, outputs are identical for the fixture set.
- **Testing:** L1 equivalence tests; L2 for query plans if aggregation is added.
- **Regression risks:** BigInt handling and currency grouping.
- **Decision blockers:** the threshold. Proposal: act when a single request loads more than 10,000 orders or exceeds two seconds server time.

### P43 — Navigation and entry-point consolidation

- **Priority and complexity:** P3, L. Do this last, after the contextual workspaces prove useful.
- **Problem and evidence:** Navigation is a flat list per role (`src/components/app-sidebar.tsx`). User management lives at `(withSidebar)/admin/user-management` while other admin pages live under `dashboard/admin`, and `dashboard/admin/users` only redirects. Contact and Support repeat the same contact details (`src/app/contact/page.tsx:13-14`; `src/app/support/page.tsx:13-14`). `/home` and `/generateQR` remain as legacy entry points.
- **Desired outcome:** Customer: Home, My Learning, Points and Rewards, Account and Help. Creator: Overview, Experiences, Questions, Analytics. Brand: Overview, Campaigns, Commerce, Rewards, Analytics, Settings. Superadmin: Overview, Approvals, Accounts and Brands, Campaigns, Operations. Every existing URL still resolves.
- **Scope:** sidebar data; redirects for moved pages; one shared contact block used by both Contact and Support.
- **Implementation requirements:** move pages only where capability parity is confirmed; add permanent redirects for every moved path; keep global QR and content lists; keep `/redeemQR/...` and `/q/...` untouched; list every old path and its destination in the commit.
- **Dependencies:** P23, P33, P34.
- **Compatibility and migration:** redirects preserve bookmarks and printed links.
- **Acceptance criteria:** a scripted list of all pre-change routes returns 200 or a redirect to a working page; role guards are unchanged.
- **Testing:** L1 route inventory test. L3 per role.
- **Regression risks:** middleware matcher paths (`src/middleware.ts:71-80`); Shopify embedded entry (`/shopify`).
- **Decision blockers:** owner sign-off on the final menu after using P33 and P34.

### P44 — Deployment-wide rate limiting and login throttling

- **Priority and complexity:** P2, M. Not in Astra's delivery stages but required by its operations list, and credential sign-in has no throttle today.
- **Problem and evidence:** The limiter is a module-level `Map`, so limits apply per server instance (`src/lib/rate-limit.ts:18`). Credential sign-in calls no limiter (`src/app/api/auth/[...nextauth]/options.ts:30-40`; `src/lib/auth/credential-login.ts:62-116`).
- **Desired outcome:** Limits are enforced across instances for sign-up, verification resend, scan, waitlist, OAuth start, password recovery and sign-in. Sign-in is throttled per account and per address with a generic message.
- **Scope:** `src/lib/rate-limit.ts` behind its current interface; the sign-in authorize path; `docs/env-vars.md`.
- **Implementation requirements:** keep the call-site API. Add a shared-store implementation selected by configuration, with the in-memory limiter as fallback when the store is unreachable. Sign-in throttling must not reveal whether an account exists and must keep the existing dummy-hash timing protection.
- **Dependencies:** none. Needs a store chosen and provisioned by the owner.
- **Compatibility and migration:** new environment variables. If Postgres is chosen as the store, an additive table.
- **Acceptance criteria:** two simulated instances share one counter; repeated failed sign-ins are slowed and then refused with the same message as a wrong password.
- **Testing:** L1 with an injected store. L2 only if the Postgres option is chosen.
- **Regression risks:** scan throughput at events; the analytics collection endpoint's limits.
- **Decision blockers:** D-15 (which shared store).

### P45 — Session check efficiency

- **Priority and complexity:** P3, S. Conditional on measurement.
- **Problem and evidence:** The JWT callback reads the user row on every invocation (`src/app/api/auth/[...nextauth]/options.ts:105-128`). Many handlers resolve the session more than once per request, for example `resolveSession()` followed by `resolveBrandAdminContext()` (`src/app/api/brand/qr-batches/[id]/route.ts:33,39`). `roleCheckedAt` is written and never read.
- **Desired outcome:** One session resolution per request. Revocation latency is unchanged because every request still performs the check once.
- **Scope:** `src/lib/auth-session.ts`; `src/lib/brand-auth.ts`.
- **Implementation requirements:** memoize session resolution for the lifetime of a single request only (React `cache` or an equivalent request-scoped store). Do not cache across requests. Do not use `roleCheckedAt` to skip the check. Remove `roleCheckedAt` only if nothing reads it.
- **Dependencies:** none.
- **Compatibility and migration:** none.
- **Acceptance criteria:** a brand mutation performs one user read for session validation; a deactivated user is still rejected on their next request.
- **Testing:** L1 counting resolver invocations.
- **Regression risks:** test injection through `AuthResolvers` must keep working.
- **Decision blockers:** none.

### P46 — Dev-dependency advisory cleanup

- **Priority and complexity:** P3, S. No production exposure: `npm audit --omit=dev` is clean.
- **Problem and evidence:** `xlsx@^0.18.5` has two high-severity advisories with no fix on the registry (`package.json:77`) and is imported only by `scripts/import-legacy-printed-stickers.ts`. Six moderate advisories sit under `@typescript-eslint/*` and `minimatch`. `eslint-config-next` is pinned at 15.3.4 while `next` is on 15.5.x (`package.json:43,70`).
- **Desired outcome:** A clean full audit, or one documented exception that cannot reach production.
- **Scope:** `package.json`, lockfile, the one script.
- **Implementation requirements:** replace `xlsx` in the script with a maintained reader, or move the script and its dependency out of the application package. Align `eslint-config-next` with the installed `next` minor and apply the available fixes. Do not combine with any application change.
- **Dependencies:** none.
- **Compatibility and migration:** lint rule changes may surface new warnings; fix or record them in the same commit.
- **Acceptance criteria:** `npm audit` reports no high-severity findings; lint, typecheck and tests pass.
- **Testing:** L1 full suite.
- **Regression risks:** lint configuration drift.
- **Decision blockers:** none.

---


## 4. Remaining decisions and migration prerequisites


Each has a proposed default. Phases proceed on the default unless you say otherwise.

| ID | Decision | Proposed default | Consequence of the alternative | Blocks |
|---|---|---|---|---|
| D-02 | Should verification-time and login-time transfers both award completion rewards now, with no new transfer table? | Yes. One service awards under the lesson's current policy, and status is derived from unconsumed rows | Waiting for qualification leaves the two paths inconsistent for several phases; a dedicated table adds a migration with little benefit | P09 |
| D-03 | After redemptions are stopped, does an anonymous unlock that already exists still convert on sign-in? | Yes | No means people who scanned before the stop lose access when they sign in | P12 |
| D-04 | Should `Campaign.isActive` or `Brand.isActive` block scans or public campaign pages? | Not in this plan. Decide after seeing the row counts | Enforcing now could invalidate printed codes for campaigns marked inactive for unrelated reasons | P12 |
| D-05 | Checkpoint format and limits | One multiple-choice question per lesson, answer held server-side, sign-in required to submit, 3 attempts per 10 minutes | Free-text or multi-question checkpoints need a larger authoring tool; allowing anonymous submission needs qualification transfer in P09 | P16, P18 |
| D-06 | How do rewarded legacy lessons transition, and who reviews unsettled legacy claims? | Creators switch per lesson, one-way. Legacy lessons keep awarding until switched. Superadmin reviews claims | A forced cutoff date would stop legacy awards for creators who have not authored a checkpoint | P17, P19 |
| D-10 | When does the expected-brand header become mandatory? | One release after P07 | Immediate enforcement breaks tabs opened before deploy | P07 |
| D-11 | Password reset token lifetime | 30 minutes, single use | Longer is more convenient and more exposed | P20 |
| D-13 | Applicant-facing reason versus internal note | Existing `reason` is applicant-facing; add `internalNote` | Treating existing reasons as internal would hide past explanations from applicants | P15 |
| D-14 | Analytics defaults | Old field names kept one release; provider order date becomes the default basis | Keeping ingestion as default leaves month boundaries misleading | P36, P38 |
| D-15 | Shared rate-limit store | A managed key-value store, with in-memory fallback | A Postgres table avoids a new service and adds write load on hot paths | P44 |
| D-16 | Is there a budget or cap on creator-configured rewards, given that points are redeemed against brand offers? | Not decided here. Flagged because checkpoints do not address it | Without one, a creator and a second account can still mint up to 1000 points per lesson | none; new product work |

---


### E.1 Operator prerequisites before any migration phase

These are run by the owner, not by an agent.

1. `npx prisma migrate status` against production, then `prisma migrate diff` as described in `docs/prisma-migrations.md`. That document verifies production only through `20260719061157`; ten later migration folders exist.
2. Settle X-10: `prisma/schema.prisma:1124-1137` says `20260905000000_add_commerce_order_created_at_index` was not applied anywhere at the time of writing. Confirm its state before P38.
3. Run the read-only drift query from P01 once, and keep the result.
4. Run the read-only count from P12 item 9 for `isActive = false` rows.

### E.2 Migration inventory

All are additive and nullable or defaulted. None has a backfill.

| Phase | Change | Preflight | Dual-format period |
|---|---|---|---|
| P11 | `QRCodeBatch.archivedAt`, `archivedById` | none | Readers treat null as not archived |
| P12 | `QRCode.redemptionStoppedAt`; `QRCodeBatch.redemptionStoppedAt`, `redemptionStoppedById` | count of `isActive = false` rows for information | Null means redeemable; scan page and API ship together |
| P13 | `StagedAsset` table | none | Uploads authorized before deploy have no row; attach falls back and inserts one |
| P15 | `AdminAuditEvent`; `reviewedAt`, `internalNote` on both request models | none | Null `reviewedAt` shown as not recorded |
| P16 | Policy enum and column; checkpoint, qualification and attempt tables | none | Default policy is legacy for every lesson |
| P19 | Requirement version, course qualification and legacy claim tables | none | Versions start at deployment; none invented for the past |
| P20 | `PasswordResetToken` table | none | New flow only |
| P37 | `LessonProgress.completedAt` | none | Null reported as "date not recorded" |
| P44 | Only if Postgres is chosen as the rate-limit store | none | In-memory fallback |

Rules for every migration: one folder per phase; enum additions are not reversible, so P16's enum is reviewed with extra care; index creation on large tables is called out for a low-traffic window; rollback is "stop reading and writing the new column", never a destructive down migration.

### E.3 Sequencing constraints

- **P01 before P11.** Between them brands cannot remove distributed batches from lists. This is intended and temporary.
- **P06 before P13.** After P06, uploads with unknown outcomes are kept and accumulate until P13's sweeper exists. Storage growth is the accepted cost of not losing media.
- **P09 before P12 and P16.** Revocation needs the transfer service to honor earlier anonymous unlocks. The qualification service replaces award calls that P09 centralizes.
- **P16 to P19 in order.** P16 changes nothing visible. P18 is the first phase that changes how a reward is earned, and only for lessons a creator has switched.
- **P04 and P05 before P15.** Audit rows are written inside the transactions those phases create.
- **P36 before P37 to P39.** Labels first, then new bases and metadata.
- **P03 before P23, P27 and P37.** They rely on the publication and owner rules.
- **P07 before P31.** The dirty-form guard uses the shell context P07 introduces.

### E.4 Rollout transitions that support old and new behavior together

| Phase | Old clients or data | New behavior | When to close the transition |
|---|---|---|---|
| P07 | Tabs loaded before deploy send no expected-brand header | Enforced only when present | One release later, require the header on brand mutations |
| P09 | `POST /api/progress/merge` consumers reading counts only | Adds `status` | No close needed; additive |
| P12 | Scan page treating any non-OK as invalid | New 409 code with message | Same release |
| P13 | Objects without a staged row | Fallback insert at attach | Remove fallback after one release |
| P16 | Lessons with rewards under self-reported completion | Policy column, default legacy | Per lesson, when its creator switches |
| P36 | Consumers of `gross*` and `net*` fields | New names alongside | Remove old names after one release |
| P38 | Reports by ingestion date | `dateBasis` parameter | Ingestion basis stays available |

### E.5 Rollback notes

- Code-only phases (P01 to P10, P14, P21 to P36, P38 to P43, P45) roll back by revert. P02 deletes route files; revert restores them.
- P01 and P02 must not be reverted independently of each other once shipped, or the legacy routes return without the guard.
- Migration phases roll back by reverting code and leaving columns in place.
- P12 is the one phase where a rollback changes user-visible state: codes stopped while it was live become redeemable again if the predicate is removed. Resume them deliberately before reverting, or keep the predicate.
- P18 rollback returns transitioned lessons to no-award-on-flag only if the policy column is still honored. Do not revert P16 while any lesson is on the checkpoint policy.

---


## 5. Safety and regression rules

- Never use ambient `DATABASE_URL` in Prisma, tests or scripts. Use the P00 gated lane only against a verified disposable loopback `_test` database; connected Supabase and shared databases are read-only. Inspect schema/migrations; author additive migrations with preflight and rollback notes, never apply them without explicit authorization. Owner verifies deployment drift (X-10).
- Never delete ledger, unlock, redemption or attribution history. Keep `applyPointLedgerEvent`, immutable idempotency keys, guarded `NEW` transitions, row locks, and existing printed redirects. Reconcile historical drift only by a separately approved data decision.
- Resolve user, creator, campaign and brand authority server-side; expected-brand headers only detect stale state and never grant access. Preserve VIEWER restrictions, private-course unlock checks, session revocation, active ADMIN protection and owner-only management authorization. Draft public routes return 404 for everyone.
- Keep provider-neutral `CommerceConnection` canonical; verify webhooks before processing. Orders do not imply payment; refunds and cancellations adjust net analytics without erasing historical attribution. Do not execute real provider mutations during QA.
- Do not expose customer PII to creators, store only opaque attribution evidence in external carts, or widen analytics allowlists. Protect issued media URLs according to their existing TTL; never promise immediate revocation.
- Preserve existing data and uncommitted work. Test mock, disposable PostgreSQL concurrency, owner browser procedures and authorized provider sandboxes as applicable. Do not report unexecuted acceptance checks as passed.
