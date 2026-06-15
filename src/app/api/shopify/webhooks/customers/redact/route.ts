import { NextRequest, NextResponse } from "next/server";
import { verifyShopifyWebhookRequest } from "@/lib/shopify-webhooks";

// SQRATCH holds zero Shopify-customer-keyed data (no Shopify customer IDs,
// emails, or phone numbers are stored in any table). Discount codes are issued
// with customerSelection:all and keyed to SQRATCH userId, not Shopify customer
// identity. Therefore there is no customer PII to redact.
// See docs/shopify-data-inventory.md §§2, 4 for the full analysis.
export async function POST(request: NextRequest) {
  const verification = await verifyShopifyWebhookRequest(request);

  if (!verification.ok) {
    return verification.response;
  }

  // Sanitized audit log: topic + shop domain only — no customer PII.
  console.log(
    JSON.stringify({
      event: "shopify_webhook",
      topic: "customers/redact",
      shopDomain: verification.shop || null,
      redactionPerformed: false,
    }),
  );

  // No redaction required — SQRATCH stores no records keyed to Shopify customer identity.
  // SQRATCH User records and PointTransaction/ShopifyRewardRedemption rows are keyed to
  // SQRATCH-internal user IDs and must NOT be deleted based on a Shopify customer signal.
  return new NextResponse(null, { status: 200 });
}
