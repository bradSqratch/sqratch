import { NextRequest, NextResponse } from "next/server";
import { verifyShopifyWebhookHmac } from "@/lib/shopify";

export async function verifyShopifyWebhookRequest(request: NextRequest) {
  const rawBody = Buffer.from(await request.arrayBuffer());
  const apiSecret = process.env.SHOPIFY_API_SECRET;

  if (!apiSecret) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Missing Shopify API secret." },
        { status: 500 },
      ),
    };
  }

  const valid = verifyShopifyWebhookHmac({
    rawBody,
    hmac: request.headers.get("x-shopify-hmac-sha256"),
    secret: apiSecret,
  });

  if (!valid) {
    return {
      ok: false as const,
      response: NextResponse.json(
        { error: "Invalid Shopify webhook signature." },
        { status: 401 },
      ),
    };
  }

  const shop = String(request.headers.get("x-shopify-shop-domain") || "")
    .trim()
    .toLowerCase();
  const rawText = rawBody.toString("utf8");
  let payload: unknown = null;

  try {
    payload = rawText ? JSON.parse(rawText) : null;
  } catch {
    payload = null;
  }

  // RFC 3339 timestamp of when SHOPIFY triggered this delivery (not when we
  // received it) — present on every delivery, survives retries unchanged
  // (Shopify redelivers the ORIGINAL payload/timestamp on retry, not a fresh
  // one). Used to fence terminal-state webhooks (`app/uninstalled`,
  // `shop/redact`) against being applied after a newer install has already
  // superseded the connection they describe. `null` when absent/unparseable
  // — callers must treat that as "no evidence of staleness", not as proof of
  // freshness.
  const triggeredAtRaw = request.headers.get("x-shopify-triggered-at");
  const triggeredAt = triggeredAtRaw ? new Date(triggeredAtRaw) : null;

  return {
    ok: true as const,
    rawBody: rawText,
    shop,
    payload,
    triggeredAt: triggeredAt && !Number.isNaN(triggeredAt.getTime()) ? triggeredAt : null,
  };
}
