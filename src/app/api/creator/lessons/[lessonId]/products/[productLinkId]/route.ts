import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  assertProductUrlMatchesBrandDomain,
  detachCampaignLessonProductFromLink,
  findBrandCommerceProductIdForProductUrl,
  getLessonProductManagementContext,
  parseLessonProductInput,
  resolveSourceShopDomainForBrand,
  upsertCampaignLessonProductScope,
} from "@/lib/lesson-product-links";
import {
  defaultCampaignCurationRepository,
  parseCatalogProductId,
  resolveCampaignCuration,
  type CampaignCurationRepository,
} from "@/lib/commerce/campaign-product-curation";
import type { getLessonProductManagementContext as GetLessonProductManagementContext } from "@/lib/lesson-product-links";

export type CreatorLessonProductPatchDeps = {
  curationRepository: CampaignCurationRepository;
  getAccess: typeof GetLessonProductManagementContext;
  findExisting(lessonId: string, productLinkId: string): Promise<boolean>;
};

const DEFAULT_PATCH_DEPS: CreatorLessonProductPatchDeps = {
  curationRepository: defaultCampaignCurationRepository,
  getAccess: getLessonProductManagementContext,
  findExisting: async (lessonId, productLinkId) => {
    const existing = await prisma.lessonProductLink.findFirst({
      where: { id: productLinkId, lessonId },
      select: { id: true },
    });
    return existing !== null;
  },
};

export async function PATCH(
  request: NextRequest,
  context: {
    params: Promise<{ lessonId: string; productLinkId: string }>;
  },
) {
  return creatorLessonProductPatchImpl(request, context);
}

export async function creatorLessonProductPatchImpl(
  request: NextRequest,
  context: { params: Promise<{ lessonId: string; productLinkId: string }> },
  overrides: Partial<CreatorLessonProductPatchDeps> = {},
) {
  const deps = { ...DEFAULT_PATCH_DEPS, ...overrides };
  try {
    const { lessonId, productLinkId } = await context.params;
    const access = await deps.getAccess(lessonId);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status },
      );
    }

    if (!await deps.findExisting(lessonId, productLinkId)) {
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
    if (curation.kind === "curated") {
      const catalogProductId = parseCatalogProductId(body);
      if (!catalogProductId) {
        return NextResponse.json(
          { error: "catalogProductId is required for this campaign." },
          { status: 400 },
        );
      }
      const product = await deps.curationRepository.findAuthorizedProduct({
        campaignId: curation.campaign.campaignId,
        brandId: curation.campaign.brandId,
        catalogProductId,
      });
      if (!product) {
        return NextResponse.json(
          { error: "Product is not available for this campaign." },
          { status: 404 },
        );
      }

      const duplicate = await prisma.lessonProductLink.findFirst({
        where: { lessonId, productUrl: product.productUrl, NOT: { id: productLinkId } },
        select: { id: true },
      });
      if (duplicate) {
        return NextResponse.json(
          { error: "This product is already linked to the lesson." },
          { status: 409 },
        );
      }

      const sourceShopDomain = resolveSourceShopDomainForBrand(
        access.data.candidateBrands,
        product.brandId,
      );
      // Replacing the product means the old scoping row no longer describes
      // this snapshot. Detach/deactivate it and scope the new product, in the
      // same transaction as the snapshot update.
      const updated = await prisma.$transaction(async (tx) => {
        await detachCampaignLessonProductFromLink(tx, {
          legacyLessonProductLinkId: productLinkId,
          keep: {
            campaignId: curation.campaign.campaignId,
            lessonId,
            brandCommerceProductId: product.brandCommerceProductId,
          },
        });

        const link = await tx.lessonProductLink.update({
          where: { id: productLinkId },
          data: {
            productUrl: product.productUrl,
            title: product.title,
            imageUrl: product.imageUrl,
            priceText: formatCatalogProductPrice(product),
            currency: product.currencyCode,
            brandId: product.brandId,
            sourceShopDomain,
          },
          select: {
            id: true, lessonId: true, productUrl: true, title: true, imageUrl: true,
            priceText: true, currency: true, brandId: true, sourceShopDomain: true, createdAt: true,
          },
        });

        await upsertCampaignLessonProductScope(tx, {
          campaignId: curation.campaign.campaignId,
          brandId: curation.campaign.brandId,
          lessonId,
          brandCommerceProductId: product.brandCommerceProductId,
          legacyLessonProductLinkId: link.id,
        });

        return link;
      });
      return NextResponse.json({ data: updated });
    }

    // Legacy compatibility mode below: preserve its request/snapshot contract.
    // See the POST route for why `none` yields an empty allowed-brand list.
    const legacyContext = curation.kind === "legacy" ? curation.campaign : null;
    const parsed = parseLessonProductInput(body, {
      defaultBrandId: legacyContext?.brandId || null,
      allowedBrandIds: legacyContext ? [legacyContext.brandId] : [],
    });

    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error },
        { status: 400 },
      );
    }

    const domainCheck = await assertProductUrlMatchesBrandDomain({
      productUrl: parsed.value.productUrl,
      brandId: parsed.value.brandId,
      candidateBrands: access.data.candidateBrands,
    });

    if (!domainCheck.ok) {
      return NextResponse.json({ error: domainCheck.error }, { status: 400 });
    }

    const duplicate = await prisma.lessonProductLink.findFirst({
      where: {
        lessonId,
        productUrl: parsed.value.productUrl,
        NOT: {
          id: productLinkId,
        },
      },
      select: {
        id: true,
      },
    });

    if (duplicate) {
      return NextResponse.json(
        { error: "This product is already linked to the lesson." },
        { status: 409 },
      );
    }

    // Re-derived from the resolved brand's current connection state on every
    // update — never trusts a client-provided source domain. This is how a
    // stale link becomes current again: editing it re-stamps the domain.
    const sourceShopDomain = resolveSourceShopDomainForBrand(
      access.data.candidateBrands,
      parsed.value.brandId,
    );

    const legacyBrandCommerceProductId =
      legacyContext && parsed.value.brandId
        ? await findBrandCommerceProductIdForProductUrl({
            brandId: parsed.value.brandId,
            productUrl: parsed.value.productUrl,
          })
        : null;

    // Same rule as the POST attach: without a catalog match the replacement
    // link ends up unscoped, and an unscoped LessonProductLink renders under
    // EVERY campaign on the Experience. That is only safe where there is
    // nothing to leak into — at most one eligible campaign context. Once the
    // Experience is ambiguous (two or more), scoping is mandatory and a
    // catalog match is the only thing that can supply it.
    if (
      legacyContext &&
      !legacyBrandCommerceProductId &&
      access.data.campaignContexts.length >= 2
    ) {
      const brandLabel = legacyContext.brandName || "the selected brand";
      return NextResponse.json(
        {
          error: `This product must be synced to ${brandLabel}'s catalog before it can be attached to a lesson with multiple sponsoring campaigns.`,
        },
        { status: 400 },
      );
    }

    const updated = await prisma.$transaction(async (tx) => {
      await detachCampaignLessonProductFromLink(tx, {
        legacyLessonProductLinkId: productLinkId,
        keep:
          legacyContext && legacyBrandCommerceProductId
            ? {
                campaignId: legacyContext.campaignId,
                lessonId,
                brandCommerceProductId: legacyBrandCommerceProductId,
              }
            : null,
      });

      const link = await tx.lessonProductLink.update({
        where: {
          id: productLinkId,
        },
        data: {
          productUrl: parsed.value.productUrl,
          title: parsed.value.title,
          imageUrl: parsed.value.imageUrl,
          priceText: parsed.value.priceText,
          currency: parsed.value.currency,
          brandId: parsed.value.brandId,
          sourceShopDomain,
        },
        select: {
          id: true,
          lessonId: true,
          productUrl: true,
          title: true,
          imageUrl: true,
          priceText: true,
          currency: true,
          brandId: true,
          sourceShopDomain: true,
          createdAt: true,
        },
      });

      if (legacyContext && legacyBrandCommerceProductId) {
        await upsertCampaignLessonProductScope(tx, {
          campaignId: legacyContext.campaignId,
          brandId: legacyContext.brandId,
          lessonId,
          brandCommerceProductId: legacyBrandCommerceProductId,
          legacyLessonProductLinkId: link.id,
        });
      }

      return link;
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error(
      "[creator/lessons/[lessonId]/products/[productLinkId]][PATCH] Error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to update lesson product link." },
      { status: 500 },
    );
  }
}

