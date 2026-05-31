import { NextRequest, NextResponse } from "next/server";
import { verifyShopifyWebhookRequest } from "@/lib/shopify-webhooks";

export async function POST(request: NextRequest) {
  const verification = await verifyShopifyWebhookRequest(request);

  if (!verification.ok) {
    return verification.response;
  }

  return new NextResponse(null, { status: 200 });
}
