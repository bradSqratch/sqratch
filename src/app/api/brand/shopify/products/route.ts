import { NextResponse } from "next/server";
import { getBrandAdminContext } from "@/lib/brand-auth";
import { decryptSecret } from "@/lib/crypto";
import prisma from "@/lib/prisma";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

type ShopifyProductImage = {
  src: string | null;
};

type ShopifyProductVariant = {
  id: number | string;
  price: string | null;
};

type ShopifyProduct = {
  id: number | string;
  title: string;
  handle: string;
  images?: ShopifyProductImage[];
  variants?: ShopifyProductVariant[];
};

type ShopifyProductsResponse = {
  products?: ShopifyProduct[];
  errors?: string | string[] | Record<string, string>;
};

export async function GET() {
  try {
    const context = await getBrandAdminContext();

    if (!context?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const brand = context.membership.brand;

    if (
      !brand.shopifyShopDomain ||
      !brand.shopifyStorefrontAccessTokenEncrypted
    ) {
      return NextResponse.json(
        { error: "Shopify is not connected for this brand." },
        { status: 400 },
      );
    }

    const accessToken = decryptSecret(brand.shopifyStorefrontAccessTokenEncrypted);
    const response = await fetch(
      `https://${brand.shopifyShopDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=100`,
      {
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
        },
      },
    );

    const json = (await response.json().catch(() => null)) as
      | ShopifyProductsResponse
      | null;

    if (!response.ok || !json?.products) {
      return NextResponse.json(
        { error: json?.errors || "Failed to fetch Shopify products." },
        { status: response.status || 500 },
      );
    }

    await prisma.brand.update({
      where: { id: brand.id },
      data: {
        shopifyLastProductSyncAt: new Date(),
      },
    });

    return NextResponse.json({
      data: json.products.map((product) => {
        const prices = (product.variants || [])
          .map((variant) => Number(variant.price || 0))
          .filter((price) => Number.isFinite(price));
        const minPrice = prices.length ? Math.min(...prices) : null;
        const maxPrice = prices.length ? Math.max(...prices) : null;

        return {
          id: product.id,
          title: product.title,
          handle: product.handle,
          productUrl: `https://${brand.shopifyShopDomain}/products/${product.handle}`,
          images: (product.images || [])
            .map((image) => image.src)
            .filter((src): src is string => Boolean(src)),
          priceRange: {
            min: minPrice,
            max: maxPrice,
          },
          variantIds: (product.variants || []).map((variant) => variant.id),
        };
      }),
    });
  } catch (error) {
    console.error("[brand/shopify/products][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load Shopify products." },
      { status: 500 },
    );
  }
}
