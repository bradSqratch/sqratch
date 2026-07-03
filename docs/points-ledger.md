# Points Ledger Invariants

## The two-balance model

SQRATCH tracks two balances per user:

- **Spendable / current points** — what a user can spend on Shopify reward coupons (and future redemptions). Spending lowers it; refunds restore it.
- **Lifetime earned points** — the total a user has genuinely earned over their lifetime. Spending never lowers it and refunds never raise it. Future SQRATCH coin/minting is based on this number, so spending points must never erase proof of participation.

## Sources of truth

- `PointTransaction` is the **immutable append-only audit ledger** and the single source of truth. Never delete a row and never edit a row to "fix" a balance — add a compensating transaction instead. There is no second, independent "universal points" table.
- `UserPointAccount` is a **fast-read aggregate** (one row per user): `spendablePoints`, `lifetimeEarnedPoints`, `lifetimeSpentPoints`, `lifetimeRefundedPoints`, `version`. It is derived from the ledger and is safe to rebuild from it.
- `User.points` is a **legacy synced mirror** of `UserPointAccount.spendablePoints`. It is kept in sync for now and will be retired once all readers move to the account.

## Invariants

- Every balance/aggregate mutation and its ledger row happen in the **same database transaction**.
- All point mutations go through `applyPointLedgerEvent()` in `src/lib/points.ts` — the only place that writes both a `PointTransaction` and the `UserPointAccount` aggregate and mirrors `User.points`.
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

`applyPointLedgerEvent` returns `{ applied: false, reason }` for normal `DUPLICATE` / `INSUFFICIENT_POINTS` / `INVALID` cases and throws only on unexpected system errors. When called with an existing transaction client it joins that transaction; otherwise it opens its own. If a user has no `UserPointAccount` yet, one is self-healed from `User.points` (spendable) and the ledger (lifetime totals), matching the manual backfill exactly.

## Helpers

- `awardQrScanPoint` — +1 EARN, idempotent per `(userId, qrCodeId)`.
- `debitShopifyRewardPoints` — SPEND for a redemption (used inside the Serializable redeem transaction).
- `refundShopifyRewardPoints` — REFUND (used by the redeem failure paths and by reconciliation).
- `awardLessonCompletionPoints` / `awardCourseCompletionPoints` — EARN, once per user per lesson/course; reward read from DB; course award only fires when all active lessons are complete.

## Reconciliation

Rows stuck in `POINTS_DEBITED` are handled in bounded batches by `reward-reconciliation.ts`. It either confirms the Shopify discount (→ `ISSUED`), refunds exactly once via `refundShopifyRewardPoints` when the discount is definitively absent (→ `REFUNDED`), or retains the row for retry/manual review when Shopify status is ambiguous. The `uq_point_tx_redemption_reason` unique index keeps refunds exactly once even across concurrent reconciler runs.

## Migration / rebuild notes

- Schema change: `prisma/migrations/20260703120000_add_user_point_account_lifetime_rewards` (structure only — enums, `UserPointAccount`, new `PointTransaction` columns/indexes, `completionPointsReward` on `Course`/`Lesson`).
- Historical backfill: `prisma/manual-production-backfill.sql` (manual, reviewed, transaction-wrapped). It populates `UserPointAccount` and the new `PointTransaction` metadata columns; it never changes `User.points`, `PointTransaction.points`, or `PointTransaction.reason`, and leaves `balanceAfter` / `lifetimeEarnedAfter` NULL for historical rows.
- Corrections must use compensating transactions; never delete or edit ledger rows.
- Future SQRATCH coin should mint from **verified lifetime earned**, not the current spendable balance.
