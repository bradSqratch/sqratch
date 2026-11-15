# Points Ledger Invariants

## The two-balance model

SQRATCH tracks two balances per user:

- **Spendable / current points** — what a user can spend on Shopify reward coupons (and future redemptions). Spending lowers it; refunds restore it.
- **Lifetime earned points** — the total a user has genuinely earned over their lifetime. Spending never lowers it and refunds never raise it. Future SQRATCH coin/minting is based on this number, so spending points must never erase proof of participation.

## Current architecture and invariants

- `PointTransaction` is the **authoritative, immutable append-only transaction history and audit ledger**. Never delete a row and never edit a row to "fix" a balance — add a compensating transaction instead. There is no second, independent "universal points" table.
- `UserPointAccount` is the **authoritative current aggregate for balance reads** (one row per user): `spendablePoints`, `lifetimeEarnedPoints`, `lifetimeSpentPoints`, `lifetimeRefundedPoints`, `version`.
- These two models are not redundant restatements of the same fact: `PointTransaction` is the record of *what happened*; `UserPointAccount` is the record of *the current total*. They are updated atomically in the same database transaction on every mutation and must remain mathematically consistent — `UserPointAccount` is fully derivable from (and safe to rebuild from) `PointTransaction`.
- `User.points` — a legacy denormalized mirror of the spendable balance — **no longer exists**. It is absent from `prisma/schema.prisma`, absent from every application code path, and the physical database column was dropped in production by migration `20260719061157_remove_legacy_user_points` on July 19, 2026 (see "Completed production migration" below). `UserPointAccount` is the only balance store, in both application code and the schema. Application code must never introduce another mirror balance — every new point-award path must go through `applyPointLedgerEvent` (or one of its domain helpers) in `src/lib/points.ts`.

## Invariants

- Every balance/aggregate mutation and its ledger row happen in the **same database transaction**.
- All point mutations go through `applyPointLedgerEvent()` in `src/lib/points.ts` — the only place that writes both a `PointTransaction` and the `UserPointAccount` aggregate.
- **Lifetime earned only ever increases**, and only for true earning events (`EARN`): QR scans, lesson completion, course completion, video watch, bonus, referral.
- **Refunds** raise spendable + `lifetimeRefundedPoints`. They do **not** raise `lifetimeEarnedPoints`.
- **Spends** lower spendable via a conditional update (`spendablePoints >= cost`) so the balance can never go negative, and raise `lifetimeSpentPoints`. Spends do **not** lower lifetime earned.
- Every ledger event is **idempotent**. Duplicates are rejected by:
  - `@@unique([userId, qrCodeId])` — QR double-award guard.
  - `@@unique([shopifyRewardRedemptionId, reason], name: "uq_point_tx_redemption_reason")` — Shopify redeem/refund exactly-once.
  - `@@unique([userId, idempotencyKey], name: "uq_point_tx_user_idempotency_key")` — general idempotency (`qr-scan:*`, `shopify-reward-redemption:*`, `shopify-reward-refund:*`, `lesson-completion:*`, `course-completion:*`).
- All point mutations are **server-side**. Reward amounts for lesson/course completion are read from the database (`Lesson.completionPointsReward` / `Course.completionPointsReward`), never trusted from client input.

## Anonymous progress transfer and outstanding awards

Email verification and sign-in both call `transferAnonymousState()` in `src/lib/anonymous-transfer.ts`; no other code moves anonymous progress or unlocks to an account.

- Each anonymous lesson row and each anonymous unlock is claimed under a row lock (`SELECT … FOR UPDATE`) inside its own transaction, so exactly one concurrent caller moves it and rows written afterwards are left for the next call. Progress is merged with raise-only writes (`src/lib/lesson-progress.ts`): a position never decreases and a completed lesson never reverts.
- Ledger keys are unchanged (`qr-scan:*`, `lesson-completion:*`, `course-completion:*`). A historical row for the same `(userId, qrCodeId)` without an idempotency key counts as already awarded, so it cannot wedge a retry.
- A failure rolls back only the unit that failed (its anonymous row stays) and the result is `retry_required`. There is no transfer table: the remaining anonymous rows and the committed account rows are the durable state, so a later call (sign-in, or the dashboard Retry) finishes the work without a consumed verification code.
- **Outstanding completion awards.** Every call also pays completion rewards the account has earned but not yet been paid: completed lessons with a positive reward in an active lesson, active course and published experience the user does not own, then the affected courses. This runs even when there is no browser session, so accounts verified before this change are healed at their next sign-in. If a creator later raises a lesson's reward, learners who had already completed it are paid at their next sign-in (before, at their next progress save for that lesson); no ledger key changed, so nothing can be paid twice.