function formatCatalogProductPrice(product: {
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  priceMinorUnitExponent: number | null;
  currencyCode: string | null;
}): string | null {
  if (
    product.priceMinMinor === null || product.priceMaxMinor === null ||
    product.priceMinorUnitExponent === null || !product.currencyCode ||
    !Number.isInteger(product.priceMinorUnitExponent) ||
    product.priceMinorUnitExponent < 0 || product.priceMinorUnitExponent > 6
  ) return null;
  try {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency", currency: product.currencyCode,
    });
    const divisor = 10 ** product.priceMinorUnitExponent;
    const min = formatter.format(product.priceMinMinor / divisor);
    const max = formatter.format(product.priceMaxMinor / divisor);
    return product.priceMinMinor === product.priceMaxMinor ? min : `${min} - ${max}`;
  } catch { return null; }
}

export async function DELETE(
  _request: NextRequest,
  context: {
    params: Promise<{ lessonId: string; productLinkId: string }>;
  },
) {
  try {
    const { lessonId, productLinkId } = await context.params;
    const access = await getLessonProductManagementContext(lessonId);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status },
      );
    }

    const existing = await prisma.lessonProductLink.findFirst({
      where: {
        id: productLinkId,
        lessonId,
      },
      select: {
        id: true,
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Lesson product link not found." },
        { status: 404 },
      );
    }

    // The FK is ON DELETE SET NULL, which detaches but leaves the scoping row
    // ACTIVE. Per the hand-off documented in migration 20260807140000, the app
    // layer deactivates it in the SAME transaction so an active attachment
    // never points at a null legacy link. The row itself is kept: its
    // campaign-scoped attribution history cannot be re-derived.
    await prisma.$transaction(async (tx) => {
      await detachCampaignLessonProductFromLink(tx, {
        legacyLessonProductLinkId: productLinkId,
        keep: null,
      });

      await tx.lessonProductLink.delete({
        where: {
          id: productLinkId,
        },
      });
    });

    return NextResponse.json({
      data: {
        id: productLinkId,
      },
    });
  } catch (error) {
    console.error(
      "[creator/lessons/[lessonId]/products/[productLinkId]][DELETE] Error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to remove lesson product link." },
      { status: 500 },
    );
  }
}
