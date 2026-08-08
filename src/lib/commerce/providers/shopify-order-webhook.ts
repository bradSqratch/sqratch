/**
 * src/lib/commerce/providers/shopify-order-webhook.ts
 *
 * Shared request handling for the three Shopify ORDER webhook routes
 * (`orders/create`, `orders/updated`, `refunds/create`). The routes themselves
 * are thin: each supplies its topic and its normalizer and nothing else, so
 * the verification, connection-resolution, and response semantics can never
 * drift apart between them.
 *
 * ===========================================================================
 * NOT REACHABLE IN PRODUCTION TODAY
 * ===========================================================================
 * No `orders/*` or `refunds/*` topic is subscribed in `shopify.app.toml` or
 * `shopify.app.custom.toml`, and the app does not hold `read_orders`, so
 * Shopify never delivers to these routes. See
 * `docs/commerce/phase-7-order-normalization-summary.md` for the rollout
 * prerequisites. Nothing here requests, implies, or grants a scope.
 *
 * ===========================================================================
 * VERIFICATION SEQUENCE — REUSED, NOT REIMPLEMENTED
 * ===========================================================================
 * `verifyShopifyWebhookRequest` (`src/lib/shopify-webhooks.ts`, unchanged) is
 * called directly and does exactly what the four existing webhook routes rely
 * on: read the body as RAW BYTES first, verify HMAC-SHA-256 over those bytes
 * with a constant-time compare, and only THEN attempt `JSON.parse` (yielding
 * `payload: null` on malformed JSON rather than throwing). Nothing is parsed
 * before it is authenticated.
 *
 * These routes deliberately do NOT go through `ShopifyCommerceAdapter`'s
 * webhook method. That adapter's topic map recognizes only the connection and
 * compliance topics and is asserted by an existing test to REJECT
 * `orders/create` as unrecognized. Using the lower-level, already
 * provider-neutral primitive keeps this work fully decoupled from that adapter
 * and leaves its behavior and its test untouched.
 *
 * TOPIC IDENTITY COMES FROM THE ROUTE PATH, NEVER FROM `x-shopify-topic`. That
 * header is attacker-controllable in the sense that it is not covered by any
 * separate signature beyond the body HMAC, and the existing routes already
 * establish this convention by ignoring it entirely.
 *
 * ===========================================================================
 * RESPONSE POLICY: 200 FOR EVERYTHING EXCEPT A SIGNATURE FAILURE
 * ===========================================================================
 * A webhook that was processed, deduplicated, skipped, or even failed to write
 * has been RECEIVED — telling Shopify otherwise triggers its retry schedule
 * and can produce a retry storm over work that will never succeed on a retry
 * (a disconnected shop, an unknown shop, a duplicate delivery). The only
 * non-200 responses are the ones `verifyShopifyWebhookRequest` itself
 * produces: 401 for an invalid/absent HMAC and 500 for an unconfigured
 * `SHOPIFY_API_SECRET`. Both are returned verbatim, exactly as the four
 * existing routes do.
 *
 * ===========================================================================
 * NO PII IN LOGS
 * ===========================================================================
 * The audit log line carries the topic, the shop domain, the outcome tag, and
 * counts. It never carries a payload excerpt, a customer field, an order
 * total, or the raw click token.
 */

import { NextResponse, type NextRequest } from "next/server";
import { CommerceProvider } from "@prisma/client";
import { verifyShopifyWebhookRequest } from "@/lib/shopify-webhooks";
import { normalizeExternalAccountId } from "../connection-sync";
import { ingestNormalizedOrder, type OrderIngestionDeps } from "../order-ingestion";
import {
  computeShopifyPayloadDigest,
  type ShopifyOrderNormalizationResult,
} from "./shopify-order-normalizer";

/** Resolves a shop domain to its `CommerceConnection`, or null. */
export type ShopifyOrderWebhookDeps = {
  findConnectionByShopDomain(
    shopDomain: string,
  ): Promise<{ id: string; brandId: string } | null>;
  ingest: typeof ingestNormalizedOrder;
  /** Forwarded to the ingestion service so tests can inject a DB-free stack. */
  ingestionDeps: Partial<OrderIngestionDeps>;
};

async function defaultFindConnectionByShopDomain(
  shopDomain: string,
): Promise<{ id: string; brandId: string } | null> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.commerceConnection.findUnique({
    where: {
      provider_externalAccountId: {
        provider: CommerceProvider.SHOPIFY,
        externalAccountId: normalizeExternalAccountId(shopDomain),
      },
    },
    select: { id: true, brandId: true },
  });
}

const DEFAULT_WEBHOOK_DEPS: ShopifyOrderWebhookDeps = {
  findConnectionByShopDomain: defaultFindConnectionByShopDomain,
  ingest: ingestNormalizedOrder,
  ingestionDeps: {},
};

