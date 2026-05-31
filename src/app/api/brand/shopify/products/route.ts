import { NextResponse } from "next/server";
import { getBrandManagementContext } from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { fetchNormalizedShopifyProducts } from "@/lib/shopify-products";

export async function GET() {
  try {
    const context = await getBrandManagementContext();

    if (!context?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const brand = context.membership.brand;

    if (
      !brand.shopifyShopDomain ||
      !brand.shopifyAdminAccessTokenEncrypted ||
      brand.shopifyConnectionStatus !== "CONNECTED"
    ) {
      return NextResponse.json(
        { error: "Shopify is not connected for this brand." },
        { status: 400 },
      );
    }

    const products = await fetchNormalizedShopifyProducts({
      shopDomain: brand.shopifyShopDomain,
      encryptedToken: brand.shopifyAdminAccessTokenEncrypted,
      limit: 100,
    });

    if (!products.ok) {
      return NextResponse.json(
        { error: products.error },
        { status: products.status },
      );
    }

    await prisma.brand.update({
      where: { id: brand.id },
      data: {
        shopifyLastProductSyncAt: new Date(),
        shopifyConnectionStatus: "CONNECTED",
      },
    });

    return NextResponse.json({
      data: products.items.map((product) => ({
        id: product.id,
        title: product.title,
        handle: product.handle,
        productUrl: product.productUrl,
        images: product.images,
        priceRange: product.priceRange,
        variantIds: product.variantIds,
      })),
      meta: {
        hasNextPage: products.hasNextPage,
        limit: products.limit,
      },
    });
  } catch (error) {
    console.error("[brand/shopify/products][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load Shopify products." },
      { status: 500 },
    );
  }
}
