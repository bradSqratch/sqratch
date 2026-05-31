CREATE TYPE "ShopifyConnectionStatus" AS ENUM ('DISCONNECTED', 'CONNECTED', 'UNINSTALLED');

ALTER TABLE "Brand"
ADD COLUMN "shopifyDisconnectedAt" TIMESTAMP(3),
ADD COLUMN "shopifyUninstalledAt" TIMESTAMP(3),
ADD COLUMN "shopifyConnectionStatus" "ShopifyConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED';

UPDATE "Brand"
SET "shopifyConnectionStatus" = 'CONNECTED'
WHERE "shopifyShopDomain" IS NOT NULL
  AND "shopifyAdminAccessTokenEncrypted" IS NOT NULL;
