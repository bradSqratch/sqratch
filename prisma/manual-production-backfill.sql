-- ===========================================================================
-- manual-production-backfill.sql
--
-- One-time, MANUAL, additive backfill for the two-balance points system.
-- Run this AFTER the structure migration
-- (20260703120000_add_user_point_account_lifetime_rewards) has been applied,
-- and BEFORE (or during a maintenance window, just before) deploying the new
-- app code.
--
-- Safe production order:
--   1. Deploy schema migration:  npx prisma migrate deploy
--   2. Run this backfill SQL (review the verification output, then COMMIT)
--   3. Deploy app code (Vercel)
--   4. Smoke test
--
-- Guarantees:
--   * Additive / non-destructive. Deletes nothing.
--   * Does NOT change "User"."points".
--   * Does NOT change "PointTransaction"."points".
--   * Does NOT change "PointTransaction"."reason".
--   * Only populates "UserPointAccount" and the new metadata columns on
--     "PointTransaction" (type, sourceType, sourceId, idempotencyKey).
--   * Leaves "balanceAfter" and "lifetimeEarnedAfter" NULL for historical rows
--     (there is no safe way to reconstruct per-row running balances after the
--     fact; new rows written by the app will populate them going forward).
--   * Re-runnable: each UPDATE is guarded by "sourceType" IS NULL, and the
--     INSERT uses ON CONFLICT DO NOTHING, so running twice is a no-op.
--
-- Lifetime accounting rules (must match src/lib/points.ts):
--   * lifetimeEarned counts ONLY true earnings: reason IN (QR_SCAN,BONUS,REFERRAL)
--     with points > 0. Shopify refunds are POSITIVE but are NOT earnings.
--   * lifetimeSpent  = ABS of negative SHOPIFY_REWARD_REDEMPTION rows.
--   * lifetimeRefunded = positive SHOPIFY_REWARD_REFUND rows.
--   * spendable = "User"."points" (the legacy spendable balance).
-- ===========================================================================


-- ===========================================================================
-- STEP 1 — PREFLIGHT (read-only). Run these first and eyeball the output.
-- ===========================================================================

-- 1a. How many users and transactions are we about to touch?
SELECT
  (SELECT count(*) FROM "User")                                            AS total_users,
  (SELECT count(*) FROM "UserPointAccount")                                AS existing_accounts,
  (SELECT count(*) FROM "PointTransaction")                                AS total_transactions,
  (SELECT count(*) FROM "PointTransaction" WHERE "sourceType" IS NULL)     AS transactions_needing_metadata;

-- 1b. Reason distribution (sanity check that only the 5 known reasons exist).
SELECT "reason", count(*) AS rows, sum("points") AS sum_points
FROM "PointTransaction"
GROUP BY "reason"
ORDER BY "reason";

-- 1c. Detect any idempotencyKey collisions BEFORE applying the unique index
--     values. This SHOULD return zero rows. If it returns rows, STOP and
--     inspect — do not proceed, do not drop the constraint.
WITH derived AS (
  SELECT
    "userId",
    CASE
      WHEN "reason" = 'QR_SCAN'                  AND "qrCodeId" IS NOT NULL
        THEN 'qr-scan:' || "qrCodeId"
      WHEN "reason" = 'SHOPIFY_REWARD_REDEMPTION' AND "shopifyRewardRedemptionId" IS NOT NULL
        THEN 'shopify-reward-redemption:' || "shopifyRewardRedemptionId"
      WHEN "reason" = 'SHOPIFY_REWARD_REFUND'     AND "shopifyRewardRedemptionId" IS NOT NULL
        THEN 'shopify-reward-refund:' || "shopifyRewardRedemptionId"
      ELSE NULL
    END AS derived_key
  FROM "PointTransaction"
)
SELECT "userId", derived_key, count(*)
FROM derived
WHERE derived_key IS NOT NULL
GROUP BY "userId", derived_key
HAVING count(*) > 1;


-- ===========================================================================
-- STEP 2 — BACKFILL (transaction-wrapped). Run this whole block, review the
-- STEP 3 verification output, then COMMIT (or ROLLBACK if anything is wrong).
-- ===========================================================================
BEGIN;

-- 2a. PointTransaction metadata — QR_SCAN (true earning).
UPDATE "PointTransaction" SET
  "type"           = 'EARN',
  "sourceType"     = 'QR_SCAN',
  "sourceId"       = "qrCodeId",
  "idempotencyKey" = CASE WHEN "qrCodeId" IS NOT NULL
                          THEN 'qr-scan:' || "qrCodeId"
                          ELSE "idempotencyKey" END
WHERE "reason" = 'QR_SCAN' AND "sourceType" IS NULL;

-- 2b. PointTransaction metadata — BONUS (true earning).
UPDATE "PointTransaction" SET
  "type"       = 'EARN',
  "sourceType" = 'BONUS'
WHERE "reason" = 'BONUS' AND "sourceType" IS NULL;

-- 2c. PointTransaction metadata — REFERRAL (true earning).
UPDATE "PointTransaction" SET
  "type"       = 'EARN',
  "sourceType" = 'REFERRAL'
WHERE "reason" = 'REFERRAL' AND "sourceType" IS NULL;

-- 2d. PointTransaction metadata — SHOPIFY_REWARD_REDEMPTION (spend).
UPDATE "PointTransaction" SET
  "type"           = 'SPEND',
  "sourceType"     = 'SHOPIFY_REWARD_REDEMPTION',
  "sourceId"       = "shopifyRewardRedemptionId",
  "idempotencyKey" = CASE WHEN "shopifyRewardRedemptionId" IS NOT NULL
                          THEN 'shopify-reward-redemption:' || "shopifyRewardRedemptionId"
                          ELSE "idempotencyKey" END
