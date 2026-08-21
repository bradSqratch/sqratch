-- Phase 15B: preserve Shopify lifecycle-history rows while making the model
-- provider-neutral. PostgreSQL renames retain every row, timestamp, FK, and
-- index; the added provider value is deterministically SHOPIFY for all
-- historical rows because this table was Shopify-only before this migration.

ALTER TYPE "ShopifyConnectionEventType" RENAME TO "CommerceConnectionEventType";

ALTER TABLE "ShopifyConnectionEvent" RENAME TO "CommerceConnectionEvent";
ALTER TABLE "CommerceConnectionEvent"
  RENAME CONSTRAINT "ShopifyConnectionEvent_pkey" TO "CommerceConnectionEvent_pkey";
ALTER TABLE "CommerceConnectionEvent"
  RENAME CONSTRAINT "ShopifyConnectionEvent_brandId_fkey" TO "CommerceConnectionEvent_brandId_fkey";

ALTER TABLE "CommerceConnectionEvent" RENAME COLUMN "shopDomain" TO "externalAccountId";
ALTER TABLE "CommerceConnectionEvent"
  RENAME COLUMN "previousShopDomain" TO "previousExternalAccountId";
ALTER TABLE "CommerceConnectionEvent" RENAME COLUMN "shopifyClientId" TO "providerClientId";

ALTER INDEX "ShopifyConnectionEvent_brandId_createdAt_idx"
  RENAME TO "CommerceConnectionEvent_brandId_createdAt_idx";
ALTER INDEX "ShopifyConnectionEvent_shopDomain_createdAt_idx"
  RENAME TO "CommerceConnectionEvent_externalAccountId_createdAt_idx";
ALTER INDEX "ShopifyConnectionEvent_previousShopDomain_createdAt_idx"
  RENAME TO "CommerceConnectionEvent_previousExternalAccountId_createdAt_idx";

ALTER TABLE "CommerceConnectionEvent"
  ADD COLUMN "provider" "CommerceProvider" NOT NULL DEFAULT 'SHOPIFY';
ALTER TABLE "CommerceConnectionEvent" ALTER COLUMN "provider" DROP DEFAULT;
