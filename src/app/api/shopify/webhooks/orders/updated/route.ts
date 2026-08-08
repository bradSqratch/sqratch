/**
 * POST /api/shopify/webhooks/orders/updated
 *
 * ===========================================================================
 * THIS ROUTE IS NOT REACHABLE IN PRODUCTION TODAY. READ BEFORE CHANGING.
 * ===========================================================================
 * The handler below is real, complete, and fixture-testable — but Shopify can
 * never call it as the app is currently configured:
 *
 *   1. Neither `shopify.app.toml` nor `shopify.app.custom.toml` declares a
 *      webhook subscription for the `orders/updated` topic. All subscriptions
 *      are config-declared (runtime registration was removed), so an
 *      unsubscribed topic is never delivered.
 *   2. The app does not hold the `read_orders` access scope
 *      (`SHOPIFY_SCOPES` in `src/lib/shopify.ts` is
 *      `read_products,read_discounts,write_discounts`). Shopify will not send
 *      an order payload to an app without it.
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
 * `updated_at`. Returns 200 in every case except a genuine signature failure
 * (401) or an unconfigured `SHOPIFY_API_SECRET` (500). Writes no points and
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
