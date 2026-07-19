import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { verifyShopifyWebhookRequest } from "@/lib/shopify-webhooks";
import { recordShopifyConnectionLoss } from "@/lib/shopify-connection-transitions";

// Shopify sends app/uninstalled immediately when a merchant uninstalls.
// Per the relink policy: credentials are cleared but shopifyShopDomain is
// PRESERVED so that reinstallation to the same brand is seamless (the domain
// acts as the stable relink key). Shopify will send shop/redact 48 h later if
// the merchant does not reinstall, at which point the domain is also nulled.
export async function POST(request: NextRequest) {
  const verification = await verifyShopifyWebhookRequest(request);

  if (!verification.ok) {
    return verification.response;
  }

  if (verification.shop) {
    const shopDomain = verification.shop;

    await prisma.$transaction(async (tx) => {
      const brand = await tx.brand.findUnique({
        where: { shopifyShopDomain: shopDomain },
        select: { id: true, shopifyCurrencyCode: true, shopifyClientId: true },
      });

      if (!brand) {
        return;
      }

      await tx.brand.update({
        where: { id: brand.id },
        data: {
          // Clear all credential and token fields immediately on uninstall.
          shopifyAdminAccessTokenEncrypted: null,
          shopifyRefreshTokenEncrypted: null,
          shopifyAccessTokenExpiresAt: null,
          shopifyRefreshTokenExpiresAt: null,
          shopifyGrantedScopes: null,
          // Mark as UNINSTALLED and record the time. shopifyShopDomain is
          // intentionally NOT nulled here — it is retained for seamless
          // reinstall-to-same-brand relink semantics.
          shopifyConnectionStatus: "UNINSTALLED",
          shopifyUninstalledAt: new Date(),
          shopifyDisconnectedAt: null,
        },
      });

      await recordShopifyConnectionLoss(tx, {
        brandId: brand.id,
        eventType: "UNINSTALLED",
        snapshot: {
          shopDomain,
          currencyCode: brand.shopifyCurrencyCode,
          shopifyClientId: brand.shopifyClientId,
        },
      });
    });

    // Sanitized audit log: topic + shop domain only — no secrets or PII.
    console.log(
      JSON.stringify({
        event: "shopify_webhook",
        topic: "app/uninstalled",
        shopDomain,
      }),
    );
  }

  return new NextResponse(null, { status: 200 });
}
