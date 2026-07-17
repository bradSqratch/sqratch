# Prisma Migration Runbook

Do not run `migrate dev` against production.

## Current status (resolved)

The four hardening migrations below have been **successfully applied** to production. `npx prisma migrate status` reports **"Database schema is up to date!"** and the schema↔database diff is empty. The earlier migration-history divergence is **resolved** and is no longer an active deployment blocker. The notes below are retained as reference for future deploys of equivalent migrations.

## Hardening migrations (applied, in order)

1. `20260615113320_campaign_unlock_anon_unique`: additive partial unique index. Preflight duplicate anonymous unlocks; index creation can briefly lock writes.
2. `20260615120000_shopify_expiring_tokens`: additive enum value, enum type, and token lifecycle columns, including refresh lease ownership. Enum additions are not trivially reversible.
3. `20260615140000_redemption_reconciliation`: additive reconciliation columns/index plus an exactly-once point-ledger unique index. Preflight duplicate `(shopifyRewardRedemptionId, reason)` rows.
4. `20260615150000_evidence_based_indexes`: additive query indexes. Check `pg_indexes` for equivalent indexes first.

## Preflight

```sql
SELECT "campaignId", "anonKey", count(*)
FROM "CampaignUnlock"
WHERE "anonKey" IS NOT NULL AND "userId" IS NULL
GROUP BY 1, 2 HAVING count(*) > 1;

SELECT "shopifyRewardRedemptionId", "reason", count(*)
FROM "PointTransaction"
WHERE "shopifyRewardRedemptionId" IS NOT NULL
GROUP BY 1, 2 HAVING count(*) > 1;

SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('CampaignUnlock','ShopifyRewardRedemption','PointTransaction','EmailVerificationToken','TokenStore');
```

Also inspect `information_schema.columns` and `pg_type` for equivalent manually created token/reconciliation fields and enums.

## Deployment

The local migrations `20260716120000_harden_auth_sessions_and_verification`, `20260716130000_remove_external_role`, and `20260716131000_verified_user_welcome_queue` have not been applied to any remote database. Review the legacy challenge invalidation effect and configure `EMAIL_VERIFICATION_CODE_PEPPER` before applying them through the normal release process.

Before `20260716130000_remove_external_role`, confirm no users retain the retired role. The migration repeats this check and aborts if one appears. It replaces the PostgreSQL `Role` enum without changing users. The welcome-queue migration removes only `trg_enqueue_welcome_email` and `enqueue_welcome_email()`, adds the verification challenge eligibility marker and `SKIPPED` queue status, and intentionally leaves the separate Make.com user-insert trigger unchanged.

The production-only `Make com ` trigger was reported as an `AFTER INSERT` trigger on `User` that calls an external Make.com webhook. Its function body is not version-controlled in this repository, so it cannot be inspected without querying the remote database. It is separate from `trg_enqueue_welcome_email` and is deliberately not modified by these migrations.

Back up first, pause reward issuance briefly, run reviewed preflight SQL, then run `npx prisma migrate deploy` once from a controlled release job. Validate schema, token refresh, QR unlock deduplication, redemption/refund, and query plans afterward.

Rollback is manual: indexes and additive columns can be dropped after application rollback, but enum values are not safely removed in place. Never delete point or redemption history.