/**
 * Deduplication key for a delivery.
 *
 * Shopify stamps every delivery with `X-Shopify-Webhook-Id`, a stable id that
 * is REUSED across the retries of one logical event — which is exactly the
 * property `CommerceOrderEvent.@@unique([provider, providerEventId])` needs.
 *
 * A fixture-driven test has no such header, and so would a malformed or
 * proxy-stripped delivery. Falling back to a random value would defeat
 * deduplication entirely (every replay would look new), so the fallback is
 * DETERMINISTIC: `digest:<sha256 of the raw body>`. Two byte-identical
 * deliveries therefore still deduplicate. The trade-off, stated rather than
 * hidden: two genuinely distinct events with byte-identical bodies would
 * collide under the fallback and the second would be reported
 * ALREADY_PROCESSED. For an order payload — which always carries an
 * `updated_at` — byte-identical bodies mean identical state, so collapsing
 * them is correct rather than lossy.
 */
export function resolveProviderEventId(
  headerValue: string | null,
  payloadDigest: string,
): string {
  const headerId = headerValue?.trim();
  return headerId ? headerId : `digest:${payloadDigest}`;
}

export type ShopifyOrderWebhookResult = {
  handled: boolean;
  /** Short classified tag for logging. Never payload-derived. */
  outcome: string;
};

/**
 * Runs the full verify -> resolve -> normalize -> ingest pipeline for one
 * Shopify order webhook delivery.
 *
 * @param topic Bound to the ROUTE PATH by the caller (e.g. "orders/create").
 * @param normalize Pure payload normalizer for this topic.
 */
export async function handleShopifyOrderWebhook(
  request: NextRequest,
  topic: string,
  normalize: (
    payload: unknown,
    context: { connectionId: string; brandId: string },
  ) => ShopifyOrderNormalizationResult,
  deps: Partial<ShopifyOrderWebhookDeps> = {},
): Promise<NextResponse> {
  const resolved: ShopifyOrderWebhookDeps = { ...DEFAULT_WEBHOOK_DEPS, ...deps };

  // 1. Authenticate the raw bytes BEFORE anything reads the parsed payload.
  const verification = await verifyShopifyWebhookRequest(request);
  if (!verification.ok) {
    return verification.response;
  }

  const payloadDigest = computeShopifyPayloadDigest(verification.rawBody);
  const providerEventId = resolveProviderEventId(
    request.headers.get("x-shopify-webhook-id"),
    payloadDigest,
  );

  // 2. Resolve the shop to a connection. An unknown shop is answered 200 with
  //    no processing: there is nothing to attribute the order to, and asking
  //    Shopify to retry would never change that.
  const shopDomain = verification.shop;
  const connection = shopDomain
    ? await resolved.findConnectionByShopDomain(shopDomain)
    : null;

  if (!connection) {
    logWebhook(topic, shopDomain, "NO_CONNECTION", null);
    return new NextResponse(null, { status: 200 });
  }

  // 3. Normalize (pure), then 4. ingest (idempotent).
  const { order, warnings } = normalize(verification.payload, {
    connectionId: connection.id,
    brandId: connection.brandId,
  });

  const outcome = await resolved.ingest(
    {
      providerEventId,
      topic,
      payloadDigest,
      connectionId: connection.id,
      brandId: connection.brandId,
      provider: CommerceProvider.SHOPIFY,
    },
    order,
    resolved.ingestionDeps,
  );

  logWebhook(topic, shopDomain, outcome.status, {
    reason: outcome.reason,
    lineItemCount: outcome.lineItemCount,
    attributionLinked: outcome.attributionLinked,
    warnings,
  });

  // 5. A transient storage failure must be retried by Shopify. The ingestion
  // layer leases failed event IDs for re-drive, so a retry can safely reclaim
  // the event without duplicating an order write. Deterministic rejects above
  // still return 200 and do not create retry storms.
  return new NextResponse(null, { status: outcome.status === "FAILED" ? 500 : 200 });
}

function logWebhook(
  topic: string,
  shopDomain: string,
  outcome: string,
  detail: {
    reason: string | null;
    lineItemCount: number;
    attributionLinked: boolean;
    warnings: readonly string[];
  } | null,
): void {
  // Sanitized: topic, shop domain, classified outcome/warning tags and counts
  // only. No customer field, no order total, no payload excerpt, no token.
  console.log(
    JSON.stringify({
      event: "shopify_webhook",
      topic,
      shopDomain,
      outcome,
      reason: detail?.reason ?? null,
      lineItemCount: detail?.lineItemCount ?? 0,
      attributionLinked: detail?.attributionLinked ?? false,
      warnings: detail?.warnings ?? [],
    }),
  );
}
