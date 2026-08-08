-- Migration: 20260807180000_add_commerce_order_normalization
--
-- Phase 7's provider-neutral ORDER NORMALIZATION foundation. This migration is
-- additive and forward-only: it adds three enum types, three tables, their
-- indexes, and their foreign keys. It contains no UPDATE, DELETE, TRUNCATE,
-- dropped object, altered column, altered type, or renamed object. No
-- pre-existing table, column, index, or constraint is modified in any way, so
-- there is nothing to back-fill and every existing Brand, CommerceConnection,
-- ConnectedCommerceProduct, CommerceClickAttribution, ShopifyRewardRedemption,
-- PointTransaction and UserPointAccount row is untouched and keeps behaving
-- exactly as before.
--
-- THIS SCHEMA IS NOT REACHABLE IN PRODUCTION TODAY
-- ------------------------------------------------
-- Nothing writes to these tables yet, and applying this migration changes no
-- runtime behavior. SQRATCH's Shopify app holds read_products, read_discounts
-- and write_discounts. It does NOT hold read_orders, and neither
-- shopify.app.toml nor shopify.app.custom.toml subscribes to any orders/* or
-- refunds/* webhook topic. Shopify therefore never sends an order payload, and
-- the three route handlers added alongside this migration
-- (src/app/api/shopify/webhooks/orders/create, .../orders/updated,
-- .../refunds/create) can only ever be exercised by a fixture. Enabling them is
-- a deliberate, separately-reviewed rollout with its own scope-change and
-- privacy-policy prerequisites, documented in
-- docs/commerce/phase-7-order-normalization-summary.md. This migration MUST NOT
-- be described as turning on order tracking.
--
-- WHY THESE TABLES EXIST
-- ----------------------
-- Phase 6 recorded evidence that a click happened (CommerceClickAttribution)
-- and was explicit that whether a purchase followed is not knowable there.
-- These tables are the other half: a provider-neutral, normalized record of
-- what a merchant ORDER actually was, so that revenue reporting is never
-- derived from a raw, provider-shaped payload scattered through the codebase.
-- Exactly one module writes them: src/lib/commerce/order-ingestion.ts.
--
-- NO CUSTOMER PII, BY CONSTRUCTION
-- --------------------------------
-- There is deliberately no email, name, phone, address, customer id, or IP
-- column on any table below. The Shopify normalizer actively skips the
-- customer / billing_address / shipping_address / email / phone keys of the
-- payload and cannot return them. "payloadDigest" is a SHA-256 hex digest of
-- the raw HMAC-verified body — it proves WHICH bytes were processed without
-- storing any of them, and is one-way. Phase 7 is order/revenue normalization,
-- not customer profiling.
--
-- NO POINTS, NO COMMISSION
-- ------------------------
-- These tables record what an order was. They never award points and never
-- compute a commission. PointTransaction, UserPointAccount, BrandRewardOffer
-- and ShopifyRewardRedemption are entirely untouched by this migration and by
-- the code that writes these tables.
--
-- MONEY COLUMNS ARE BIGINT, NOT INTEGER
-- -------------------------------------
-- ConnectedCommerceProduct.priceMinMinor / priceMaxMinor are INTEGER (see
-- 20260806140000_add_commerce_product_catalog) because a single product price
-- comfortably fits int4 (max 2,147,483,647 minor units, about $21.4M at
-- exponent 2). An ORDER TOTAL carries no such guarantee: a wholesale or B2B
-- order, or any 0-exponent currency (JPY, KRW, VND, CLP), can exceed int4
-- outright, and overflowing raises Postgres 22003 at write time and loses the
-- order. Every money column here is therefore BIGINT.
--
-- KNOWN LIMITATION, recorded rather than worked around: the shared converter
-- decimalStringToMinorUnits (src/lib/commerce/money.ts) still enforces the int4
-- range because it was written for the INTEGER catalog columns. So although
-- these COLUMNS accept 64-bit values, today's ingestion path rejects any single
-- amount outside int4 with a typed OUT_OF_RANGE result, which nulls that one
-- field and never fails the order. The wider column type is precisely what
-- makes relaxing that helper a code-only change later, with no second
-- migration.
--
-- "totalMinor" is always the provider's OWN reported total, persisted verbatim.
-- It is never computed by summing converted line items: the converter truncates
-- rather than rounds, so a sum of per-line conversions can legitimately
-- disagree with the provider's total by a few minor units.
-- "netRevenueMinor" is the single derived column (totalMinor -
-- totalRefundedMinor), computed at write time by the ingestion service.
-- "totalRefundedMinor" is CUMULATIVE as of the latest refund event, never an
-- incremental delta — that is what makes a replayed refund webhook idempotent.
--
-- IDENTITY IS SCOPED TO THE CONNECTION
-- ------------------------------------
-- CommerceOrder_connectionId_externalOrderId_key, never a bare unique on
-- externalOrderId: two different stores can theoretically mint the same
-- provider order id, and the schema must not assume otherwise. This is the same
-- rule as ConnectedCommerceProduct_connectionId_externalKey_key.
--
-- Note the deliberate PostgreSQL semantics: NULLs compare as distinct in a
-- unique index, so several rows with a NULL "externalOrderId" may coexist for
-- one connection. That is intended — the column is nullable so a future
-- redaction pass can scrub it, and redacted rows must not collide with each
-- other. The ingestion service never writes a NULL "externalOrderId" itself; it
-- skips any payload whose order id could not be extracted.
--
-- REDACTION-READY FROM DAY ONE
-- ----------------------------
-- Every provider-identity string is NULLABLE: "externalOrderId",
-- "orderNumber", "externalLineItemId", "externalProductId",
-- "externalVariantId", "sku", "externalOrderRef". A future shop/redact pass can
-- therefore null them in place with no migration. This is the explicit fix for
-- the documented ShopifyRewardRedemption.shopifyShopDomain pain point, where a
-- non-nullable provider column cannot be scrubbed by the existing shop/redact
-- webhook.
--
-- IDEMPOTENCY KEY
-- ---------------
-- CommerceOrderEvent_provider_providerEventId_key is the deduplication key. A
-- duplicate provider delivery (the same X-Shopify-Webhook-Id) violates it, and
-- the ingestion service treats that violation as ALREADY_PROCESSED — a
-- successful no-op, never an error and never a second write to the order table.
-- This mirrors the ShopifyRewardRedemption.idempotencyKey precedent.
--
-- NO COMPOSITE SAME-BRAND FOREIGN KEY (and why)
-- ---------------------------------------------
-- CampaignCommerceProduct, CampaignLessonProduct and CommerceClickAttribution
-- use a composite (campaignId, brandId) -> Campaign(id, brandId) foreign key
-- because Campaign_id_brandId_key already exists (created by
-- 20260807120000). There is NO equivalent CommerceConnection(id, brandId)
-- unique key, and creating one would add a unique index to a PRE-EXISTING
-- table, which this migration deliberately refuses to do. Cross-brand integrity
-- is instead enforced in src/lib/commerce/order-ingestion.ts, which always
-- reads "brandId" FROM the resolved CommerceConnection row and never accepts it
-- from a caller or from a webhook payload. If a database-level guarantee is
-- wanted later, it is a separate, deliberately-reviewed migration that adds
-- CommerceConnection_id_brandId_key first.
--
-- CASCADE REASONING
-- -----------------
-- CommerceOrder.connectionId  -> CommerceConnection  ON DELETE CASCADE
-- CommerceOrder.brandId       -> Brand               ON DELETE CASCADE
-- CommerceOrderEvent.connectionId -> CommerceConnection ON DELETE CASCADE
-- CommerceOrderEvent.brandId      -> Brand              ON DELETE CASCADE
--   These four columns are REQUIRED, so there is no valid orphan state and SET
--   NULL is not expressible. CASCADE matches CommerceProductSyncRun, whose
--   required connectionId/brandId cascade for the same reason. Deleting a brand
--   or a connection is already a destructive, deliberate operation.
--
-- CommerceOrderLineItem.orderId -> CommerceOrder ON DELETE CASCADE
--   A line item has no meaning without its order.
--
-- CommerceOrderLineItem.connectedProductId -> ConnectedCommerceProduct SET NULL
--   Best-effort catalog resolution. A merchant can sell a product SQRATCH never
--   synced, and deleting a catalog row must never destroy historical order
--   revenue.
--
-- CommerceOrder.attributionId -> CommerceClickAttribution ON DELETE SET NULL
--   Optional 1:1. Deleting or expiring click evidence must not delete the
--   order; it only removes the claim that this order came from that click.
--
-- CommerceOrderEvent.orderId -> CommerceOrder ON DELETE SET NULL
--   The event ledger is audit evidence and must survive order deletion. It is
--   also nullable because an event can legitimately resolve to no order at all
--   (a SKIPPED_DISCONNECTED delivery).
--
-- PREFLIGHT (run manually immediately before deploying; do NOT run during
-- development against a production DATABASE_URL):
--
-- 1. Confirm all prerequisite migrations are applied and not rolled back. This
--    migration's foreign keys depend on all of them:
--
--    SELECT migration_name, finished_at, rolled_back_at
--    FROM _prisma_migrations
--    WHERE migration_name IN (
--      '20260806120000_add_commerce_connection_abstraction',
--      '20260806140000_add_commerce_product_catalog',
--      '20260807160000_add_commerce_click_attribution'
--    )
--    ORDER BY migration_name;
--
--    All three rows must be present with a non-null finished_at and a null
--    rolled_back_at. Stop if any is missing.
--
-- 2. Confirm the tables those migrations created actually exist:
--
--    SELECT to_regclass('public."CommerceConnection"')         IS NOT NULL AS has_commerce_connection,
--           to_regclass('public."ConnectedCommerceProduct"')   IS NOT NULL AS has_connected_product,
--           to_regclass('public."CommerceClickAttribution"')   IS NOT NULL AS has_click_attribution,
--           to_regclass('public."Brand"')                      IS NOT NULL AS has_brand;
--
--    Every column must be true.
--
-- 3. Confirm the enum type names this migration creates are not already taken:
--
--    SELECT typname FROM pg_type
--    WHERE typname IN (
--      'CommerceOrderFinancialStatus',
--      'CommerceOrderFulfillmentStatus',
--      'CommerceOrderEventStatus'
--    );
--
--    This must return ZERO rows.
--
-- 4. Confirm the new tables do not already exist from a manual partial
--    application. Stop and investigate if any is true:
--
--    SELECT to_regclass('public."CommerceOrder"')         IS NOT NULL AS has_order,
--           to_regclass('public."CommerceOrderLineItem"') IS NOT NULL AS has_line_item,
--           to_regclass('public."CommerceOrderEvent"')    IS NOT NULL AS has_event;
--
-- 5. There is NO new environment variable to configure for this migration. The
--    ingestion path reuses COMMERCE_CLICK_TOKEN_PEPPER (already required by
--    Phase 6) only on the attribution-lookup branch, which cannot fire in
--    production today.
--
-- ROLLBACK LIMITATION
-- --------------------
-- There is intentionally no automatic rollback SQL. While these tables are
-- empty (which is their state until the rollout in
-- docs/commerce/phase-7-order-normalization-summary.md happens), dropping them
-- is genuinely lossless and breaks nothing: no pre-existing table references
-- them, and no shipped feature reads them. Once order rows exist, dropping them
-- destroys normalized revenue history that CANNOT be re-derived — the provider
-- payloads are not retained anywhere (only their one-way digests are), and
-- re-fetching them from the provider would require the very read_orders scope
-- this phase does not hold. AnalyticsEvent is NOT a substitute: it is
-- client-fired, forgeable, and carries no money at all.
--
-- Restore from a database backup, or export CommerceOrder /
-- CommerceOrderLineItem / CommerceOrderEvent, before manually dropping the
-- additive objects.


-- CreateEnum
CREATE TYPE "CommerceOrderFinancialStatus" AS ENUM ('PENDING', 'AUTHORIZED', 'PARTIALLY_PAID', 'PAID', 'PARTIALLY_REFUNDED', 'REFUNDED', 'VOIDED');

-- CreateEnum
CREATE TYPE "CommerceOrderFulfillmentStatus" AS ENUM ('UNFULFILLED', 'PARTIALLY_FULFILLED', 'FULFILLED', 'RESTOCKED');

-- CreateEnum
CREATE TYPE "CommerceOrderEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'SKIPPED_STALE', 'SKIPPED_DISCONNECTED', 'FAILED');

-- CreateTable
CREATE TABLE "CommerceOrder" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "provider" "CommerceProvider" NOT NULL,
    "externalOrderId" TEXT,
    "orderNumber" TEXT,
    "currencyCode" TEXT,
    "minorUnitExponent" INTEGER,
    "subtotalMinor" BIGINT,
    "discountsMinor" BIGINT,
    "shippingMinor" BIGINT,
    "taxMinor" BIGINT,
    "totalMinor" BIGINT,
    "totalRefundedMinor" BIGINT NOT NULL DEFAULT 0,
    "netRevenueMinor" BIGINT,
    "financialStatus" "CommerceOrderFinancialStatus",
    "fulfillmentStatus" "CommerceOrderFulfillmentStatus",
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "providerCreatedAt" TIMESTAMP(3),
    "providerUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "attributionId" TEXT,

    CONSTRAINT "CommerceOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceOrderLineItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "externalLineItemId" TEXT,
    "externalProductId" TEXT,
    "externalVariantId" TEXT,
    "connectedProductId" TEXT,
    "title" TEXT,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" BIGINT,
    "discountMinor" BIGINT,
    "taxMinor" BIGINT,
    "totalMinor" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommerceOrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommerceOrderEvent" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "brandId" TEXT NOT NULL,
    "provider" "CommerceProvider" NOT NULL,
    "providerEventId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "externalOrderRef" TEXT,
    "providerUpdatedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" "CommerceOrderEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "payloadDigest" TEXT NOT NULL,
    "failureSummary" TEXT,
    "orderId" TEXT,

    CONSTRAINT "CommerceOrderEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommerceOrder_attributionId_key" ON "CommerceOrder"("attributionId");

-- CreateIndex
CREATE INDEX "CommerceOrder_brandId_providerCreatedAt_idx" ON "CommerceOrder"("brandId", "providerCreatedAt");

-- CreateIndex
CREATE INDEX "CommerceOrder_connectionId_providerUpdatedAt_idx" ON "CommerceOrder"("connectionId", "providerUpdatedAt");

-- CreateIndex
CREATE INDEX "CommerceOrder_financialStatus_idx" ON "CommerceOrder"("financialStatus");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceOrder_connectionId_externalOrderId_key" ON "CommerceOrder"("connectionId", "externalOrderId");

-- CreateIndex
CREATE INDEX "CommerceOrderLineItem_orderId_idx" ON "CommerceOrderLineItem"("orderId");

-- A full provider snapshot cannot contain the same non-null provider line id
-- twice. PostgreSQL permits multiple NULLs, preserving redacted/unknown lines.
CREATE UNIQUE INDEX "CommerceOrderLineItem_orderId_externalLineItemId_key" ON "CommerceOrderLineItem"("orderId", "externalLineItemId");

-- CreateIndex
CREATE INDEX "CommerceOrderLineItem_connectedProductId_idx" ON "CommerceOrderLineItem"("connectedProductId");

-- CreateIndex
CREATE INDEX "CommerceOrderEvent_connectionId_receivedAt_idx" ON "CommerceOrderEvent"("connectionId", "receivedAt");

-- CreateIndex
CREATE INDEX "CommerceOrderEvent_brandId_receivedAt_idx" ON "CommerceOrderEvent"("brandId", "receivedAt");

-- CreateIndex
CREATE INDEX "CommerceOrderEvent_externalOrderRef_providerUpdatedAt_idx" ON "CommerceOrderEvent"("externalOrderRef", "providerUpdatedAt");

-- CreateIndex
CREATE INDEX "CommerceOrderEvent_status_receivedAt_idx" ON "CommerceOrderEvent"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "CommerceOrderEvent_orderId_idx" ON "CommerceOrderEvent"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "CommerceOrderEvent_provider_providerEventId_key" ON "CommerceOrderEvent"("provider", "providerEventId");

-- AddForeignKey
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CommerceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrder" ADD CONSTRAINT "CommerceOrder_attributionId_fkey" FOREIGN KEY ("attributionId") REFERENCES "CommerceClickAttribution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderLineItem" ADD CONSTRAINT "CommerceOrderLineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderLineItem" ADD CONSTRAINT "CommerceOrderLineItem_connectedProductId_fkey" FOREIGN KEY ("connectedProductId") REFERENCES "ConnectedCommerceProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderEvent" ADD CONSTRAINT "CommerceOrderEvent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "CommerceOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderEvent" ADD CONSTRAINT "CommerceOrderEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "CommerceConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommerceOrderEvent" ADD CONSTRAINT "CommerceOrderEvent_brandId_fkey" FOREIGN KEY ("brandId") REFERENCES "Brand"("id") ON DELETE CASCADE ON UPDATE CASCADE;
