/**
 * POST /api/shopify/webhooks/orders/updated
 *
 * ===========================================================================
 * LIVE-CONFIGURATION PREREQUISITES. READ BEFORE DEPLOYING.
 * ===========================================================================
 * Phase 12 declares this topic and `read_orders` in both Shopify configs.
 * Delivery starts only after config deployment and merchant reauthorization.
 *
 * ===========================================================================
 *
 * This is the topic that carries authoritative order state over time: an
 * updated `financial_status`, a cancellation, a fulfillment change, and — per
 * the refund design in `src/lib/commerce/order-ingestion.ts` — the CUMULATIVE
 * refunded total, which Shopify reports on the order rather than on an
 * individual refund. A production rollout that subscribes to `refunds/create`
 * but not to this topic would record refund timing without ever recording the
 * refunded amount.
 *
 * Behavior: verifies the raw-body HMAC via `verifyShopifyWebhookRequest`,
 * resolves the shop to a `CommerceConnection`, normalizes the payload with the
 * pure Shopify normalizer, and hands it to the idempotent provider-neutral
 * ingestion service, which refuses to overwrite a stored order with an older
 * `updated_at`. Deterministic rejections acknowledge with 200; signature
 * failure returns 401 and transient storage failure returns 500 for retry.
 * Writes no points and computes no commission.
 */

import type { NextRequest } from "next/server";
import { handleShopifyOrderWebhook } from "@/lib/commerce/providers/shopify-order-webhook";
import { normalizeShopifyOrderPayload } from "@/lib/commerce/providers/shopify-order-normalizer";

// Topic identity is bound to this route's URL PATH, never to the spoofable
// `x-shopify-topic` header.
const TOPIC = "orders/updated";

export async function POST(request: NextRequest) {
  return handleShopifyOrderWebhook(request, TOPIC, normalizeShopifyOrderPayload);
}
