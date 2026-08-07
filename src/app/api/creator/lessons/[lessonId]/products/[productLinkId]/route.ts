import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getLessonProductManagementContext,
  parseLessonProductInput,
  resolveSourceShopDomainForBrand,
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
        { error: "Select a campaign before linking products." },
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
        campaignId: curation.campaign.id,
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
      const updated = await prisma.lessonProductLink.update({
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
      return NextResponse.json({ data: updated });
    }

    // Legacy compatibility mode below: preserve its request/snapshot contract.
    const parsed = parseLessonProductInput(body, {
      defaultBrandId: access.data.primaryBrand?.id || null,
      allowedBrandIds: access.data.candidateBrands.map((brand) => brand.id),
    });

    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error },
        { status: 400 },
      );
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

    const updated = await prisma.lessonProductLink.update({
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

    await prisma.lessonProductLink.delete({
      where: {
        id: productLinkId,
      },
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
