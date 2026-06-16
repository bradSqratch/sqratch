-- PREFLIGHT: verify no conflicting indexes exist
-- SELECT indexname FROM pg_indexes WHERE tablename = 'ShopifyRewardRedemption' AND indexname LIKE '%offerId%';
-- SELECT indexname FROM pg_indexes WHERE tablename = 'EmailVerificationToken' AND indexname LIKE '%userId%';
-- SELECT indexname FROM pg_indexes WHERE tablename = 'TokenStore' AND indexname LIKE '%expiresAt%';

-- ROLLBACK:
-- DROP INDEX IF EXISTS "ShopifyRewardRedemption_offerId_status_idx";
-- DROP INDEX IF EXISTS "ShopifyRewardRedemption_offerId_userId_status_idx";
-- DROP INDEX IF EXISTS "EmailVerificationToken_userId_idx";
-- DROP INDEX IF EXISTS "TokenStore_expiresAt_idx";

-- Batch 8: evidence-based indexes
-- Applied after: 20260615140000_redemption_reconciliation

-- ShopifyRewardRedemption: composite for global offer cap queries
-- Covers: COUNT WHERE offerId = ? AND status IN (...)
CREATE INDEX "ShopifyRewardRedemption_offerId_status_idx"
  ON "ShopifyRewardRedemption"("offerId", "status");

-- ShopifyRewardRedemption: composite for per-user offer cap queries
-- Covers: COUNT WHERE offerId = ? AND userId = ? AND status IN (...)
CREATE INDEX "ShopifyRewardRedemption_offerId_userId_status_idx"
  ON "ShopifyRewardRedemption"("offerId", "userId", "status");

-- EmailVerificationToken: user-based token lookup/cleanup
-- Covers: SELECT/DELETE WHERE userId = ?
CREATE INDEX "EmailVerificationToken_userId_idx"
  ON "EmailVerificationToken"("userId");

-- TokenStore: expiry-based cleanup
-- Covers: SELECT/DELETE WHERE expiresAt <= NOW()
CREATE INDEX "TokenStore_expiresAt_idx"
  ON "TokenStore"("expiresAt");
