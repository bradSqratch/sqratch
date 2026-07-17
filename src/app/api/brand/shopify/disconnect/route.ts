import { NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";

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

    const brand = await prisma.brand.update({
      where: { id: context.membership.brand.id },
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

    return NextResponse.json({ data: brand });
  } catch (error) {
    console.error("[brand/shopify/disconnect][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to disconnect Shopify." },
      { status: 500 },
    );
  }
}
