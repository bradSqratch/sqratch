-- Migration: 20260806120000_add_commerce_connection_abstraction
--
-- Adds a provider-neutral commerce connection abstraction (CommerceConnection /
-- CommerceConnectionSecret) alongside the existing Shopify-specific columns on
-- Brand. This migration is purely additive: it creates two new enums, two new
-- tables, their indexes, and their foreign keys. It does not touch any existing
-- table, column, or enum, and no existing data is read or written.
--
-- Existing Shopify state (Brand.shopifyShopDomain, shopifyConnectionStatus,
-- shopifyAuthMode, etc.) is left completely untouched by this migration.
-- Backfilling CommerceConnection/CommerceConnectionSecret rows from that
-- existing state is out of scope here and is handled by a later migration.
--
-- CommerceConnectionSecret stores one encrypted JSON payload per connection
-- (encryptedPayload) rather than individual plaintext/encrypted token columns,
-- so the shape of provider credentials (offline token, refresh token, expiry,
-- etc.) can evolve without further schema changes.

-- CreateEnum
CREATE TYPE "CommerceProvider" AS ENUM ('SHOPIFY', 'COMMERCE7');

-- CreateEnum
CREATE TYPE "CommerceConnectionStatus" AS ENUM ('PENDING', 'CONNECTED', 'REQUIRES_RECONNECT', 'DISCONNECTED', 'UNINSTALLED', 'ERROR');

-- CreateTable
CREATE TABLE "CommerceConnection" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "provider" "CommerceProvider" NOT NULL,
    "status" "CommerceConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "displayName" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "storefrontUrl" TEXT,
    "providerClientId" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "grantedScopes" JSONB,
    "providerMetadata" JSONB,
    "installedAt" TIMESTAMP(3),
    "uninstalledAt" TIMESTAMP(3),
    "lastProductSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceConnectionSecret" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "encryptedPayload" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "rotatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceConnectionSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommerceConnection_brandId_idx" ON "CommerceConnection"("brandId");

-- CreateIndex
CREATE INDEX "CommerceConnection_brandId_provider_idx" ON "CommerceConnection"("brandId", "provider");

-- CreateIndex
CREATE INDEX "CommerceConnection_brandId_isPrimary_idx" ON "CommerceConnection"("brandId", "isPrimary");

-- CreateIndex
CREATE INDEX "CommerceConnection_provider_status_idx" ON "CommerceConnection"("provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceConnection_provider_externalAccountId_key" ON "CommerceConnection"("provider", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceConnectionSecret_connectionId_key" ON "CommerceConnectionSecret"("connectionId");

-- AddForeignKey
ALTER TABLE "CommerceConnection" ADD CONSTRAINT "CommerceConnection_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceConnectionSecret" ADD CONSTRAINT "CommerceConnectionSecret_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CommerceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── ROLLBACK ─────────────────────────────────────────────────────────────────
-- DROP TABLE "CommerceConnectionSecret";
-- DROP TABLE "CommerceConnection";
-- DROP TYPE "CommerceConnectionStatus";
-- DROP TYPE "CommerceProvider";
-- Only safe if no application code has written rows into either table yet.
-- If any CommerceConnection/CommerceConnectionSecret rows exist (e.g. from a
-- later dual-write backfill), dropping the tables loses that data permanently.
