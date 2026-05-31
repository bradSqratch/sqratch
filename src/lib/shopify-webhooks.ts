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

  return {
    ok: true as const,
    rawBody: rawText,
    shop,
    payload,
  };
}
