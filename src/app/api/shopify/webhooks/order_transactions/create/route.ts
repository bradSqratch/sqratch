/**
 * POST /api/shopify/webhooks/order_transactions/create
 *
 * ===========================================================================
 * LIVE-CONFIGURATION PREREQUISITES. READ BEFORE DEPLOYING.
 * ===========================================================================
 * Requires the same `read_orders` scope as the other order topics, declared
 * in both Shopify configs. Delivery starts only after config deployment and
 * merchant reauthorization.
 *
 * ===========================================================================
 *
 * WHY THIS ROUTE EXISTS
 * ----------------------
 * Verified against Shopify's current webhook topic docs: `order_transactions/
 * create` "occurs when a order transaction is created or when it's status is
 * updated. Only occurs for transactions with a status of success, failure or
 * error." That restriction to TERMINAL states is exactly the gap
 * `orders/updated` alone cannot be assumed to cover: a refund transaction can
 * be created PENDING (e.g. a bank-transfer or delayed-gateway refund) and
 * later transition to SUCCESS/FAILURE with no other order-level field
 * changing. Shopify's own decision to ship this topic separately from
 * `orders/updated` is the evidence this codebase relies on — it is the only
 * reliable trigger for "a previously-pending transaction just settled or
 * definitively failed, re-check this order's financial state."
 *
 * Its payload is a bare OrderTransaction resource, never the order and never
 * a trustworthy money amount (the REST Transaction resource still has no
 * shop-money field). `normalizeShopifyOrderTransactionPayload` therefore
 * extracts only `externalOrderId`; `shopifyTopicRequiresFinancialReconciliation`
 * in `shopify-order-webhook.ts` unconditionally routes this topic to a live
 * Shopify Admin GraphQL reconciliation, exactly like `refunds/create`.
 *
 * Behavior: verifies the raw-body HMAC via `verifyShopifyWebhookRequest`,
 * resolves the shop to a `CommerceConnection`, normalizes the payload,
 * reconciles financial state via live Shopify GraphQL, and hands the result
 * to the idempotent provider-neutral ingestion service — which applies it as
 * an UPDATE to the existing order, never as a new order row. Deterministic
 * rejections acknowledge with 200; signature failure returns 401 and
 * transient failure (write OR reconciliation) returns 500 for retry. Writes
 * no points and computes no commission.
 */

import type { NextRequest } from "next/server";
import { handleShopifyOrderWebhook } from "@/lib/commerce/providers/shopify-order-webhook";
import { normalizeShopifyOrderTransactionPayload } from "@/lib/commerce/providers/shopify-order-normalizer";

// Topic identity is bound to this route's URL PATH, never to the spoofable
// `x-shopify-topic` header.
const TOPIC = "order_transactions/create";

export async function POST(request: NextRequest) {
  return handleShopifyOrderWebhook(request, TOPIC, normalizeShopifyOrderTransactionPayload);
}
