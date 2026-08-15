/**
 * Creator lesson product attachments — CANONICAL ONLY.
 *
 * GET reads `CampaignLessonProduct` (active rows for this lesson) and derives
 * every display field from `BrandCommerceProduct -> ConnectedCommerceProduct`.
 * POST writes exactly ONE `CampaignLessonProduct` row. There is no longer any
 * `LessonProductLink` snapshot, no free-form product input, and no live
 * provider call anywhere on this surface.
 *
 * ACCEPTED POST INPUT — the complete list:
 *
 *   { campaignId?: string, catalogProductId: string, displayOrder?: number }
 *
 * (`catalogProductId` is also accepted at `body.product.catalogProductId`, via
 * the shared `parseCatalogProductId`.) `catalogProductId` is an internal
 * SQRATCH `ConnectedCommerceProduct.id`, never a provider id.
 *
 * Everything else a client sends is IGNORED — `productUrl`, `title`,
 * `imageUrl`, `priceText`, `currency`, `brandId`, any Shopify GID, any shop
 * domain. None of them is read, none is persisted, and none can influence
 * authorization: title/price/URL/brand are re-derived server-side from the
 * authorized catalog row, and `brandId` comes from the server-resolved campaign
 * context. `campaignId` is not evidence either — it is only ever validated
 * against the campaigns actually linked to this lesson's Experience.
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getLessonProductManagementContext,
  upsertCampaignLessonProductScope,
} from "@/lib/lesson-product-links";
import {
  CANONICAL_ATTACHMENT_SELECT,
  defaultCampaignCurationRepository,
  parseCatalogProductId,
  parseDisplayOrder,
  projectCanonicalAttachment,
  resolveCampaignCuration,
  toCreatorLessonProductItem,
  type CampaignCurationRepository,
} from "@/lib/commerce/campaign-product-curation";
import type { getLessonProductManagementContext as GetLessonProductManagementContext } from "@/lib/lesson-product-links";

export type CreatorLessonProductMutationDeps = {
  curationRepository: CampaignCurationRepository;
  getAccess: typeof GetLessonProductManagementContext;
};

const DEFAULT_MUTATION_DEPS: CreatorLessonProductMutationDeps = {
  curationRepository: defaultCampaignCurationRepository,
  getAccess: getLessonProductManagementContext,
};

export async function GET(
  _request: NextRequest,
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

    const rows = await prisma.campaignLessonProduct.findMany({
      where: { lessonId, isActive: true },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "desc" }],
      select: CANONICAL_ATTACHMENT_SELECT,
    });

    // `brand` is populated only when this Experience has exactly ONE eligible
    // campaign context. With two or more, there is no "the brand" to report —
    // reporting the first one is the guess this phase removes. The selector
    // list is what a caller uses in that case.
    const soleContext =
      access.data.campaignContexts.length === 1
        ? access.data.campaignContexts[0]
        : null;
    const soleBrand = soleContext
      ? access.data.candidateBrands.find(
          (candidate) => candidate.id === soleContext.brandId,
        ) || null
      : null;

    return NextResponse.json({
      data: {
        brand: soleBrand
          ? {
              id: soleBrand.id,
              name: soleBrand.name,
              slug: soleBrand.slug,
            }
          : null,
        candidateBrandCount: access.data.candidateBrands.length,
        campaignContexts: access.data.campaignContexts.map((context) => ({
          campaignId: context.campaignId,
          campaignName: context.campaignName,
          brandId: context.brandId,
          brandName: context.brandName,
        })),
        items: rows.map(projectCanonicalAttachment),
      },
    });
  } catch (error) {
    console.error("[creator/lessons/[lessonId]/products][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load lesson products." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ lessonId: string }>;
  },
) {
  return creatorLessonProductsPostImpl(request, context);
}

export async function creatorLessonProductsPostImpl(
  request: NextRequest,
  context: { params: Promise<{ lessonId: string }> },
  overrides: Partial<CreatorLessonProductMutationDeps> = {},
) {
  const deps = { ...DEFAULT_MUTATION_DEPS, ...overrides };
  try {
    const { lessonId } = await context.params;
    const access = await deps.getAccess(lessonId);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status },
      );
    }

    const body = await request.json().catch(() => null);
    const bodyRecord = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
    const requestedCampaignId = typeof bodyRecord?.campaignId === "string"
      ? bodyRecord.campaignId.trim() || null
      : null;
    const curation = resolveCampaignCuration(
      access.data.campaigns,
      requestedCampaignId,
    );

    if (curation.kind === "invalid_campaign") {
      return NextResponse.json(
        { error: "Campaign is not available for this lesson." },
        { status: 404 },
      );
    }

    if (curation.kind === "selection_required") {
      // Ambiguity is an explicit API state. Never proceed with a guessed
      // campaign/brand — that is what let a co-sponsoring brand capture a
      // shared Experience.
      return NextResponse.json(
        {
          error: "Select a campaign before linking products.",
          campaigns: curation.campaigns,
        },
        { status: 400 },
      );
    }

    if (curation.kind === "none") {
      // No eligible campaign is linked to this Experience, so there is no
      // commerce context and no free-form attach to fall back to.
      return NextResponse.json(
        { error: "This lesson has no sponsoring campaign that can provide products." },
        { status: 400 },
      );
    }

    // Every eligible context is handled by the SAME code path: authorization
    // is the repository's strict server-side chain (active assignment,
    // same-brand, isCampaignEligible, isAvailable).
    const campaign = curation.campaign;

    const catalogProductId = parseCatalogProductId(body);
    if (!catalogProductId) {
      return NextResponse.json(
        { error: "catalogProductId is required for this campaign." },
        { status: 400 },
      );
    }

    // The complete authorization chain, re-derived server-side:
    // Lesson -> Course -> Experience -> CampaignExperience -> Campaign ->
    // Brand -> CampaignCommerceProduct -> BrandCommerceProduct ->
    // ConnectedCommerceProduct. `access` proves the first half (this creator
    // owns the lesson, and this campaign is actually linked to its
    // Experience); `findAuthorizedProduct` proves the second half (active
    // assignment, same brand, isCampaignEligible, isAvailable, valid
    // connection ownership).
    const product = await deps.curationRepository.findAuthorizedProduct({
      campaignId: campaign.campaignId,
      brandId: campaign.brandId,
      catalogProductId,
    });
    if (!product) {
      // Same controlled response for unavailable, ineligible, unassigned,
      // cross-brand, curation-disabled, and invented ids. Never reveal catalog
      // internals.
      return NextResponse.json(
        { error: "Product is not available for this campaign." },
        { status: 404 },
      );
    }

    // Exactly one row. Upserting on the unique tuple reactivates a previously
    // deactivated attachment instead of duplicating it, and makes a repeat
    // attach idempotent.
    const attachment = await prisma.$transaction(async (tx) =>
      upsertCampaignLessonProductScope(tx, {
        campaignId: campaign.campaignId,
        brandId: campaign.brandId,
        lessonId,
        brandCommerceProductId: product.brandCommerceProductId,
        displayOrder: parseDisplayOrder(body),
      }),
    );

    return NextResponse.json(
      {
        data: toCreatorLessonProductItem({
          attachment: {
            id: attachment.id,
            lessonId: attachment.lessonId,
            brandId: campaign.brandId,
            displayOrder: attachment.displayOrder,
            createdAt: attachment.createdAt,
          },
          campaign: {
            id: campaign.campaignId,
            name: campaign.campaignName,
            brandName: campaign.brandName,
          },
          product,
        }),
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[creator/lessons/[lessonId]/products][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create lesson product link." },
      { status: 500 },
    );
  }
}