## Behaviour by type (`applyPointLedgerEvent`)

| Type | spendable | lifetime earned | lifetime spent | lifetime refunded | ledger sign |
|---|---|---|---|---|---|
| EARN | +p | +p | — | — | +p |
| SPEND | −p (guarded ≥ 0) | — | +p | — | −p |
| REFUND | +p | — | — | +p | +p |
| ADJUSTMENT | ±p (guarded ≥ 0) | +p only if explicitly flagged | — | — | ±p |

`applyPointLedgerEvent` returns `{ applied: false, reason }` for normal `DUPLICATE` / `INSUFFICIENT_POINTS` / `INVALID` cases and throws only on unexpected system errors. When called with an existing transaction client it joins that transaction; otherwise it opens its own. If a user has no `UserPointAccount` yet, one is self-healed entirely from `PointTransaction` history: spendable is the exhaustive signed sum of every ledger row for that user (by construction, `dSpendable === ledgerPoints` for every ledger type — see `computeLedgerDeltas`), and lifetime totals are derived by grouping on `(reason, type)` together (never `reason` alone). A user with no ledger history gets a zeroed account. Nothing is ever seeded from a denormalized column on the `User` row. Account creation uses an atomic `upsert` (a genuine no-op update on conflict, not an empty one — see `src/lib/points.ts` for why) so a race between two concurrent first-time requests for the same user always converges on exactly one account, and an already-existing account is never overwritten by a fresh reconstruction.

## Helpers

- `awardQrScanPoint` — +1 EARN, idempotent per `(userId, qrCodeId)`.
- `debitShopifyRewardPoints` — SPEND for a redemption (used inside the Serializable redeem transaction).
- `refundShopifyRewardPoints` — REFUND (used by the redeem failure paths and by reconciliation).
- `awardLessonCompletionPoints` / `awardCourseCompletionPoints` — EARN, once per user per lesson/course; reward read from DB; course award only fires when all active lessons are complete.

## Reconciliation

Rows stuck in `POINTS_DEBITED` are handled in bounded batches by `reward-reconciliation.ts`. It either confirms the Shopify discount (→ `ISSUED`), refunds exactly once via `refundShopifyRewardPoints` when the discount is definitively absent (→ `REFUNDED`), or retains the row for retry/manual review when Shopify status is ambiguous. The `uq_point_tx_redemption_reason` unique index keeps refunds exactly once even across concurrent reconciler runs.

## Completed production migration

**Migration `20260719061157_remove_legacy_user_points` was successfully applied to production on July 19, 2026.** Verified outcome:

- `User.points` no longer exists in the production database.
- `UserPointAccount` and `PointTransaction` totals were unchanged by the migration (it is a single `ALTER TABLE ... DROP COLUMN` — see `prisma/migrations/20260719061157_remove_legacy_user_points/migration.sql`).
- Post-migration account-versus-ledger reconciliation returned no rows.
- Post-migration lifetime-invariant checks returned no rows.
- Current application code (already committed and deployed) neither reads nor writes `User.points`, and the field is absent from `prisma/schema.prisma`.

This closes out the migration/rebuild history below:

- Schema change: `prisma/migrations/20260703120000_add_user_point_account_lifetime_rewards` (structure only — enums, `UserPointAccount`, new `PointTransaction` columns/indexes, `completionPointsReward` on `Course`/`Lesson`).
- **Historical** backfill: `prisma/manual-production-backfill.sql` (manual, reviewed, transaction-wrapped, already applied). It populated `UserPointAccount` and the new `PointTransaction` metadata columns from the `User.points` mirror (as it existed at the time) and the ledger. It never changed `User.points`, `PointTransaction.points`, or `PointTransaction.reason`, and left `balanceAfter` / `lifetimeEarnedAfter` NULL for historical rows. Retained for historical record only; it is not re-runnable now that `User.points` no longer exists.
- Legacy column removal: `prisma/migrations/20260719061157_remove_legacy_user_points` — **applied**, described above.
- Corrections must use compensating transactions; never delete or edit ledger rows.
- Future SQRATCH coin should mint from **verified lifetime earned**, not the current spendable balance.

## Historical expand/contract procedure

This section documents the two-stage deployment procedure that was actually followed, and the safety reasoning behind it — retained as a reference for any future expand/contract schema change on this ledger, not as pending work.

