import type { NextRequest } from "next/server";
import { handleCommerce7OrderWebhook } from "@/lib/commerce/providers/commerce7-order-webhook";

/**
 * `POST /api/commerce7/webhooks/orders`
 *
 * PHASE 16 BIG ROUND / SUBPHASE 4 — the single Commerce7 order webhook
 * route. Unlike Shopify (one URL per topic), Commerce7 subscribes to one
 * webhook per OBJECT type and differentiates events via the payload's own
 * `action` field (Create/Update/Bulk Update/Delete/Send) — so this route is
 * deliberately singular, with the action-level branching living in
 * `handleCommerce7OrderWebhook`.
 *
 * FAIL-CLOSED BY CONFIGURATION, NOT A SEPARATE FLAG: this route is only
 * ever reachable through `verifyCommerce7OrderWebhookAuth`
 * (`@/lib/commerce/providers/commerce7-order-webhook-auth`), which itself
 * answers a fixed 500 whenever `COMMERCE7_ORDER_WEBHOOK_USERNAME` /
 * `COMMERCE7_ORDER_WEBHOOK_PASSWORD` are not both configured. Until an
 * operator sets both AND configures the matching Basic Auth credential on
 * Commerce7's own webhook-subscription screen, no request can ever be
 * authenticated here.
 *
 * This route is intentionally thin: everything else (auth, tenant
 * resolution, normalization, idempotent ingestion, response-code policy)
 * lives in `handleCommerce7OrderWebhook`.
 */
export async function POST(request: NextRequest) {
  return handleCommerce7OrderWebhook(request);
}
