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
 * LIVE-CONFIGURATION PREREQUISITES
 * ===========================================================================
 * Phase 12 declares `orders/create`, `orders/updated`, and `refunds/create`
 * plus `read_orders` in both Shopify configurations. Delivery is live only
 * after the operator deploys that config, enables the Theme App Extension, and
 * each existing merchant reauthorizes to grant the new scope.
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
 * RESPONSE POLICY: 200 MEANS "SETTLED", 500 MEANS "REDELIVER THIS"
 * ===========================================================================
 * The response code is a single question: would asking Shopify to redeliver
 * plausibly change the result? A 200 tells Shopify to stop retrying, so it may
 * only be sent once this delivery is SETTLED — applied, or deliberately and
 * permanently declined. Anything unproven must be a 500, because Shopify's
 * retry is the only remaining chance to land that order.
 *
 *   401 — invalid or absent HMAC. Produced upstream by
 *         `verifyShopifyWebhookRequest` and returned verbatim.
 *   500 — `SHOPIFY_API_SECRET` unconfigured. Also produced upstream, verbatim.
 *   200 — applied (created/updated), or skipped as stale, or the shop is
 *         unknown/disconnected, or the payload is deterministically
 *         unprocessable (e.g. no external order id). A retry would reach the
 *         identical conclusion, so retrying would only cause a retry storm.
 *   200 — a genuinely COMPLETED duplicate: the ingestion ledger shows this
 *         exact delivery already reached a terminal state.
 *   500 — the delivery is IN FLIGHT: another request holds a live claim lease
 *         on this exact event and neither its success nor its failure is
 *         proven yet. Answering 200 here is precisely how a crashed worker's
 *         order used to be lost forever.
 *   500 — a transient write failure, or any unexpected error in the pipeline.
 *
 * `isRetryableOrderIngestionOutcome` (in `../order-ingestion`) is the single
 * source of truth for which ingestion outcomes fall in the 500 bucket; this
 * module does not maintain a second copy of that list.
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
import {
  ingestNormalizedOrder,
  isRetryableOrderIngestionOutcome,
  providerProductKeyCandidates,
  type OrderIngestionDeps,
} from "../order-ingestion";
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
 * PURE. Shopify's `OrderIngestionDeps.expandProductKeyCandidates`.
 *
 * Shopify reports one product under two different ids depending on the API that
 * emitted it: the CATALOG sync stores the GraphQL global id
 * (`gid://shopify/Product/123`) in `ConnectedCommerceProduct.externalKey`, while
 * an ORDER webhook reports the same product as its bare numeric REST id
 * (`123`). Matching therefore has to try both directions.
 *
 * That `gid://` namespace is knowledge only Shopify has, so it lives here rather
 * than in the provider-neutral ingestion layer, which keeps the generic
 * candidates (`providerProductKeyCandidates`) and adds the one Shopify-specific
 * expansion on top.
 */
export function shopifyProductKeyCandidates(
  externalProductId: string | null,
): string[] {
  const raw = externalProductId?.trim();
  if (!raw) {
    return [];
  }
  const candidates = new Set(providerProductKeyCandidates(raw));
  if (/^\d+$/.test(raw)) {
    candidates.add(`gid://shopify/Product/${raw}`);
  }
  return [...candidates];
}

/**
 * Runs the full verify -> resolve -> normalize -> ingest pipeline for one
 * Shopify order webhook delivery.
 *
 * This wrapper exists so that NOTHING in the pipeline can escape as an
 * unhandled exception. `ingestNormalizedOrder` already classifies its own
 * failures, but the steps around it (signature verification, the shop-domain
 * lookup, the pure normalizer) can still throw — a transient DB error on the
 * connection lookup being the realistic case. An unhandled throw here would
 * become an opaque framework error; a deliberate 500 is the same instruction to
 * Shopify ("redeliver") with a classified audit line and no error content.
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
  try {
    return await runShopifyOrderWebhook(request, topic, normalize, deps);
  } catch {
    // Not bound and never logged: an error thrown from a Prisma call can embed
    // payload column values, and this module's whole logging contract is that
    // only classified tags leave it. The tag plus the 500 are the record.
    logWebhook(topic, "", "UNEXPECTED_ERROR", null);
    return new NextResponse(null, { status: 500 });
  }
}

async function runShopifyOrderWebhook(
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
    {
      // Shopify's own id-form knowledge, supplied to the provider-neutral
      // ingestion layer rather than embedded in it. Listed first so an
      // injected `ingestionDeps` can still override it deliberately, while a
      // caller that overrides unrelated deps never silently loses it.
      expandProductKeyCandidates: shopifyProductKeyCandidates,
      ...resolved.ingestionDeps,
    },
  );

  logWebhook(topic, shopDomain, outcome.status, {
    reason: outcome.reason,
    lineItemCount: outcome.lineItemCount,
    attributionLinked: outcome.attributionLinked,
    warnings,
  });

  // 5. Settled -> 200; unproven -> 500 so Shopify redelivers. The unproven set
  // is owned by the ingestion layer (`isRetryableOrderIngestionOutcome`): a
  // transient write failure, an unexpected error, and — the case that makes
  // this more than a nicety — a delivery still IN FLIGHT under another
  // request's claim lease. The ingestion layer's lease/reclaim machinery means
  // a redelivery either finds the work finished (200, no reprocessing) or takes
  // the abandoned claim over and lands the order for real. Deterministic
  // rejects stay 200 and never form a retry storm.
  return new NextResponse(null, {
    status: isRetryableOrderIngestionOutcome(outcome) ? 500 : 200,
  });
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
