import { NextResponse } from "next/server";
import { getBrandManagementContext } from "@/lib/brand-auth";

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
