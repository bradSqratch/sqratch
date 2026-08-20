import { NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
} from "@/lib/brand-auth";
import { recordShopifyConnectionLoss } from "@/lib/shopify-connection-transitions";
import { invalidateShopifyCredential } from "@/lib/commerce/providers/shopify-credential-store";
import { getActiveCommerceConnection } from "@/lib/commerce/connection-service";
import { CommerceProvider, type Prisma } from "@prisma/client";

export async function POST() {
  try {
    const context = await getBrandManagementContext();

    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    const brandId = context.membership.brand.id;

    // PHASE 14C-A: CANONICAL-ONLY invalidation — no legacy `Brand` read or
    // write. The event snapshot is captured from the canonical connection
    // BEFORE invalidation (while it's still CONNECTED), since
    // `invalidateShopifyCredential`'s `onInvalidated` hook only carries
    // {connectionId, brandId}.
    const preDisconnectSummary = await getActiveCommerceConnection(
      brandId,
      CommerceProvider.SHOPIFY,
    );

    const canonicalInvalidation = await invalidateShopifyCredential({
      brandId,
      status: "DISCONNECTED" as const,
      onInvalidated: async (tx) => {
        await recordShopifyConnectionLoss(tx as Prisma.TransactionClient, {
          brandId,
          eventType: "DISCONNECTED",
          snapshot: {
            shopDomain: preDisconnectSummary?.externalAccountId ?? null,
            currencyCode: preDisconnectSummary?.currencyCode ?? null,
            shopifyClientId: null,
          },
        });
      },
    });

    if (canonicalInvalidation.outcome === "NO_CONNECTION") {
      return NextResponse.json(
        { error: "Shopify is not connected for this brand." },
        { status: 400 },
      );
    }

    return NextResponse.json({
      data: {
        id: brandId,
        shopifyShopDomain: null,
        shopifyInstalledAt: null,
        shopifyUninstalledAt: null,
        shopifyConnectionStatus: "DISCONNECTED" as const,
        shopifyLastProductSyncAt: null,
      },
    });
  } catch (error) {
    console.error("[brand/shopify/disconnect][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to disconnect Shopify." },
      { status: 500 },
    );
  }
}