WHERE "reason" = 'SHOPIFY_REWARD_REDEMPTION' AND "sourceType" IS NULL;

-- 2e. PointTransaction metadata — SHOPIFY_REWARD_REFUND (refund; NOT earning).
UPDATE "PointTransaction" SET
  "type"           = 'REFUND',
  "sourceType"     = 'SHOPIFY_REWARD_REFUND',
  "sourceId"       = "shopifyRewardRedemptionId",
  "idempotencyKey" = CASE WHEN "shopifyRewardRedemptionId" IS NOT NULL
                          THEN 'shopify-reward-refund:' || "shopifyRewardRedemptionId"
                          ELSE "idempotencyKey" END
WHERE "reason" = 'SHOPIFY_REWARD_REFUND' AND "sourceType" IS NULL;

-- 2f. UserPointAccount — one aggregate row per user. Existing accounts are left
--     untouched (ON CONFLICT DO NOTHING) so any account already created by the
--     running app is preserved.
INSERT INTO "UserPointAccount" (
  "userId",
  "spendablePoints",
  "lifetimeEarnedPoints",
  "lifetimeSpentPoints",
  "lifetimeRefundedPoints",
  "version",
  "createdAt",
  "updatedAt"
)
SELECT
  u."id",
  u."points",
  COALESCE(agg.earned, 0),
  COALESCE(agg.spent, 0),
  COALESCE(agg.refunded, 0),
  0,
  now(),
  now()
FROM "User" u
LEFT JOIN (
  SELECT
    "userId",
    SUM(CASE WHEN "reason" IN ('QR_SCAN','BONUS','REFERRAL') AND "points" > 0
             THEN "points" ELSE 0 END)                                        AS earned,
    ABS(SUM(CASE WHEN "reason" = 'SHOPIFY_REWARD_REDEMPTION' AND "points" < 0
             THEN "points" ELSE 0 END))                                       AS spent,
    SUM(CASE WHEN "reason" = 'SHOPIFY_REWARD_REFUND' AND "points" > 0
             THEN "points" ELSE 0 END)                                        AS refunded
  FROM "PointTransaction"
  GROUP BY "userId"
) agg ON agg."userId" = u."id"
ON CONFLICT ("userId") DO NOTHING;


-- ===========================================================================
-- STEP 3 — IN-TRANSACTION VERIFICATION. Review these BEFORE committing.
-- ===========================================================================

-- 3a. Every user should now have exactly one account row.
SELECT
  (SELECT count(*) FROM "User")             AS total_users,
  (SELECT count(*) FROM "UserPointAccount") AS total_accounts;

-- 3b. spendablePoints must equal legacy "User"."points" for every user.
--     This MUST return zero rows.
SELECT u."id", u."points", a."spendablePoints"
FROM "User" u
JOIN "UserPointAccount" a ON a."userId" = u."id"
WHERE u."points" <> a."spendablePoints";

-- 3c. Recompute lifetime aggregates from the ledger and compare to the account.
--     This MUST return zero rows.
SELECT a."userId", a."lifetimeEarnedPoints", a."lifetimeSpentPoints", a."lifetimeRefundedPoints",
       COALESCE(x.earned,0) AS calc_earned,
       COALESCE(x.spent,0)  AS calc_spent,
       COALESCE(x.refunded,0) AS calc_refunded
FROM "UserPointAccount" a
LEFT JOIN (
  SELECT
    "userId",
    SUM(CASE WHEN "reason" IN ('QR_SCAN','BONUS','REFERRAL') AND "points" > 0 THEN "points" ELSE 0 END) AS earned,
    ABS(SUM(CASE WHEN "reason" = 'SHOPIFY_REWARD_REDEMPTION' AND "points" < 0 THEN "points" ELSE 0 END)) AS spent,
    SUM(CASE WHEN "reason" = 'SHOPIFY_REWARD_REFUND' AND "points" > 0 THEN "points" ELSE 0 END) AS refunded
  FROM "PointTransaction"
  GROUP BY "userId"
) x ON x."userId" = a."userId"
WHERE a."lifetimeEarnedPoints"   <> COALESCE(x.earned,0)
   OR a."lifetimeSpentPoints"    <> COALESCE(x.spent,0)
   OR a."lifetimeRefundedPoints" <> COALESCE(x.refunded,0);

-- 3d. No transaction rows should be left without metadata.
SELECT count(*) AS rows_missing_sourceType
FROM "PointTransaction"
WHERE "sourceType" IS NULL;

-- 3e. type vs reason mapping sanity (MUST return zero rows).
SELECT "reason", "type", count(*)
FROM "PointTransaction"
WHERE ("reason" IN ('QR_SCAN','BONUS','REFERRAL')       AND "type" <> 'EARN')
   OR ("reason" = 'SHOPIFY_REWARD_REDEMPTION'           AND "type" <> 'SPEND')
   OR ("reason" = 'SHOPIFY_REWARD_REFUND'               AND "type" <> 'REFUND')
GROUP BY "reason", "type";

-- ---------------------------------------------------------------------------
-- If 3b, 3c, 3e returned ZERO rows and 3a/3d look right:
--     COMMIT;
-- Otherwise:
--     ROLLBACK;
-- ---------------------------------------------------------------------------
COMMIT;
