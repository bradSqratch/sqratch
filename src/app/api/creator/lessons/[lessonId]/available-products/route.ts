import { NextResponse } from "next/server";
import {
  getLessonProductManagementContext,
} from "@/lib/lesson-product-links";
import { fetchNormalizedShopifyProducts } from "@/lib/shopify-products";
import { isLegacyShopifyBrandConnectionUsable } from "@/lib/commerce/connection-service";

export async function GET(
  _request: Request,
  context: {
    params: Promise<{ lessonId: string }>;
  },
) {
  try {
    const { lessonId } = await context.params;
    const access = await getLessonProductManagementContext(lessonId);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status },
      );
    }

    const brand = access.data.primaryBrand;

    // The `brand.shopifyShopDomain` check is kept alongside the service's
    // connectivity predicate purely so TypeScript can narrow `shopDomain` to
    // a non-null string below — `isLegacyShopifyBrandConnectionUsable`
    // already implies it (see its doc comment), so this is a redundant, safe
    // no-op at runtime, not an extra behavioral condition.
    if (!brand?.shopifyShopDomain || !isLegacyShopifyBrandConnectionUsable(brand)) {
      return NextResponse.json({
        data: {
          brand: brand
            ? {
                id: brand.id,
                name: brand.name,
                slug: brand.slug,
              }
            : null,
          candidateBrandCount: access.data.candidateBrands.length,
          connected: false,
          items: [],
        },
      });
    }

    const products = await fetchNormalizedShopifyProducts({
      shopDomain: brand.shopifyShopDomain,
      brandId: brand.id,
      limit: 100,
    });

    if (!products.ok) {
      return NextResponse.json(
        { error: products.error },
        { status: products.status },
      );
    }

    return NextResponse.json({
      data: {
        brand: {
          id: brand.id,
          name: brand.name,
          slug: brand.slug,
        },
        candidateBrandCount: access.data.candidateBrands.length,
        connected: true,
        items: products.items,
      },
    });
  } catch (error) {
    console.error("[creator/lessons/[lessonId]/available-products][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load Shopify products." },
      { status: 500 },
    );
  }
}