The change was an expand/contract migration: the **application code** stopped reading/writing `User.points` (and the Prisma schema stopped declaring it) in Stage A, before the **physical column** was dropped in Stage B. Reconciliation was required **before Stage A**, not merely before Stage B, because Stage A itself changed missing-account behavior: a missing `UserPointAccount` self-heals purely from `PointTransaction` history, so a production user whose legacy `User.points` disagreed with their ledger sum would have seen their balance change the moment Stage A shipped — before the column was ever dropped. This is the general principle to reapply for any future column whose removal changes self-healing/derivation behavior, not just this one: **reconciliation must precede the behavior change that depends on the data being clean, not merely the schema change that deletes the old copy.**

**Pre-Stage-A** (`prisma/pre-migration-checks-remove-user-points.sql` — "GATE 1"), completed before Stage A shipped:
1. Ran all production read-only reconciliation queries.
2. Identified every user missing a `UserPointAccount` (query 3).
3. Compared each such user's legacy `User.points` with their signed `PointTransaction` sum (query 4 — **blocking**).
4. Resolved every discrepancy that could change a balance once ledger-only self-healing went live.
5. Exported/archived legacy `User.id` and `User.points` before the column became unrecoverable.
6. Confirmed a database backup.

**Stage A** (completed — this repository's current, deployed state):
1. Application code that no longer reads or writes `User.points` was deployed.
2. The physical column was kept temporarily.
3. Production balances, awards, redemptions, refunds, API responses, and Points Activity were verified.
4. Production was observed for a safe period before proceeding.

**Stage B** (completed July 19, 2026 — "GATE 2", structural/account/ledger queries only):
1. The structural/account/ledger checks that remained meaningful were re-run (queries 1, 2, 6–13; the missing-account/legacy comparisons in queries 3–5 no longer triggered, since Stage A's self-healing had already resolved them).
2. The column-drop migration was applied (`ALTER TABLE "User" DROP COLUMN "points";` — the migration's only executable statement).
3. Schema was verified (`User.points` no longer exists in `information_schema.columns`), and `UserPointAccount` row count, `PointTransaction` count/sum, and redemption counts were confirmed unchanged from immediately before the migration.

## Historical pre-migration verification record

`prisma/pre-migration-checks-remove-user-points.sql` is retained in the repository as a completed operational runbook and audit record — it references the now-removed `User.points` column and documents the two-gate procedure above for historical context and for any environment that has not yet had this migration applied. It must not be run unchanged against an environment where the column has already been removed (every query in it references `"User"."points"`, which no longer exists once the migration is applied). See the notice at the top of that file.

## Read-only account-versus-ledger drift check

Run this read-only query and save the results for review. Lifetime reconstruction follows `deriveAccountFromLedger`: adjustment rows are included in spendable but excluded from lifetime totals because their lifetime effect is not durably recorded. A lifetime mismatch may therefore need investigation rather than a repair. This query makes no changes.

```sql
WITH grouped AS (
  SELECT "userId", "type", "reason", SUM("points") AS points
  FROM "PointTransaction"
  GROUP BY "userId", "type", "reason"
), ledger AS (
  SELECT "userId", SUM(points) AS spendable,
    SUM(CASE WHEN "type" = 'EARN' AND "reason" IN ('QR_SCAN', 'BONUS', 'REFERRAL') AND points > 0 THEN points ELSE 0 END) AS earned,
    SUM(CASE WHEN "type" = 'SPEND' AND "reason" = 'COMMERCE_REWARD_REDEMPTION' AND points < 0 THEN -points ELSE 0 END) AS spent,
    SUM(CASE WHEN "type" = 'REFUND' AND "reason" = 'COMMERCE_REWARD_REFUND' AND points > 0 THEN points ELSE 0 END) AS refunded
  FROM grouped GROUP BY "userId"
)
SELECT COALESCE(a."userId", l."userId") AS "userId",
  a."spendablePoints", COALESCE(l.spendable, 0) AS ledger_spendable,
  a."lifetimeEarnedPoints", COALESCE(l.earned, 0) AS ledger_earned,
  a."lifetimeSpentPoints", COALESCE(l.spent, 0) AS ledger_spent,
  a."lifetimeRefundedPoints", COALESCE(l.refunded, 0) AS ledger_refunded
FROM "UserPointAccount" a FULL JOIN ledger l ON l."userId" = a."userId"
WHERE a."userId" IS NULL
   OR a."spendablePoints" <> COALESCE(l.spendable, 0)
   OR a."lifetimeEarnedPoints" <> COALESCE(l.earned, 0)
   OR a."lifetimeSpentPoints" <> COALESCE(l.spent, 0)
   OR a."lifetimeRefundedPoints" <> COALESCE(l.refunded, 0)
ORDER BY 1;
```
