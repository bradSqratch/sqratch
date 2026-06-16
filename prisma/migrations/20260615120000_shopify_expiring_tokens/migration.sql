-- CreateEnum
CREATE TYPE "ShopifyAuthMode" AS ENUM ('LEGACY_OFFLINE', 'EXPIRING_OFFLINE');

-- AlterEnum
ALTER TYPE "ShopifyConnectionStatus" ADD VALUE 'REQUIRES_RECONNECT';

-- AlterTable
ALTER TABLE "Brand" ADD COLUMN     "shopifyAccessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "shopifyAuthMode" "ShopifyAuthMode" NOT NULL DEFAULT 'LEGACY_OFFLINE',
ADD COLUMN     "shopifyClientId" TEXT,
ADD COLUMN     "shopifyGrantedScopes" TEXT,
ADD COLUMN     "shopifyRefreshTokenEncrypted" TEXT,
ADD COLUMN     "shopifyRefreshTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "shopifyTokenRefreshLockId" TEXT,
ADD COLUMN     "shopifyTokenRefreshLockedUntil" TIMESTAMP(3);
