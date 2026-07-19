import { NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { recordShopifyConnectionLoss } from "@/lib/shopify-connection-transitions";

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

    const brand = await prisma.$transaction(async (tx) => {
      const before = await tx.brand.findUnique({
        where: { id: brandId },
        select: {
          shopifyShopDomain: true,
          shopifyCurrencyCode: true,
          shopifyClientId: true,
        },
      });

      const updated = await tx.brand.update({
        where: { id: brandId },
        data: {
          shopifyShopDomain: null,
          shopifyAdminAccessTokenEncrypted: null,
          shopifyRefreshTokenEncrypted: null,
          shopifyAccessTokenExpiresAt: null,
          shopifyRefreshTokenExpiresAt: null,
          shopifyGrantedScopes: null,
          shopifyClientId: null,
          shopifyTokenRefreshLockedUntil: null,
          shopifyTokenRefreshLockId: null,
          shopifyDisconnectedAt: new Date(),
          shopifyUninstalledAt: null,
          shopifyConnectionStatus: "DISCONNECTED",
        },
        select: {
          id: true,
          shopifyShopDomain: true,
          shopifyInstalledAt: true,
          shopifyDisconnectedAt: true,
          shopifyUninstalledAt: true,
          shopifyConnectionStatus: true,
          shopifyLastProductSyncAt: true,
        },
      });

      await recordShopifyConnectionLoss(tx, {
        brandId,
        eventType: "DISCONNECTED",
        snapshot: {
          shopDomain: before?.shopifyShopDomain ?? null,
          currencyCode: before?.shopifyCurrencyCode ?? null,
          shopifyClientId: before?.shopifyClientId ?? null,
        },
      });

      return updated;
    });

    return NextResponse.json({ data: brand });
  } catch (error) {
    console.error("[brand/shopify/disconnect][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to disconnect Shopify." },
      { status: 500 },
    );
  }
}
