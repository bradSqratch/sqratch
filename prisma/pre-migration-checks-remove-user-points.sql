-- ============================================================================
-- HISTORICAL NOTICE — READ THIS FIRST
-- ============================================================================
--
-- Production execution and verification of this reconciliation procedure
-- COMPLETED on 2026-07-19. Migration 20260719061157_remove_legacy_user_points
-- was applied to production the same day; `npx prisma migrate status` and an
-- empty `npx prisma migrate diff` confirmed the schema afterward, and
-- "User"."points" no longer exists in production. See docs/points-ledger.md
-- for the full completed-migration record.
--
-- This file is retained in the repository as a completed audit and
-- operational history record, not as outstanding work. Every query below
-- references the now-removed "User"."points" column and therefore CANNOT be
-- run unchanged against any environment where that column has already been
-- dropped — doing so will fail with an "undefined column" error. It remains
-- useful, unmodified, as:
--   (a) a historical record of exactly what was checked before the
--       production migration ran, and
--   (b) a ready-to-use runbook for any OTHER environment that has not yet
--       had migration 20260719061157_remove_legacy_user_points applied and
--       still has the legacy column (for example, an older environment
--       restored from a pre-migration backup, or a long-lived branch/preview
--       database that predates the migration).
--
-- The original two-gate (pre-Stage-A / pre-Stage-B) procedure below is
-- intentionally preserved exactly as it was written and used — do not edit
-- it to read as historical prose; its value is as an unmodified historical
-- and legacy-environment record.
--
-- ============================================================================
-- PRODUCTION RECONCILIATION: removal of the legacy "User"."points" column
-- ============================================================================
--
-- READ-ONLY. Every statement below is a SELECT (some using a read-only CTE).
-- Nothing in this file writes, updates, deletes, or locks anything. It is
-- safe to run against production (Supabase) THAT HAS NOT YET HAD THE COLUMN
-- REMOVED — see the historical notice above.
--
-- Context:
--   - "UserPointAccount" (spendablePoints / lifetimeEarnedPoints /
--     lifetimeSpentPoints / lifetimeRefundedPoints) is the authoritative
--     balance store.
--   - "PointTransaction" is the authoritative, immutable activity ledger.
--   - "User"."points" was a synced mirror of "UserPointAccount".spendablePoints.
--     It is deprecated and no longer used by application code, and no longer
--     declared in the Prisma schema, but the physical database column is NOT
--     dropped until migration 20260719061157_remove_legacy_user_points is
--     applied (Stage B below). Until then, environments that have deployed
--     the application code change but not yet the migration retain the
--     unused column.
--
-- WHEN TO RUN THIS FILE — TWICE, AT TWO DIFFERENT GATES:
--
--   GATE 1 — BEFORE STAGE A (deploying the application code change):
--     Stage A code makes account self-healing for a MISSING UserPointAccount
--     derive entirely from PointTransaction history, instead of (as before)
--     initializing spendable from "User"."points". If a production user has
--     no UserPointAccount row AND their legacy "points" value disagrees with
--     the signed sum of their own PointTransaction rows, that user's balance
--     changes the instant their account is first self-healed after Stage A
--     ships — before the column is ever dropped. Every query in this file,
--     and especially check 4 below, MUST be run and every discrepancy MUST
--     be resolved (or explicitly accepted with a written reason) before
--     Stage A is deployed, not merely before Stage B's migration.
--
--   GATE 2 — BEFORE STAGE B (applying the DROP COLUMN migration):
--     Re-run the structural/account/ledger checks that remain meaningful
--     once Stage A has been running for a while (checks 1, 2, 6, 7, 8, 9,
--     10, 11, 12, 13 — i.e. everything except the missing-account/legacy
--     comparisons, which no missing account should still trigger by this
--     point since Stage A's self-healing has already resolved them). This
--     is the final safety gate before the column's values become
--     unrecoverable.
--
-- Pre-Stage-A checklist (see PROBLEM 1 in the task that produced this file):
--   1. Run every query below.
--   2. Identify every user missing a UserPointAccount row (check 3).
--   3. Compare each such user's legacy "points" with their signed
--      PointTransaction sum (check 4 — BLOCKING).
--   4. Resolve every discrepancy that could change a balance when
--      ledger-only self-healing goes live — classify, correct, or
--      explicitly accept with a written reason. Do not deploy Stage A over
--      an unresolved row from check 4.
--   5. Export/archive legacy "User"."id" and "User"."points" (a simple
--      `SELECT "id", "points" FROM "User"` to a file/table is sufficient —
--      not included here since it is an export, not a verification query).
--   6. Take or confirm a database backup.
--
-- How to classify results:
--   - Any non-empty result under a query marked BLOCKING must be resolved
--     before proceeding to that gate. Classify as: expected historical
--     mismatch, stale legacy mirror, missing current account, genuine
--     ledger/account inconsistency, test/demo data, or unresolved anomaly
--     requiring manual review. Do NOT auto-correct from this file — this
--     file contains no corrective UPDATE/DELETE/INSERT statements by design.
--
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Total number of users
-- ----------------------------------------------------------------------------
SELECT count(*) AS total_users
FROM "User";

-- ----------------------------------------------------------------------------
-- 2. Total number of UserPointAccount rows
-- ----------------------------------------------------------------------------
SELECT count(*) AS total_point_accounts
FROM "UserPointAccount";

-- ----------------------------------------------------------------------------
-- 3. Users missing a UserPointAccount row — full context
-- ----------------------------------------------------------------------------
-- Every user with no UserPointAccount row, with enough context to judge each
-- one at a glance: their legacy points value, how many PointTransaction rows
-- they actually have, what those rows sum to, and the difference between the
-- legacy value and that sum. This is the informational superset that checks
-- 4 and 5 below split into "blocking" and "safe".
SELECT
  u."id",
  u."email",
  u."points" AS legacy_points,
  COALESCE(l.transaction_count, 0) AS transaction_count,
  COALESCE(l.ledger_sum, 0) AS ledger_sum,
  u."points" - COALESCE(l.ledger_sum, 0) AS difference,
  u."createdAt"
FROM "User" u
LEFT JOIN "UserPointAccount" a ON a."userId" = u."id"
LEFT JOIN (
  SELECT "userId", count(*) AS transaction_count, COALESCE(sum("points"), 0) AS ledger_sum
  FROM "PointTransaction"
  GROUP BY "userId"
) l ON l."userId" = u."id"
WHERE a."userId" IS NULL
ORDER BY u."createdAt" ASC;

-- ----------------------------------------------------------------------------
-- 4. [BLOCKING — MUST BE RESOLVED BEFORE STAGE A] Missing-account users
--    whose legacy points disagree with their ledger sum
-- ----------------------------------------------------------------------------
-- This is the query PROBLEM 1 exists to guarantee gets run. After Stage A,
-- a missing UserPointAccount self-heals its spendable balance entirely from
-- COALESCE(SUM("PointTransaction"."points"), 0) — never from "User"."points".
-- Any row returned here is a user whose balance WILL CHANGE (up or down) the
-- moment their account is first self-healed post-Stage-A, because the
-- legacy value they may have seen in the product does not match what the
-- ledger says they should have. This includes the most severe sub-case: a
-- user with a non-zero legacy value and ZERO PointTransaction rows at all
-- (transaction_count = 0, ledger_sum = 0) — their legacy balance cannot be
-- attributed to any ledger event whatsoever and must be individually
-- investigated, not carried forward.
--
-- Expected classification for any row returned:
--   - "stale legacy mirror" — only acceptable if independently confirmed the
--     ledger is correct and the legacy value is simply wrong/stale (safe to
--     let self-healing proceed; document why).
--   - "genuine ledger/account inconsistency" or "unresolved anomaly requiring
--     manual review" — do NOT deploy Stage A until resolved.
-- Expected result in a healthy database: zero rows.
WITH ledger AS (
  SELECT
    "userId",
    COUNT(*) AS transaction_count,
    COALESCE(SUM("points"), 0) AS ledger_sum
  FROM "PointTransaction"
  GROUP BY "userId"
)
SELECT
  u."id",
  u."email",
  u."points" AS legacy_points,
  COALESCE(l.transaction_count, 0) AS transaction_count,
  COALESCE(l.ledger_sum, 0) AS ledger_sum,
  u."points" - COALESCE(l.ledger_sum, 0) AS difference,
  u."createdAt"
FROM "User" u
LEFT JOIN "UserPointAccount" a
  ON a."userId" = u."id"
LEFT JOIN ledger l
  ON l."userId" = u."id"
WHERE a."userId" IS NULL
  AND u."points" <> COALESCE(l.ledger_sum, 0)
ORDER BY ABS(u."points" - COALESCE(l.ledger_sum, 0)) DESC;

-- ----------------------------------------------------------------------------
-- 5. [Informational — safe] Missing-account users whose legacy points already
--    match their ledger sum, or who have no ledger history at all
-- ----------------------------------------------------------------------------
-- The complement of check 4. These users are safe to let self-heal after
-- Stage A: either their legacy value already equals what the ledger-derived
-- spendable balance will be (post-Stage-A self-healing reproduces the exact
-- same number), or they have zero PointTransaction rows and a zero legacy
-- value (a genuinely new/inactive user who correctly gets a zeroed account).
-- No action required for rows returned here.
WITH ledger AS (
  SELECT
    "userId",
    COUNT(*) AS transaction_count,
    COALESCE(SUM("points"), 0) AS ledger_sum
  FROM "PointTransaction"
  GROUP BY "userId"
)
SELECT
  u."id",
  u."email",
  u."points" AS legacy_points,
  COALESCE(l.transaction_count, 0) AS transaction_count,
  COALESCE(l.ledger_sum, 0) AS ledger_sum,
  u."createdAt"
FROM "User" u
LEFT JOIN "UserPointAccount" a
  ON a."userId" = u."id"
LEFT JOIN ledger l
  ON l."userId" = u."id"
WHERE a."userId" IS NULL
  AND u."points" = COALESCE(l.ledger_sum, 0)
ORDER BY u."createdAt" ASC;

-- ----------------------------------------------------------------------------
-- 6. Users where legacy User.points differs from authoritative spendablePoints
--    (users who already HAVE a UserPointAccount)
-- ----------------------------------------------------------------------------
-- Expected classification:
--   - No rows: healthy — the legacy mirror and the authoritative account
--     agree everywhere it exists. Safe with respect to this check.
--   - Any rows: classify each as either "stale legacy mirror" (the account
--     is correct, the old column simply stopped being read/written before
--     this task, or drifted from a manual DB edit) or "genuine ledger/account
--     inconsistency" if the SUM in check 10 also disagrees with the account.
--     Do NOT assume the legacy column is correct — "UserPointAccount" and
--     "PointTransaction" are authoritative. Note: unlike check 4, a
--     discrepancy here does NOT change any balance at Stage A — these users
--     already have an account, so self-healing never runs for them. Still
--     worth reviewing, but not a Stage-A blocker.
SELECT u."id", u."email", u."points" AS legacy_points, a."spendablePoints"
FROM "User" u
JOIN "UserPointAccount" a ON a."userId" = u."id"
WHERE u."points" <> a."spendablePoints"
ORDER BY abs(u."points" - a."spendablePoints") DESC;

-- ----------------------------------------------------------------------------
-- 7. Negative balances
-- ----------------------------------------------------------------------------
-- Expected classification: no rows. The ledger's conditional decrement
-- (`spendablePoints >= cost`) should make a negative spendable balance
-- structurally impossible. Any row here is an unresolved anomaly requiring
-- manual review before any destructive migration.
SELECT "userId", "spendablePoints", "lifetimeEarnedPoints", "lifetimeSpentPoints", "lifetimeRefundedPoints"
FROM "UserPointAccount"
WHERE "spendablePoints" < 0
   OR "lifetimeEarnedPoints" < 0
   OR "lifetimeSpentPoints" < 0
   OR "lifetimeRefundedPoints" < 0;

-- ----------------------------------------------------------------------------
-- 8. Invalid lifetime totals
-- ----------------------------------------------------------------------------
-- Invariant used by the application (src/lib/points.ts, computeLedgerDeltas):
--   spendablePoints = lifetimeEarnedPoints + lifetimeRefundedPoints - lifetimeSpentPoints
-- This holds for every EARN / SPEND / REFUND event, and for a positive
-- ADJUSTMENT only when explicitly flagged as counting toward lifetime earned.
-- No code path in the current application issues an ADJUSTMENT event, so in
-- a healthy production dataset this identity should hold exactly.
-- Expected classification:
--   - No rows: healthy.
--   - Any rows: classify as "genuine ledger/account inconsistency" and
--     review the user's full PointTransaction history (check 12) before any
--     destructive migration. Do not auto-correct from this file.
SELECT "userId", "spendablePoints", "lifetimeEarnedPoints", "lifetimeSpentPoints", "lifetimeRefundedPoints",
       ("lifetimeEarnedPoints" + "lifetimeRefundedPoints" - "lifetimeSpentPoints") AS expected_spendable
FROM "UserPointAccount"
WHERE "spendablePoints" <> ("lifetimeEarnedPoints" + "lifetimeRefundedPoints" - "lifetimeSpentPoints");

-- ----------------------------------------------------------------------------
-- 9. Duplicate point-account rows
-- ----------------------------------------------------------------------------
-- "UserPointAccount"."userId" is the primary key, so Postgres itself
-- structurally prevents duplicates. This query is included defensively (per
-- the review checklist) and is expected to always return zero rows; a
-- non-empty result would indicate primary-key corruption and must be treated
-- as an unresolved anomaly requiring immediate manual review, independent of
-- this migration.
SELECT "userId", count(*) AS row_count
FROM "UserPointAccount"
GROUP BY "userId"
HAVING count(*) > 1;

-- ----------------------------------------------------------------------------
-- 10. Ledger totals compared with account totals (reconciliation)
-- ----------------------------------------------------------------------------
-- By construction, the signed sum of every PointTransaction row for a user
-- always equals that user's spendablePoints (dSpendable === ledgerPoints for
-- every ledger type — see computeLedgerDeltas). This directly verifies that
-- invariant against production data, for users who already have an account.
-- Expected classification:
--   - No rows: healthy.
--   - Any rows: "genuine ledger/account inconsistency" — the account balance
--     does not match its own ledger history. Requires manual review; this is
--     the single most important check in this file for EXISTING accounts
--     (check 4 is the equivalent gate for MISSING accounts), since it
--     questions the authoritative source itself, not the legacy mirror.
SELECT a."userId", a."spendablePoints" AS account_spendable, COALESCE(t.ledger_sum, 0) AS ledger_sum
FROM "UserPointAccount" a
LEFT JOIN (
  SELECT "userId", sum("points") AS ledger_sum
  FROM "PointTransaction"
  GROUP BY "userId"
) t ON t."userId" = a."userId"
WHERE a."spendablePoints" <> COALESCE(t.ledger_sum, 0);

