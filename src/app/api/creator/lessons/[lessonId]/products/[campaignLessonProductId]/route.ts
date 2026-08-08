/**
 * One canonical lesson product attachment — replace (PATCH) and remove
 * (DELETE).
 *
 * The route segment is `[campaignLessonProductId]` because that is exactly
 * what the id addresses: a `CampaignLessonProduct` row. It was previously named
 * `[productLinkId]` when it addressed a `LessonProductLink` snapshot; leaving
 * the old name after the cutover would have been an invitation to a future bug.
 *
 * ACCEPTED PATCH INPUT — the complete list:
 *
 *   { campaignId?: string, catalogProductId: string, displayOrder?: number }
 *
 * Same contract as POST on the parent route: `catalogProductId` is an internal
 * SQRATCH `ConnectedCommerceProduct.id`; every other client-supplied field
 * (`productUrl`, `title`, `imageUrl`, `priceText`, `currency`, `brandId`, any
 * provider GID, any shop domain) is ignored, never persisted, and can never
 * influence authorization.
 *
 * PHASE 4 GUARANTEE PRESERVED: an attachment that already exists stays visible
 * and removable even after its underlying product becomes ineligible,
 * unavailable, or deactivated. DELETE therefore never consults product
 * eligibility at all, and PATCH only re-validates the REPLACEMENT product the
 * caller explicitly asked for.
 */
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  deactivateCampaignLessonProduct,
  getLessonProductManagementContext,
  upsertCampaignLessonProductScope,
} from "@/lib/lesson-product-links";
import {
  defaultCampaignCurationRepository,
  parseCatalogProductId,
  parseDisplayOrder,
  resolveCampaignCuration,
  toCreatorLessonProductItem,
  type CampaignCurationRepository,
} from "@/lib/commerce/campaign-product-curation";
import type { getLessonProductManagementContext as GetLessonProductManagementContext } from "@/lib/lesson-product-links";

export type CreatorLessonProductPatchDeps = {
  curationRepository: CampaignCurationRepository;
  getAccess: typeof GetLessonProductManagementContext;
  /**
   * Confirms the addressed attachment is an ACTIVE row belonging to THIS
   * lesson. Scoped by lessonId in the query itself so a foreign id fails
   * closed with the same generic 404 as a nonexistent one.
   */
  findExisting(lessonId: string, campaignLessonProductId: string): Promise<boolean>;
};

const DEFAULT_PATCH_DEPS: CreatorLessonProductPatchDeps = {
  curationRepository: defaultCampaignCurationRepository,
  getAccess: getLessonProductManagementContext,
  findExisting: async (lessonId, campaignLessonProductId) => {
    const existing = await prisma.campaignLessonProduct.findFirst({
      where: { id: campaignLessonProductId, lessonId, isActive: true },
      select: { id: true },
    });
    return existing !== null;
  },
};

export async function PATCH(
  request: NextRequest,
  context: {
    params: Promise<{ lessonId: string; campaignLessonProductId: string }>;
  },
) {
  return creatorLessonProductPatchImpl(request, context);
}

export async function creatorLessonProductPatchImpl(
  request: NextRequest,
  context: { params: Promise<{ lessonId: string; campaignLessonProductId: string }> },
  overrides: Partial<CreatorLessonProductPatchDeps> = {},
) {
  const deps = { ...DEFAULT_PATCH_DEPS, ...overrides };
  try {
    const { lessonId, campaignLessonProductId } = await context.params;
    const access = await deps.getAccess(lessonId);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status },
      );
    }

    if (!await deps.findExisting(lessonId, campaignLessonProductId)) {
      return NextResponse.json(
        { error: "Lesson product link not found." },
        { status: 404 },
      );
    }

    const body = await request.json().catch(() => null);
    const bodyRecord = body && typeof body === "object" && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
    const requestedCampaignId = typeof bodyRecord?.campaignId === "string"
      ? bodyRecord.campaignId.trim() || null
      : null;
    const curation = resolveCampaignCuration(access.data.campaigns, requestedCampaignId);

    if (curation.kind === "invalid_campaign") {
      return NextResponse.json(
        { error: "Campaign is not available for this lesson." },
        { status: 404 },
      );
    }
    if (curation.kind === "selection_required") {
      return NextResponse.json(
        {
          error: "Select a campaign before linking products.",
          campaigns: curation.campaigns,
        },
        { status: 400 },
      );
    }
    if (curation.kind === "none") {
      return NextResponse.json(
        { error: "This lesson has no sponsoring campaign that can provide products." },
        { status: 400 },
      );
    }

    // See the POST route: every eligible context shares this one path, and
    // the repository's authorization chain is what decides. A replacement is a
    // NEW attachment and therefore fails closed exactly like an attach.
    const campaign = curation.campaign;

    const catalogProductId = parseCatalogProductId(body);
    if (!catalogProductId) {
      return NextResponse.json(
        { error: "catalogProductId is required for this campaign." },
        { status: 400 },
      );
    }

    const product = await deps.curationRepository.findAuthorizedProduct({
      campaignId: campaign.campaignId,
      brandId: campaign.brandId,
      catalogProductId,
    });
    if (!product) {
      return NextResponse.json(
        { error: "Product is not available for this campaign." },
        { status: 404 },
      );
    }

    const displayOrder = parseDisplayOrder(body);

    // The replacement and the retirement of the row it replaces are one atomic
    // unit. Upsert first: when the requested product resolves to the SAME
    // tuple as the addressed row, the upsert returns that same id and the
    // deactivation below is skipped, so replacing a product with itself is a
    // no-op rather than a self-deactivation.
    const attachment = await prisma.$transaction(async (tx) => {
      const upserted = await upsertCampaignLessonProductScope(tx, {
        campaignId: campaign.campaignId,
        brandId: campaign.brandId,
        lessonId,
        brandCommerceProductId: product.brandCommerceProductId,
        displayOrder,
      });

      if (upserted.id !== campaignLessonProductId) {
        await deactivateCampaignLessonProduct(tx, {
          lessonId,
          campaignLessonProductId,
        });
      }

      return upserted;
    });

    return NextResponse.json({
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
    });
  } catch (error) {
    console.error(
      "[creator/lessons/[lessonId]/products/[campaignLessonProductId]][PATCH] Error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to update lesson product link." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  context: {
    params: Promise<{ lessonId: string; campaignLessonProductId: string }>;
  },
) {
  try {
    const { lessonId, campaignLessonProductId } = await context.params;
    const access = await getLessonProductManagementContext(lessonId);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status },
      );
    }

    // Deactivation, never deletion: the campaign-scoped attribution history on
    // this row cannot be re-derived. The single lesson-scoped predicate means a
    // foreign or nonexistent id both produce the SAME generic 404, so the
    // response never reveals that some other lesson owns that id. No product
    // eligibility is consulted, which is what keeps an already-attached row
    // removable after its product becomes ineligible or unavailable.
    const removed = await prisma.$transaction(async (tx) =>
      deactivateCampaignLessonProduct(tx, {
        lessonId,
        campaignLessonProductId,
      }),
    );

    if (!removed) {
      return NextResponse.json(
        { error: "Lesson product link not found." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      data: {
        id: campaignLessonProductId,
      },
    });
  } catch (error) {
    console.error(
      "[creator/lessons/[lessonId]/products/[campaignLessonProductId]][DELETE] Error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to remove lesson product link." },
      { status: 500 },
    );
  }
}
