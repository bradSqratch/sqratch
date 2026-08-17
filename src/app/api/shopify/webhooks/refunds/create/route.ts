/**
 * POST /api/shopify/webhooks/refunds/create
 *
 * ===========================================================================
 * LIVE-CONFIGURATION PREREQUISITES. READ BEFORE DEPLOYING.
 * ===========================================================================
 * Phase 12 declares this topic and `read_orders` in both Shopify configs.
 * Delivery starts only after config deployment and merchant reauthorization.
 *
 * ===========================================================================
 *
 * REFUND SEMANTICS — WHY THIS ROUTE ALONE IS NOT ENOUGH
 * -----------------------------------------------------
 * A `refunds/create` body is a single Refund resource. Its transaction amounts
 * describe THAT refund, i.e. an INCREMENT, while
 * `src/lib/commerce/order-ingestion.ts` deliberately models
 * `totalRefundedMinor` as a CUMULATIVE total (cumulative is idempotent under
 * replay; incremental double-counts). Worse, a REST refund payload cannot
 * prove the money actually SETTLED at all (Shopify: a Refund object's
 * existence does not mean money moved — check transaction status).
 * `normalizeShopifyRefundPayload` therefore emits a PARTIAL input that
 * updates only what it can prove — chiefly the refund timestamp — and this
 * route's shared handler (`shopifyTopicRequiresFinancialReconciliation` in
 * `shopify-order-webhook.ts`) unconditionally triggers a live Shopify Admin
 * GraphQL reconciliation for every delivery on this topic, which is the sole
 * trustworthy source of the refunded amount. See
 * `src/lib/commerce/providers/shopify-order-financial-reconciliation.ts`.
 *
 * Behavior: verifies the raw-body HMAC via `verifyShopifyWebhookRequest`,
 * resolves the shop to a `CommerceConnection`, normalizes the payload with the
 * pure Shopify refund normalizer, reconciles financial state via live Shopify
 * GraphQL, and hands the result to the idempotent provider-neutral ingestion
 * service — which applies it as an UPDATE to the existing order, never as a
 * new order row. Deterministic rejections acknowledge with 200; signature
 * failure returns 401 and transient failure (write OR reconciliation)
 * returns 500 for retry. Writes no points, reverses no points, and computes
 * no commission.
 */

import type { NextRequest } from "next/server";
import { handleShopifyOrderWebhook } from "@/lib/commerce/providers/shopify-order-webhook";
import { normalizeShopifyRefundPayload } from "@/lib/commerce/providers/shopify-order-normalizer";

// Topic identity is bound to this route's URL PATH, never to the spoofable
// `x-shopify-topic` header.
const TOPIC = "refunds/create";

export async function POST(request: NextRequest) {
  return handleShopifyOrderWebhook(request, TOPIC, normalizeShopifyRefundPayload);
}
