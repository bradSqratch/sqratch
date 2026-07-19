# Prisma Migration Runbook

Do not run `migrate dev` against production.

## How to determine migration status (read this before trusting any table below)

Local migration folders under `prisma/migrations/` are **immutable historical records** of what has been authored — they are not, by themselves, evidence of what has been applied to any particular database. This repository has had **historical divergence between local migration folders and the production `_prisma_migrations` table** before (see "Historical divergence" below), and migrations can in principle reach a database by paths other than a plain sequential `migrate deploy` (e.g. `migrate resolve` marking a migration as applied without running it, or a manually-applied equivalent SQL change) — so do **not** infer that every earlier local migration was applied merely because a later one was confirmed applied. A later migration being live does not by itself prove every predecessor ran the way its folder describes.

Before relying on migration state for anything (writing a new migration, planning a deploy, debugging a schema mismatch), explicitly verify it:

```bash
npx prisma migrate status   # compares _prisma_migrations against local migration folders
npx prisma migrate diff \
  --from-config-datasource prisma.config.ts \
  --to-schema prisma/schema.prisma \
  --script                    # compares live schema against schema.prisma; empty output = no drift
```

Never repair migration history casually (e.g. `migrate resolve --applied` to make a discrepancy go away) without first understanding *why* local history and the database disagree — see "Historical divergence" below.

## Verified production state

**Every migration currently represented by a local migration folder, through `20260719061157_remove_legacy_user_points`, has been applied to production.** This was independently verified, not assumed:

- **Before** the `20260719061157_remove_legacy_user_points` deployment, `npx prisma migrate status` identified that migration as the *only* local migration not yet applied to production — i.e. every other local migration folder (the full hardening set and everything authored after it, through `20260718120000_shopify_store_reward_compatibility`) was already confirmed applied at that point.
- `20260719061157_remove_legacy_user_points` was then applied on 2026-07-19.
- **After** deployment, `npx prisma migrate status` reported the production schema up to date.
- `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` returned an empty migration (no drift between the live database and `prisma/schema.prisma`).
- The `User.points` column no longer exists in the production database.
- `UserPointAccount` and `PointTransaction` row/column data were confirmed unchanged by the migration (it is a single `ALTER TABLE ... DROP COLUMN`).

See `docs/points-ledger.md` for the full reconciliation record and deployment procedure that preceded the last migration. For any migration authored *after* `20260719061157_remove_legacy_user_points`, run the verification commands above rather than relying on this document's age.

## Historical divergence

Production's `_prisma_migrations` table also contains migration records that have **no corresponding local folder in this repository** — additional historical entries predating what this checkout's `prisma/migrations/` directory represents. This is the migration-history divergence for this repository: not missing/unapplied local migrations (see "Verified production state" above — there are none, as of 2026-07-19), but production carrying history the repository does not.

**This must not be casually repaired or reconstructed.** Do not fabricate local migration folders to "backfill" those unrepresented production records, do not delete or edit rows in production's `_prisma_migrations` table, and do not assume the missing folders are safe to ignore. Whenever local migration folders and production's tracking table disagree in either direction, verify explicitly before taking any action: compare `_prisma_migrations` directly, compare `migrate status` / `migrate diff` output, and (if genuinely uncertain) inspect `information_schema` for the schema objects a given record would have created.

## Hardening migrations (confirmed applied — see "Verified production state" above)

The four migrations below were confirmed applied to production by the `prisma migrate status` check that preceded the `20260719061157_remove_legacy_user_points` deployment (see above). If depending on this for a change today, re-run the verification commands to confirm nothing has changed since.

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

## Migrations authored after the hardening set (confirmed applied — see "Verified production state" above)

The local migrations `20260716120000_harden_auth_sessions_and_verification`, `20260716130000_remove_external_role`, `20260716131000_verified_user_welcome_queue`, `20260717140000_welcome_email_worker_retries`, and `20260718120000_shopify_store_reward_compatibility` all predate `20260719061157_remove_legacy_user_points` in the local migration order, and were confirmed applied to production by the same pre-deployment `prisma migrate status` check described above (which identified `20260719061157_remove_legacy_user_points` as the only local migration not yet applied at that time). If depending on this for a change today, re-run `npx prisma migrate status` to confirm nothing has changed since this was last checked.

For `20260716130000_remove_external_role`: this migration confirms no users retain the retired role, aborting if one appears, before replacing the PostgreSQL `Role` enum without changing users. The welcome-queue migration removes only `trg_enqueue_welcome_email` and `enqueue_welcome_email()`, adds the verification challenge eligibility marker and `SKIPPED` queue status, and intentionally leaves the separate Make.com user-insert trigger unchanged.

`20260717140000_welcome_email_worker_retries` is additive only: nullable retry-scheduling and claim timestamps plus worker-selection indexes. Existing `PENDING` jobs remain immediately eligible, while `SENT`, `SKIPPED`, `FAILED`, and `SENDING` rows are not rewritten by the migration.

`20260716120000_harden_auth_sessions_and_verification` required `EMAIL_VERIFICATION_CODE_PEPPER` to be configured and the legacy challenge invalidation effect reviewed before it was applied; both apply to any other environment this migration is deployed to that has not yet had it applied.

The production-only `Make com ` trigger was reported as an `AFTER INSERT` trigger on `User` that calls an external Make.com webhook. Its function body is not version-controlled in this repository, so it cannot be inspected without querying the remote database. It is separate from `trg_enqueue_welcome_email` and is deliberately not modified by any migration in this repository.

## Deployment procedure

Back up first, pause reward issuance briefly, run reviewed preflight SQL, then run `npx prisma migrate deploy` once from a controlled release job. Immediately after, run `npx prisma migrate status` and `npx prisma migrate diff` to confirm the expected state (do not assume success from the deploy command's exit code alone). Validate schema, token refresh, QR unlock deduplication, redemption/refund, and query plans afterward.

Existing migration folders under `prisma/migrations/` must never be edited after being merged — they are immutable historical records. A mistake in an already-applied migration is corrected with a new, forward-only migration, never by rewriting history.

## Rollback

Rollback is manual: indexes and additive columns can be dropped after application rollback, but enum values are not safely removed in place. Never delete point or redemption history.
