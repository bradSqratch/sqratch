-- Shopify store-relink reward/product-link compatibility.
--
-- Additive migration except for one deliberate data change: every existing
-- BrandRewardOffer row is set isActive = false (see "DataMigration" section
-- below). Existing reward rows predate store-compatibility tracking and must
-- be manually reviewed by each Brand Admin before being reactivated — this
-- prevents a currency- or product-mismatched offer (e.g. a USD fixed reward
-- left over from a prior store) from staying live against a newly connected
-- store with a different currency.
--
-- No monetary amounts, currencies, titles, descriptions, point costs,
-- redemption rows, point transactions, users, campaigns, experiences, or
-- product GIDs are modified. No DELETE, TRUNCATE, DROP TABLE, DROP COLUMN,
-- or CASCADE statements appear in this migration.

-- CreateEnum
CREATE TYPE "ShopifyConnectionEventType" AS ENUM ('CONNECTED', 'RECONNECTED', 'RELINKED', 'DISCONNECTED', 'UNINSTALLED', 'REQUIRES_RECONNECT');

-- CreateTable
CREATE TABLE "ShopifyConnectionEvent" (
    "id" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "eventType" "ShopifyConnectionEventType" NOT NULL,
    "shopDomain" TEXT,
    "previousShopDomain" TEXT,
    "currencyCode" TEXT,
    "previousCurrencyCode" TEXT,
    "shopifyClientId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyConnectionEvent_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "BrandRewardOffer" ADD COLUMN     "sourceShopDomain" TEXT;

-- AlterTable
ALTER TABLE "ExperienceProductLink" ADD COLUMN     "sourceShopDomain" TEXT;

-- AlterTable
ALTER TABLE "LessonProductLink" ADD COLUMN     "sourceShopDomain" TEXT;

-- CreateIndex
CREATE INDEX "ShopifyConnectionEvent_brandId_createdAt_idx" ON "ShopifyConnectionEvent"("brandId", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifyConnectionEvent_shopDomain_createdAt_idx" ON "ShopifyConnectionEvent"("shopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "ShopifyConnectionEvent_previousShopDomain_createdAt_idx" ON "ShopifyConnectionEvent"("previousShopDomain", "createdAt");

-- CreateIndex
CREATE INDEX "BrandRewardOffer_brandId_sourceShopDomain_idx" ON "BrandRewardOffer"("brandId", "sourceShopDomain");

-- CreateIndex
CREATE INDEX "ExperienceProductLink_experienceId_sourceShopDomain_idx" ON "ExperienceProductLink"("experienceId", "sourceShopDomain");

-- CreateIndex
CREATE INDEX "ExperienceProductLink_brandId_sourceShopDomain_idx" ON "ExperienceProductLink"("brandId", "sourceShopDomain");

-- CreateIndex
CREATE INDEX "LessonProductLink_lessonId_sourceShopDomain_idx" ON "LessonProductLink"("lessonId", "sourceShopDomain");

-- CreateIndex
CREATE INDEX "LessonProductLink_brandId_sourceShopDomain_idx" ON "LessonProductLink"("brandId", "sourceShopDomain");

-- AddForeignKey
ALTER TABLE "ShopifyConnectionEvent" ADD CONSTRAINT "ShopifyConnectionEvent_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- DataMigration
--
-- (1) Deliberate deactivation: every existing reward offer predates store-
-- compatibility tracking, so none of them have a known sourceShopDomain or a
-- currency that's been validated against the currently connected store. Force
-- them all inactive; a Brand Admin must review and explicitly reactivate each
-- one from the dashboard once compatibility is confirmed. This does not touch
-- discountAmountCents, discountPercentageBasisPoints, currencyCode, title,
-- description, pointsCost, or any product row.
UPDATE "BrandRewardOffer" SET "isActive" = false;

-- (2) Deterministic sourceShopDomain backfill for LessonProductLink: only when
-- productUrl's hostname is a syntactically valid *.myshopify.com shop domain
-- (same pattern as src/lib/shopify.ts's isValidShopDomain). Never inferred
-- from the Brand's current Shopify domain, since the stored product may
-- belong to a previous store. Hostname is extracted from the scheme://host
-- prefix of the trimmed, lowercased URL; anything that doesn't match is left
-- NULL (requires-relinking state, handled by application code).
WITH extracted AS (
    SELECT
        "id",
        substring(lower(trim("productUrl")) from '^[a-z]+://([^/:?#]+)') AS host
    FROM "LessonProductLink"
)
UPDATE "LessonProductLink" l
SET "sourceShopDomain" = e.host
FROM extracted e
WHERE l."id" = e."id"
  AND e.host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.myshopify\.com$';

-- (3) Same deterministic backfill for ExperienceProductLink.
WITH extracted AS (
    SELECT
        "id",
        substring(lower(trim("productUrl")) from '^[a-z]+://([^/:?#]+)') AS host
    FROM "ExperienceProductLink"
)
UPDATE "ExperienceProductLink" l
SET "sourceShopDomain" = e.host
FROM extracted e
WHERE l."id" = e."id"
  AND e.host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.myshopify\.com$';

-- (4) Deterministic sourceShopDomain backfill for BrandRewardOffer, derived
-- from its selected BrandRewardOfferProduct rows: only backfilled when the
-- offer has at least one selected product, every selected product's
-- productUrl resolves to a valid myshopify.com hostname, and all of them
-- resolve to the exact same domain. Offers with zero selected products (e.g.
-- ALL_PRODUCTS offers), missing/invalid URLs, or products spanning more than
-- one domain are left NULL rather than guessed at.
WITH product_hosts AS (
    SELECT
        p."offerId" AS offer_id,
        (p."productUrl" IS NOT NULL) AS has_url,
        substring(lower(trim(p."productUrl")) from '^[a-z]+://([^/:?#]+)') AS host
    FROM "BrandRewardOfferProduct" p
),
offer_domain_stats AS (
    SELECT
        offer_id,
        count(*) AS total_products,
        count(*) FILTER (
            WHERE has_url AND host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.myshopify\.com$'
        ) AS valid_products,
        count(DISTINCT host) FILTER (
            WHERE has_url AND host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.myshopify\.com$'
        ) AS distinct_valid_domains,
        max(host) FILTER (
            WHERE has_url AND host ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.myshopify\.com$'
        ) AS the_domain
    FROM product_hosts
    GROUP BY offer_id
)
UPDATE "BrandRewardOffer" o
SET "sourceShopDomain" = s.the_domain
FROM offer_domain_stats s
WHERE o."id" = s.offer_id
  AND s.total_products > 0
  AND s.total_products = s.valid_products
  AND s.distinct_valid_domains = 1;
