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
 * replay; incremental double-counts). `normalizeShopifyRefundPayload`
 * therefore emits a PARTIAL input that updates only what it can prove —
 * chiefly the refund timestamp — and leaves the refunded amount to the
 * `orders/updated` delivery Shopify emits for the same order, which carries
 * the order's own cumulative refund state. A rollout must subscribe to BOTH
 * topics; this one on its own records refund timing but never a refunded
 * amount. If a payload variant embeds its parent `order` object, the
 * normalizer uses that instead and the cumulative figure lands here directly.
 *
 * Behavior: verifies the raw-body HMAC via `verifyShopifyWebhookRequest`,
 * resolves the shop to a `CommerceConnection`, normalizes the payload with the
 * pure Shopify refund normalizer, and hands it to the idempotent
 * provider-neutral ingestion service — which applies it as an UPDATE to the
 * existing order, never as a new order row. Deterministic rejections
 * acknowledge with 200; signature failure returns 401 and transient storage
 * failure returns 500 for retry. Writes no points, reverses no points, and
 * computes no commission.
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
