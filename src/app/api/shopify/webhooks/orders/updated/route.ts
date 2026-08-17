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
 * updated `financial_status`, a cancellation, a fulfillment change, and — when
 * this delivery's own `refunds[]` is non-empty
 * (`shopifyOrderHasRefundEvidence` in `shopify-order-normalizer.ts`) — a live
 * Shopify Admin GraphQL financial reconciliation for the CUMULATIVE refunded
 * total (see `shopify-order-financial-reconciliation.ts` for why REST alone
 * cannot establish this safely). A production rollout that subscribes to
 * `refunds/create` but not to this topic would record refund timing without
 * ever having a full-order snapshot to reconcile refunds against.
 *
 * Behavior: verifies the raw-body HMAC via `verifyShopifyWebhookRequest`,
 * resolves the shop to a `CommerceConnection`, normalizes the payload with the
 * pure Shopify normalizer, reconciles financial state via live Shopify
 * GraphQL when refund evidence is present, and hands the result to the
 * idempotent provider-neutral ingestion service, which refuses to overwrite a
 * stored order with an older `updated_at`. Deterministic rejections
 * acknowledge with 200; signature failure returns 401 and transient failure
 * (write OR reconciliation) returns 500 for retry. Writes no points and
 * computes no commission.
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
