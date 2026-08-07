import { NextResponse } from "next/server";
import {
  defaultCampaignCurationRepository,
  resolveCampaignCuration,
  toCreatorCatalogProduct,
  type CampaignCurationRepository,
} from "@/lib/commerce/campaign-product-curation";
import {
  getLessonProductManagementContext,
  type LessonProductManagementContext,
} from "@/lib/lesson-product-links";
import { fetchNormalizedShopifyProducts } from "@/lib/shopify-products";
import { isLegacyShopifyBrandConnectionUsable } from "@/lib/commerce/connection-service";

export type CreatorAvailableProductsDeps = {
  getAccess(lessonId: string): ReturnType<typeof getLessonProductManagementContext>;
  curationRepository: CampaignCurationRepository;
  fetchLegacyProducts: typeof fetchNormalizedShopifyProducts;
};

const DEFAULT_DEPS: CreatorAvailableProductsDeps = {
  getAccess: getLessonProductManagementContext,
  curationRepository: defaultCampaignCurationRepository,
  fetchLegacyProducts: fetchNormalizedShopifyProducts,
};

function publicBrand(brand: LessonProductManagementContext["primaryBrand"]) {
  return brand
    ? { id: brand.id, name: brand.name, slug: brand.slug }
    : null;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ lessonId: string }> },
) {
  return creatorAvailableProductsGetImpl(request, context);
}

/**
 * Injectable implementation so authorization coverage uses fakes rather than
 * a database. The compatibility (legacy) branch intentionally retains the
 * exact pre-Phase-4 response and live-Shopify call path.
 */
export async function creatorAvailableProductsGetImpl(
  request: Request,
  context: { params: Promise<{ lessonId: string }> },
  overrides: Partial<CreatorAvailableProductsDeps> = {},
) {
  const deps = { ...DEFAULT_DEPS, ...overrides };
  try {
    const { lessonId } = await context.params;
    const access = await deps.getAccess(lessonId);

    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const requestedCampaignId = new URL(request.url).searchParams.get("campaignId");
    const resolution = resolveCampaignCuration(access.data.campaigns, requestedCampaignId);

    if (resolution.kind === "invalid_campaign") {
      // Do not reveal whether an arbitrary campaign exists outside this
      // Experience; only membership in the server-resolved relation matters.
      return NextResponse.json({ error: "Campaign is not available for this lesson." }, { status: 404 });
    }

    if (resolution.kind === "selection_required") {
      return NextResponse.json({
        data: {
          brand: null,
          candidateBrandCount: access.data.candidateBrands.length,
          connected: true,
          items: [],
          curation: {
            enabled: true,
            requiresCampaignSelection: true,
            campaigns: resolution.campaigns,
          },
        },
      });
    }

    if (resolution.kind === "curated") {
      const products = await deps.curationRepository.listAuthorizedProducts({
        campaignId: resolution.campaign.id,
        brandId: resolution.campaign.brandId,
      });
      const brand = access.data.candidateBrands.find(
        (candidate) => candidate.id === resolution.campaign.brandId,
      ) || null;

      return NextResponse.json({
        data: {
          brand: publicBrand(brand),
          candidateBrandCount: access.data.candidateBrands.length,
          // A curated picker reads the persisted catalog and must remain
          // usable after a connection is disconnected. `connected` is kept
          // true to preserve the existing UI gate/response contract.
          connected: true,
          items: products.map(toCreatorCatalogProduct),
          curation: {
            enabled: true,
            campaignId: resolution.campaign.id,
            requiresCampaignSelection: false,
            campaigns: [{
              id: resolution.campaign.id,
              name: resolution.campaign.name,
              brandId: resolution.campaign.brandId,
            }],
          },
        },
      });
    }

    // Legacy compatibility mode begins here. Do not add curation fields,
    // alter item ids, or change the current connected-brand behavior.
    const brand = access.data.primaryBrand;
    if (!brand?.shopifyShopDomain || !isLegacyShopifyBrandConnectionUsable(brand)) {
      return NextResponse.json({
        data: {
          brand: publicBrand(brand),
          candidateBrandCount: access.data.candidateBrands.length,
          connected: false,
          items: [],
        },
      });
    }

    const products = await deps.fetchLegacyProducts({
      shopDomain: brand.shopifyShopDomain,
      brandId: brand.id,
      limit: 100,
    });

    if (!products.ok) {
      return NextResponse.json({ error: products.error }, { status: products.status });
    }

    return NextResponse.json({
      data: {
        brand: publicBrand(brand),
        candidateBrandCount: access.data.candidateBrands.length,
        connected: true,
        items: products.items,
      },
    });
  } catch (error) {
    console.error("[creator/lessons/[lessonId]/available-products][GET] Error:", error);
    return NextResponse.json({ error: "Failed to load Shopify products." }, { status: 500 });
  }
}
