import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getLessonProductManagementContext,
  loadLessonProductLinks,
  parseLessonProductInput,
  resolveSourceShopDomainForBrand,
} from "@/lib/lesson-product-links";
import { isProductLinkCurrent } from "@/lib/product-link-compatibility";
import { externalAccountIdFromShopDomain } from "@/lib/commerce/connection-service";
import {
  defaultCampaignCurationRepository,
  parseCatalogProductId,
  resolveCampaignCuration,
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

    const items = await loadLessonProductLinks(lessonId);
    const domainByBrandId = new Map(
      access.data.candidateBrands.map((brand) => [
        brand.id,
        externalAccountIdFromShopDomain(brand.shopifyShopDomain),
      ]),
    );

    return NextResponse.json({
      data: {
        brand: access.data.primaryBrand
          ? {
              id: access.data.primaryBrand.id,
              name: access.data.primaryBrand.name,
              slug: access.data.primaryBrand.slug,
            }
          : null,
        candidateBrandCount: access.data.candidateBrands.length,
        // Stale/incompatible links are never hidden here — they're
        // annotated so the creator can see they need relinking rather than
        // silently treating them as current.
        items: items.map((item) => ({
          ...item,
          needsRelinking: !isProductLinkCurrent(item, domainByBrandId),
        })),
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
        // Same controlled response for unavailable, ineligible, unassigned,
        // cross-brand, and invented ids. Never reveal catalog internals.
        return NextResponse.json(
          { error: "Product is not available for this campaign." },
          { status: 404 },
        );
      }

      const existing = await prisma.lessonProductLink.findFirst({
        where: { lessonId, productUrl: product.productUrl },
        select: {
          id: true, lessonId: true, productUrl: true, title: true, imageUrl: true,
          priceText: true, currency: true, brandId: true, sourceShopDomain: true, createdAt: true,
        },
      });
      if (existing) {
        return NextResponse.json({ data: existing });
      }

      const currency = product.currencyCode || null;
      const priceText = formatCatalogProductPrice(product);
      const sourceShopDomain = resolveSourceShopDomainForBrand(
        access.data.candidateBrands,
        product.brandId,
      );
      const created = await prisma.lessonProductLink.create({
        data: {
          lessonId,
          productUrl: product.productUrl,
          title: product.title,
          imageUrl: product.imageUrl,
          priceText,
          currency,
          brandId: product.brandId,
          sourceShopDomain,
        },
        select: {
          id: true, lessonId: true, productUrl: true, title: true, imageUrl: true,
          priceText: true, currency: true, brandId: true, sourceShopDomain: true, createdAt: true,
        },
      });
      return NextResponse.json({ data: created }, { status: 201 });
    }

    // Legacy compatibility mode below: retain its existing client product
    // snapshot contract unchanged.
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

    const existing = await prisma.lessonProductLink.findFirst({
      where: {
        lessonId,
        productUrl: parsed.value.productUrl,
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

    if (existing) {
      return NextResponse.json({ data: existing });
    }

    // Server-derived from the resolved brand's current connection state —
    // never trusts a client-provided source domain.
    const sourceShopDomain = resolveSourceShopDomainForBrand(
      access.data.candidateBrands,
      parsed.value.brandId,
    );

    const created = await prisma.lessonProductLink.create({
      data: {
        lessonId,
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

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    console.error("[creator/lessons/[lessonId]/products][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create lesson product link." },
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
    const currency = new Intl.NumberFormat("en-US", {
      style: "currency", currency: product.currencyCode,
    });
    const divisor = 10 ** product.priceMinorUnitExponent;
    const min = currency.format(product.priceMinMinor / divisor);
    const max = currency.format(product.priceMaxMinor / divisor);
    return product.priceMinMinor === product.priceMaxMinor ? min : `${min} - ${max}`;
  } catch { return null; }
}
