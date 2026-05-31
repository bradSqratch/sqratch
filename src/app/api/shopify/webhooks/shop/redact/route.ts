import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { verifyShopifyWebhookRequest } from "@/lib/shopify-webhooks";

export async function POST(request: NextRequest) {
  const verification = await verifyShopifyWebhookRequest(request);

  if (!verification.ok) {
    return verification.response;
  }

  if (verification.shop) {
    await prisma.brand.updateMany({
      where: {
        shopifyShopDomain: verification.shop,
      },
      data: {
        shopifyAdminAccessTokenEncrypted: null,
        shopifyConnectionStatus: "UNINSTALLED",
        shopifyUninstalledAt: new Date(),
        shopifyDisconnectedAt: null,
      },
    });
  }

  return new NextResponse(null, { status: 200 });
}
