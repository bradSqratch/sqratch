/**
 * POST /api/shopify/webhooks/refunds/create
 *
 * ===========================================================================
 * THIS ROUTE IS NOT REACHABLE IN PRODUCTION TODAY. READ BEFORE CHANGING.
 * ===========================================================================
 * The handler below is real, complete, and fixture-testable — but Shopify can
 * never call it as the app is currently configured:
 *
 *   1. Neither `shopify.app.toml` nor `shopify.app.custom.toml` declares a
 *      webhook subscription for the `refunds/create` topic. All subscriptions
 *      are config-declared (runtime registration was removed), so an
 *      unsubscribed topic is never delivered.
 *   2. The app does not hold the `read_orders` access scope
 *      (`SHOPIFY_SCOPES` in `src/lib/shopify.ts` is
 *      `read_products,read_discounts,write_discounts`). Shopify will not send
 *      a refund payload to an app without it.
 *
 * Neither of those is changed by this file, and neither should be changed
 * casually: adding `read_orders` alters the app's requested scope set, which
 * has a documented effect on already-installed connections (LEGACY_OFFLINE
 * brands can begin failing with undetected 403s, and every EXPIRING_OFFLINE
 * brand's next token check is affected). SQRATCH's published privacy policy
 * and terms also currently state that order access is not requested, which
 * remains true and must be updated before any rollout.
 *
 * Enabling this route therefore requires the manual, deliberately sequenced
 * rollout steps documented in
 * `docs/commerce/phase-7-order-normalization-summary.md`. Do not enable it by
 * editing a TOML file alone.
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
 * existing order, never as a new order row. Returns 200 in every case except a
 * genuine signature failure (401) or an unconfigured `SHOPIFY_API_SECRET`
 * (500). Writes no points, reverses no points, and computes no commission.
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
