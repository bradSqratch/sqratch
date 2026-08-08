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

export type CreatorAvailableProductsDeps = {
  getAccess(lessonId: string): ReturnType<typeof getLessonProductManagementContext>;
  curationRepository: CampaignCurationRepository;
};

const DEFAULT_DEPS: CreatorAvailableProductsDeps = {
  getAccess: getLessonProductManagementContext,
  curationRepository: defaultCampaignCurationRepository,
};

function publicBrand(
  brand: LessonProductManagementContext["candidateBrands"][number] | null,
) {
  return brand
    ? { id: brand.id, name: brand.name, slug: brand.slug }
    : null;
}

/**
 * The brand of the resolved campaign context. There is deliberately no
 * "primary brand" fallback: `resolveCampaignCuration` only reaches this point
 * with a single unambiguous context, so the brand is the resolved context's
 * brand rather than the first of several.
 */
function brandForContext(
  access: LessonProductManagementContext,
  brandId: string,
) {
  return (
    access.candidateBrands.find((candidate) => candidate.id === brandId) || null
  );
}

export async function GET(
  request: Request,
  context: { params: Promise<{ lessonId: string }> },
) {
  return creatorAvailableProductsGetImpl(request, context);
}

/**
 * Injectable implementation so authorization coverage uses fakes rather than a
 * database.
 *
 * NO CREATOR PICKER MAY CALL LIVE SHOPIFY. The persisted catalog is the only
 * source: this module imports nothing from `@/lib/shopify-products`, so a
 * provider call is not reachable from here even by mistake.
 *
 * The Phase 5 campaign-selection behavior is unchanged: zero eligible contexts
 * -> controlled empty response; exactly one -> auto-resolved; two or more ->
 * explicit `selection_required` with the campaign list and no catalog.
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
            // Every offered context is a canonical commerce context now, so
            // this is always true.
            enabled: true,
            requiresCampaignSelection: true,
            campaigns: resolution.campaigns,
          },
        },
      });
    }

    if (resolution.kind === "none") {
      // No brand-owning campaign at all: there is no catalog to offer and no
      // brand to name. A controlled empty response, never a provider call.
      return NextResponse.json({
        data: {
          brand: null,
          candidateBrandCount: access.data.candidateBrands.length,
          connected: false,
          items: [],
          curation: {
            enabled: false,
            requiresCampaignSelection: false,
            campaigns: [],
          },
        },
      });
    }

    // Exactly one resolved context, reading the persisted canonical catalog
    // through the shared repository.
    const products = await deps.curationRepository.listAuthorizedProducts({
      campaignId: resolution.campaign.campaignId,
      brandId: resolution.campaign.brandId,
    });
    const brand = brandForContext(access.data, resolution.campaign.brandId);

    return NextResponse.json({
      data: {
        brand: publicBrand(brand),
        candidateBrandCount: access.data.candidateBrands.length,
        // A canonical picker reads the persisted catalog and must remain usable
        // after a connection is disconnected. `connected` is kept true to
        // preserve the existing UI gate/response contract.
        connected: true,
        items: products.map(toCreatorCatalogProduct),
        curation: {
          enabled: true,
          campaignId: resolution.campaign.campaignId,
          requiresCampaignSelection: false,
          campaigns: [{
            id: resolution.campaign.campaignId,
            name: resolution.campaign.campaignName,
            brandId: resolution.campaign.brandId,
            brandName: resolution.campaign.brandName,
          }],
        },
      },
    });
  } catch (error) {
    console.error("[creator/lessons/[lessonId]/available-products][GET] Error:", error);
    return NextResponse.json({ error: "Failed to load products." }, { status: 500 });
  }
}