-- ----------------------------------------------------------------------------
-- 11. Users with a point account but no legacy points
-- ----------------------------------------------------------------------------
-- Expected classification: a user with a positive spendablePoints balance but
-- legacy "points" = 0 suggests the account was created/updated by a path
-- that never wrote the legacy mirror (e.g. earned points after Stage A
-- shipped, or a pre-existing gap). Classify as "expected" only if the user's
-- most recent PointTransaction post-dates Stage A's deployment; otherwise
-- treat as "stale legacy mirror" (safe) unless check 10 also disagrees for
-- the same user (then: genuine inconsistency).
SELECT u."id", u."email", u."points" AS legacy_points, a."spendablePoints"
FROM "User" u
JOIN "UserPointAccount" a ON a."userId" = u."id"
WHERE u."points" = 0
  AND a."spendablePoints" <> 0;

-- ----------------------------------------------------------------------------
-- 12. Recent point transactions by reason/type (last 30 days)
-- ----------------------------------------------------------------------------
-- Sanity-check that ledger activity looks normal (no unexpected spikes,
-- reasons, or types) before touching schema.
SELECT "reason", "type", count(*) AS row_count, sum("points") AS points_sum
FROM "PointTransaction"
WHERE "createdAt" >= now() - interval '30 days'
GROUP BY "reason", "type"
ORDER BY "reason", "type";

