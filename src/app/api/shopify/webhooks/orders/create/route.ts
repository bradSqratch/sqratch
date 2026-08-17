/**
 * POST /api/shopify/webhooks/orders/create
 *
 * ===========================================================================
 * LIVE-CONFIGURATION PREREQUISITES. READ BEFORE DEPLOYING.
 * ===========================================================================
 * Phase 12 declares this topic and `read_orders` in both Shopify configs.
 * Delivery starts only after config deployment and merchant reauthorization;
 * Theme App Extension activation is separately required for conversion tokens.
 * ===========================================================================
 *
 * Behavior: verifies the raw-body HMAC via `verifyShopifyWebhookRequest`,
 * resolves the shop to a `CommerceConnection`, normalizes the payload with the
 * pure Shopify normalizer, and hands it to the idempotent provider-neutral
 * ingestion service. Deterministic rejections acknowledge with 200; signature
 * failure returns 401 and transient storage failure returns 500 for retry.
 * Writes no points and computes no commission.
 */

import type { NextRequest } from "next/server";
import { handleShopifyOrderWebhook } from "@/lib/commerce/providers/shopify-order-webhook";
import { normalizeShopifyOrderPayload } from "@/lib/commerce/providers/shopify-order-normalizer";

// Topic identity is bound to this route's URL PATH, never to the spoofable
// `x-shopify-topic` header.
const TOPIC = "orders/create";

export async function POST(request: NextRequest) {
  return handleShopifyOrderWebhook(request, TOPIC, normalizeShopifyOrderPayload);
}
