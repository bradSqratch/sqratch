-- PHASE 16B — COMMERCE7 INSTALLATION + ADMIN EXTENSION ACCOUNT LINKING
--
-- PURELY ADDITIVE. This migration creates two new tables and one new enum type.
-- It contains NO ALTER TABLE against any existing table, NO DROP of anything,
-- and NO data statement (no INSERT/UPDATE/DELETE). Nothing that exists today is
-- read, rewritten, or removed.
--
-- EXPLICITLY NOT MODIFIED: PointTransaction, UserPointAccount, any Shopify
-- reward physical mapping, CommerceConnection, CommerceConnectionEvent,
-- CommerceConnectionSecret, Brand, and every Campaign/attribution table.
--
-- WHY THESE TABLES EXIST:
--   A Commerce7 merchant installs the SQRATCH app on their own tenant BEFORE
--   SQRATCH knows which Brand owns that tenant. CommerceProviderInstallation
--   records that pre-link state. It deliberately has NO brandId: Brand
--   ownership authority remains solely on CommerceConnection.
--
--   CommerceConnectionLinkIntent is a short-lived, single-use handoff from the
--   authenticated Commerce7 Admin Extension to an authenticated SQRATCH Brand
--   Admin. It stores only a SHA-256 digest of the raw token — never the token
--   itself, never a provider credential, and never a Commerce7 account JWT.
--
-- NO CREDENTIAL MATERIAL IS STORED BY EITHER TABLE. The Commerce7 App Secret is
-- app-global and is supplied through backend environment configuration only.
--
-- LOCKING: CREATE TABLE / CREATE INDEX on brand-new empty tables is effectively
-- instant and takes no lock on any existing table.

-- CreateEnum
CREATE TYPE "CommerceInstallationStatus" AS ENUM ('INSTALLED', 'UNINSTALLED');

-- CreateTable
CREATE TABLE "CommerceProviderInstallation" (
    "id" TEXT NOT NULL,
    "provider" "CommerceProvider" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "status" "CommerceInstallationStatus" NOT NULL DEFAULT 'INSTALLED',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommerceProviderInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceConnectionLinkIntent" (
    "id" TEXT NOT NULL,
    "installationId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceConnectionLinkIntent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CommerceProviderInstallation_provider_status_idx" ON "CommerceProviderInstallation"("provider", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceProviderInstallation_provider_externalAccountId_key" ON "CommerceProviderInstallation"("provider", "externalAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceConnectionLinkIntent_tokenHash_key" ON "CommerceConnectionLinkIntent"("tokenHash");

-- CreateIndex
CREATE INDEX "CommerceConnectionLinkIntent_installationId_consumedAt_idx" ON "CommerceConnectionLinkIntent"("installationId", "consumedAt");

-- CreateIndex
CREATE INDEX "CommerceConnectionLinkIntent_expiresAt_idx" ON "CommerceConnectionLinkIntent"("expiresAt");

-- AddForeignKey
ALTER TABLE "CommerceConnectionLinkIntent" ADD CONSTRAINT "CommerceConnectionLinkIntent_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "CommerceProviderInstallation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