-- ----------------------------------------------------------------------------
-- 13. Redemption and refund consistency
-- ----------------------------------------------------------------------------
-- Every ShopifyRewardRedemption that reached POINTS_DEBITED or beyond should
-- have exactly one corresponding SHOPIFY_REWARD_REDEMPTION PointTransaction,
-- and every REFUNDED redemption should additionally have exactly one
-- SHOPIFY_REWARD_REFUND PointTransaction (enforced by the
-- uq_point_tx_redemption_reason unique constraint, so this should always
-- hold structurally — included here as an independent cross-check).
SELECT
  r."status",
  count(*) AS redemption_count,
  count(dt."id") AS matching_debit_transactions,
  count(rt."id") AS matching_refund_transactions
FROM "ShopifyRewardRedemption" r
LEFT JOIN "PointTransaction" dt
  ON dt."shopifyRewardRedemptionId" = r."id" AND dt."reason" = 'SHOPIFY_REWARD_REDEMPTION'
LEFT JOIN "PointTransaction" rt
  ON rt."shopifyRewardRedemptionId" = r."id" AND rt."reason" = 'SHOPIFY_REWARD_REFUND'
GROUP BY r."status"
ORDER BY r."status";

-- Redemptions that reached POINTS_DEBITED or later but have no matching debit
-- transaction at all — expected: zero rows.
SELECT r."id", r."status", r."userId", r."pointsCost", r."createdAt"
FROM "ShopifyRewardRedemption" r
LEFT JOIN "PointTransaction" dt
  ON dt."shopifyRewardRedemptionId" = r."id" AND dt."reason" = 'SHOPIFY_REWARD_REDEMPTION'
WHERE r."status" NOT IN ('PENDING', 'FAILED', 'CANCELLED')
  AND dt."id" IS NULL;

-- Redemptions marked REFUNDED but with no matching refund transaction —
-- expected: zero rows.
SELECT r."id", r."status", r."userId", r."pointsCost", r."createdAt"
FROM "ShopifyRewardRedemption" r
LEFT JOIN "PointTransaction" rt
  ON rt."shopifyRewardRedemptionId" = r."id" AND rt."reason" = 'SHOPIFY_REWARD_REFUND'
WHERE r."status" = 'REFUNDED'
  AND rt."id" IS NULL;

-- ============================================================================
-- End of reconciliation checks.
--   - Before STAGE A: do not deploy the application code change while check 4
--     has any unresolved row.
--   - Before STAGE B: re-run checks 1, 2, 6, 7, 8, 9, 10, 11, 12, 13 and
--     confirm no "genuine ledger/account inconsistency" or "unresolved
--     anomaly" remains before applying the column-drop migration.
-- ============================================================================
