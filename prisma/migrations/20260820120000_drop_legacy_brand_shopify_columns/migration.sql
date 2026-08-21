-- PHASE 14C-B2 — PHYSICAL REMOVAL OF LEGACY Brand.shopify* CONNECTION STATE
--
-- IRREVERSIBLE. This migration DROPs 16 columns and 2 enum types. There is no
-- down migration; restoring them would require a restore from backup.
--
-- WHY THIS IS SAFE TO RUN:
--   These 16 columns were the pre-canonical duplicate of Shopify connection and
--   credential state. Runtime authority has already moved entirely to
--   Brand -> CommerceConnection -> CommerceConnectionSecret -> provider adapter.
--   Phases 14C-A / 14C-B1 / 14C-B1.1 removed every read, write, fallback and
--   mirror path; no application code references any of these columns any more.
--
--   NO BACKFILL IS REQUIRED. The operator independently verified against the
--   live database immediately before this migration that:
--     * 0 CONNECTED/REQUIRES_RECONNECT Shopify connections lack a canonical
--       CommerceConnectionSecret;
--     * 0 DISCONNECTED/UNINSTALLED Shopify connections retain a secret;
--     * 0 stranded refresh leases;
--     * every actually-installed Shopify merchant has both a
--       CommerceConnection(provider=SHOPIFY) and a CommerceConnectionSecret;
--     * unconnected Brands simply have no Shopify CommerceConnection.
--   Every value being dropped is therefore either already represented
--   canonically or belongs to a brand with no live connection.
--
-- NO ROWS ARE DELETED OR MUTATED. Every statement is DDL. No Brand row, and no
-- row in any other table, is removed or rewritten by this migration.
--
-- SCOPE: only "Brand" is altered. No canonical commerce table
-- (CommerceConnection, CommerceConnectionSecret), no provider-specific history
-- table (ShopifyConnectionEvent, ShopifyRewardRedemption), no reward ledger
-- (PointTransaction, BrandRewardOffer, BrandRewardOfferProduct) and no
-- Campaign/attribution table is touched.
--
-- ORDERING: the enum-backed columns ("shopifyConnectionStatus",
-- "shopifyAuthMode") are dropped BEFORE their enum types, because PostgreSQL
-- refuses to DROP TYPE while a column still depends on it. The array types
-- ("_ShopifyConnectionStatus", "_ShopifyAuthMode") are dropped implicitly by
-- PostgreSQL together with their base types and must NOT be dropped manually.
--
-- LOCKING: DROP COLUMN is metadata-only in PostgreSQL — it does not rewrite the
-- table heap. It takes a brief ACCESS EXCLUSIVE lock on "Brand"; there is no
-- long table rewrite.

-- DropIndex
DROP INDEX "Brand_shopifyShopDomain_key";

-- AlterTable
ALTER TABLE "Brand" DROP COLUMN "shopifyAccessTokenExpiresAt",
DROP COLUMN "shopifyAdminAccessTokenEncrypted",
DROP COLUMN "shopifyAuthMode",
DROP COLUMN "shopifyClientId",
DROP COLUMN "shopifyConnectionStatus",
DROP COLUMN "shopifyCurrencyCode",
DROP COLUMN "shopifyDisconnectedAt",
DROP COLUMN "shopifyGrantedScopes",
DROP COLUMN "shopifyInstalledAt",
DROP COLUMN "shopifyLastProductSyncAt",
DROP COLUMN "shopifyRefreshTokenEncrypted",
DROP COLUMN "shopifyRefreshTokenExpiresAt",
DROP COLUMN "shopifyShopDomain",
DROP COLUMN "shopifyTokenRefreshLockId",
DROP COLUMN "shopifyTokenRefreshLockedUntil",
DROP COLUMN "shopifyUninstalledAt";

-- DropEnum
DROP TYPE "ShopifyConnectionStatus";

-- DropEnum
DROP TYPE "ShopifyAuthMode";
