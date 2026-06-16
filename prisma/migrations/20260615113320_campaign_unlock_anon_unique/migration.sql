-- Migration: 20260615113320_campaign_unlock_anon_unique
--
-- Adds a partial unique index on CampaignUnlock(campaignId, anonKey) scoped to
-- anonymous-only rows (anonKey IS NOT NULL AND userId IS NULL).
--
-- IMPORTANT: Prisma cannot express partial unique indexes in schema.prisma.
-- This index exists in the DB only — the intentional schema/DB drift is by design.
-- Do NOT add a @@unique([campaignId, anonKey]) to schema.prisma; doing so would
-- create a non-partial unique across ALL rows, which would prevent a campaign from
-- having both an anon unlock and a user unlock for the same campaignId (broken).
--
-- ─── PREFLIGHT ───────────────────────────────────────────────────────────────
-- Run this query BEFORE applying and confirm it returns ZERO rows.
-- If it returns any rows, deduplicate manually (do NOT auto-delete).
--
-- SELECT "campaignId", "anonKey", count(*)
-- FROM "CampaignUnlock"
-- WHERE "anonKey" IS NOT NULL AND "userId" IS NULL
-- GROUP BY 1, 2
-- HAVING count(*) > 1;
--
-- ─────────────────────────────────────────────────────────────────────────────

CREATE UNIQUE INDEX "CampaignUnlock_campaignId_anonKey_key"
  ON "CampaignUnlock"("campaignId", "anonKey")
  WHERE "anonKey" IS NOT NULL AND "userId" IS NULL;

-- ─── ROLLBACK ─────────────────────────────────────────────────────────────────
-- DROP INDEX "CampaignUnlock_campaignId_anonKey_key";
