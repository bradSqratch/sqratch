import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { verifyShopifyWebhookRequest } from "@/lib/shopify-webhooks";

// Shopify sends shop/redact 48 hours after a merchant uninstalls, confirming
// all shop data must be erased. Per docs/shopify-data-inventory.md §5:
//   - Clear ALL Shopify credentials and token metadata on the Brand record.
//   - Null shopifyShopDomain to release the unique slot (GDPR shop data removal).
//   - Anonymize Shopify-specific metadata on ShopifyRewardRedemption rows.
//   - PRESERVE all SQRATCH business records (PointTransaction,
//     ShopifyRewardRedemption core fields, BrandRewardOffer rows).
//   - Delete any orphaned OAuth state TokenStore rows for this shop.
export async function POST(request: NextRequest) {
  const verification = await verifyShopifyWebhookRequest(request);

  if (!verification.ok) {
    return verification.response;
  }

  if (verification.shop) {
    const shopDomain = verification.shop;

    // Find the brand holding this domain first so we can use its id in the
    // redemption update. updateMany on Brand will null the domain, so we need
    // the id before we null it.
    const brand = await prisma.brand.findFirst({
      where: { shopifyShopDomain: shopDomain },
      select: { id: true },
    });

    if (brand) {
      await prisma.$transaction([
        // Clear all Shopify credentials, token metadata, and the shop domain
        // on the Brand. Nulling shopifyShopDomain releases the @unique slot so
        // the same shop can re-install in future. Timestamps are retained as
        // an anonymised audit trail (no personal data). Business records are
        // not touched.
        prisma.brand.update({
          where: { id: brand.id },
          data: {
            shopifyShopDomain: null,
            shopifyAdminAccessTokenEncrypted: null,
            shopifyRefreshTokenEncrypted: null,
            shopifyAccessTokenExpiresAt: null,
            shopifyRefreshTokenExpiresAt: null,
            shopifyGrantedScopes: null,
            shopifyConnectionStatus: "UNINSTALLED",
          },
        }),
        // Anonymize Shopify-specific metadata on redemption rows. Core fields
        // (userId, brandId, offerId, code, pointsCost, status, timestamps) are
        // preserved as SQRATCH financial/points ledger entries.
        // Note: shopifyShopDomain is non-nullable in the schema (String) so it
        // cannot be nulled here; the domain is not personal data per the
        // inventory analysis in docs/shopify-data-inventory.md §5.
        prisma.shopifyRewardRedemption.updateMany({
          where: { shopifyShopDomain: shopDomain },
          data: {
            shopifyDiscountNodeId: null,
            shopifyDiscountStatus: null,
            shopifyUserErrors: Prisma.JsonNull,
          },
        }),
        // Delete any orphaned OAuth state / pending install tokens for this shop.
        prisma.tokenStore.deleteMany({
          where: {
            OR: [
              { service: { startsWith: `shopify_oauth_state:`, contains: shopDomain } },
              { service: { startsWith: `shopify_pending_install:`, contains: shopDomain } },
            ],
          },
        }),
      ]);
    }

    // Sanitized audit log: topic + shop domain (the domain itself is being
    // removed, so logging it here for the final audit trail is appropriate).
    // No customer PII is logged.
    console.log(
      JSON.stringify({
        event: "shopify_webhook",
        topic: "shop/redact",
        shopDomain,
        brandFound: !!brand,
        redactionPerformed: !!brand,
      }),
    );
  }

  return new NextResponse(null, { status: 200 });
}
