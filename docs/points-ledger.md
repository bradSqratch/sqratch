# Points Ledger Invariants

## The two-balance model

SQRATCH tracks two balances per user:

- **Spendable / current points** — what a user can spend on Shopify reward coupons (and future redemptions). Spending lowers it; refunds restore it.
- **Lifetime earned points** — the total a user has genuinely earned over their lifetime. Spending never lowers it and refunds never raise it. Future SQRATCH coin/minting is based on this number, so spending points must never erase proof of participation.

## Sources of truth

- `PointTransaction` is the **immutable append-only audit ledger** and the single source of truth. Never delete a row and never edit a row to "fix" a balance — add a compensating transaction instead. There is no second, independent "universal points" table.
- `UserPointAccount` is the **authoritative balance store** (one row per user): `spendablePoints`, `lifetimeEarnedPoints`, `lifetimeSpentPoints`, `lifetimeRefundedPoints`, `version`. It is derived from the ledger and is safe to rebuild from it.
- `User.points` is **deprecated and no longer used by application code**. It has been removed from the Prisma schema (`prisma/schema.prisma`) and from every code path in this repository. The **physical database column** is removed only once migration `20260719061157_remove_legacy_user_points` is applied to a given environment (see "Deployment: removing User.points" below) — environments where that migration has not yet been applied may temporarily retain the unused column. `UserPointAccount` is the sole balance store, in application code and (after the migration) in the schema. Application code must never introduce another mirror balance — every new point-award path must go through `applyPointLedgerEvent` (or one of its domain helpers) in `src/lib/points.ts`.

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

## Behaviour by type (`applyPointLedgerEvent`)

| Type | spendable | lifetime earned | lifetime spent | lifetime refunded | ledger sign |
|---|---|---|---|---|---|
| EARN | +p | +p | — | — | +p |
| SPEND | −p (guarded ≥ 0) | — | +p | — | −p |
| REFUND | +p | — | — | +p | +p |
| ADJUSTMENT | ±p (guarded ≥ 0) | +p only if explicitly flagged | — | — | ±p |

`applyPointLedgerEvent` returns `{ applied: false, reason }` for normal `DUPLICATE` / `INSUFFICIENT_POINTS` / `INVALID` cases and throws only on unexpected system errors. When called with an existing transaction client it joins that transaction; otherwise it opens its own. If a user has no `UserPointAccount` yet, one is self-healed entirely from `PointTransaction` history: spendable is the exhaustive signed sum of every ledger row for that user (by construction, `dSpendable === ledgerPoints` for every ledger type — see `computeLedgerDeltas`), and lifetime totals are derived the same way the manual backfill classified them. A user with no ledger history gets a zeroed account. Nothing is ever seeded from a denormalized column on the `User` row.

> **Deployment note**: this ledger-only self-healing behavior is a change from the previous implementation, which seeded a missing account's spendable balance from `User.points`. Before deploying this behavior to production (Stage A below), every user missing a `UserPointAccount` whose legacy `User.points` disagrees with their own `PointTransaction` sum must be identified and resolved — otherwise their balance changes the instant their account is first self-healed. See "Deployment: removing User.points" below.

## Helpers

- `awardQrScanPoint` — +1 EARN, idempotent per `(userId, qrCodeId)`.
- `debitShopifyRewardPoints` — SPEND for a redemption (used inside the Serializable redeem transaction).
- `refundShopifyRewardPoints` — REFUND (used by the redeem failure paths and by reconciliation).
- `awardLessonCompletionPoints` / `awardCourseCompletionPoints` — EARN, once per user per lesson/course; reward read from DB; course award only fires when all active lessons are complete.

## Reconciliation

Rows stuck in `POINTS_DEBITED` are handled in bounded batches by `reward-reconciliation.ts`. It either confirms the Shopify discount (→ `ISSUED`), refunds exactly once via `refundShopifyRewardPoints` when the discount is definitively absent (→ `REFUNDED`), or retains the row for retry/manual review when Shopify status is ambiguous. The `uq_point_tx_redemption_reason` unique index keeps refunds exactly once even across concurrent reconciler runs.

## Migration / rebuild notes

- Schema change: `prisma/migrations/20260703120000_add_user_point_account_lifetime_rewards` (structure only — enums, `UserPointAccount`, new `PointTransaction` columns/indexes, `completionPointsReward` on `Course`/`Lesson`).
- **Historical** backfill: `prisma/manual-production-backfill.sql` (manual, reviewed, transaction-wrapped, already applied). It populated `UserPointAccount` and the new `PointTransaction` metadata columns from the `User.points` mirror (as it existed at the time) and the ledger. It never changed `User.points`, `PointTransaction.points`, or `PointTransaction.reason`, and left `balanceAfter` / `lifetimeEarnedAfter` NULL for historical rows. This file is kept for historical record only.
- Legacy column removal (in progress — see deployment order below): `prisma/migrations/20260719061157_remove_legacy_user_points` drops the physical `User.points` column. Reconciliation queries live in `prisma/pre-migration-checks-remove-user-points.sql` (read-only) and must be run at **two** gates, not one — see below.
- Corrections must use compensating transactions; never delete or edit ledger rows.
- Future SQRATCH coin should mint from **verified lifetime earned**, not the current spendable balance.

## Deployment: removing User.points

This is an expand/contract change. The **application code** stops reading/writing `User.points` (and the Prisma schema stops declaring it) in Stage A; the **physical column** is not dropped until Stage B. Reconciliation is required **before Stage A**, not merely before Stage B, because Stage A itself changes missing-account behavior (see the deployment note above): a missing `UserPointAccount` now self-heals purely from `PointTransaction` history, so a production user whose legacy `User.points` disagreed with their ledger sum would see their balance change the moment Stage A ships, days or weeks before the column is ever dropped.

**Pre-Stage-A** (run `prisma/pre-migration-checks-remove-user-points.sql` — "GATE 1"):
1. Run all production read-only reconciliation queries.
2. Identify every user missing a `UserPointAccount` (query 3).
3. Compare each such user's legacy `User.points` with their signed `PointTransaction` sum (query 4 — **blocking**).
4. Resolve every discrepancy that could change a balance once ledger-only self-healing goes live.
5. Export/archive legacy `User.id` and `User.points` (a plain `SELECT "id", "points" FROM "User"`, run separately from the verification file).
6. Take or confirm a database backup.

**Stage A**:
1. Deploy application code that no longer reads or writes `User.points` (this repo's current state — the Prisma schema no longer declares the field, but the column still physically exists until Stage B).
2. Keep the physical column.
3. Verify production balances, awards, redemptions, refunds, API responses, and Points Activity.
4. Observe production for a safe period.

**Stage B** (re-run the file — "GATE 2", structural/account/ledger queries only):
1. Re-run the structural/account/ledger checks that remain meaningful (queries 1, 2, 6–13; the missing-account/legacy comparisons in queries 3–5 should no longer trigger, since Stage A's self-healing already resolved them).
2. Apply the column-drop migration (`ALTER TABLE "User" DROP COLUMN "points";` — the migration's only executable statement).
3. Verify schema (`User.points` no longer exists in `information_schema.columns`) and confirm `UserPointAccount` row count, `PointTransaction` count/sum, and redemption counts are unchanged from immediately before the migration.

Only once Stage B is confirmed stable in production should later documentation cleanup state that removal is complete everywhere.
