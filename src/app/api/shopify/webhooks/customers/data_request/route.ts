import { NextRequest, NextResponse } from "next/server";
import { verifyShopifyWebhookRequest } from "@/lib/shopify-webhooks";

// SQRATCH holds zero Shopify-customer-keyed data (no Shopify customer IDs,
// emails, or phone numbers are stored in any table). Discount codes are issued
// with customerSelection:all and keyed to SQRATCH userId, not Shopify customer
// identity. Therefore there is no data to export for this request.
// See docs/shopify-data-inventory.md §§2–3 for the full analysis.
export async function POST(request: NextRequest) {
  const verification = await verifyShopifyWebhookRequest(request);

  if (!verification.ok) {
    return verification.response;
  }

  // Sanitized audit log: topic + shop domain only — no customer PII.
  console.log(
    JSON.stringify({
      event: "shopify_webhook",
      topic: "customers/data_request",
      shopDomain: verification.shop || null,
      dataFound: false,
    }),
  );

  // No data to return — SQRATCH stores no records keyed to Shopify customer identity.
  return new NextResponse(null, { status: 200 });
}
