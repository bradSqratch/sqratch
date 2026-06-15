import { NextResponse } from "next/server";
import { getBrandManagementContext } from "@/lib/brand-auth";
import prisma from "@/lib/prisma";

export async function GET() {
  try {
    const context = await getBrandManagementContext();

    if (!context?.membership?.brand) {
      return NextResponse.json(
        { error: "Authorized brand member access required." },
        { status: 403 },
      );
    }

    const brand = context.membership.brand;

    // Fetch the additional fields that brand-auth doesn't include in its select
    const brandExtra = await prisma.brand.findUnique({
      where: { id: brand.id },
      select: {
        shopifyAuthMode: true,
        shopifyAccessTokenExpiresAt: true,
        shopifyGrantedScopes: true,
      },
    });

    const requiresReconnect =
      brand.shopifyConnectionStatus === "REQUIRES_RECONNECT";

    return NextResponse.json({
      data: {
        id: brand.id,
        name: brand.name,
        slug: brand.slug,
        shopifyShopDomain: brand.shopifyShopDomain,
        shopifyInstalledAt: brand.shopifyInstalledAt,
        shopifyDisconnectedAt: brand.shopifyDisconnectedAt,
        shopifyUninstalledAt: brand.shopifyUninstalledAt,
        shopifyConnectionStatus: brand.shopifyConnectionStatus,
        hasShopifyAccessToken: Boolean(
          brand.shopifyAdminAccessTokenEncrypted,
        ),
        shopifyLastProductSyncAt: brand.shopifyLastProductSyncAt,
        shopifyCurrencyCode: brand.shopifyCurrencyCode,
        // Additive fields — token mode and reconnect state
        shopifyAuthMode: brandExtra?.shopifyAuthMode ?? "LEGACY_OFFLINE",
        shopifyAccessTokenExpiresAt: brandExtra?.shopifyAccessTokenExpiresAt ?? null,
        shopifyGrantedScopes: brandExtra?.shopifyGrantedScopes ?? null,
        requiresReconnect,
      },
    });
  } catch (error) {
    console.error("[brand/shopify/status][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load Shopify status." },
      { status: 500 },
    );
  }
}
