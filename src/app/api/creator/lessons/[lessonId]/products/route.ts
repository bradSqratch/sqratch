import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  assertProductUrlMatchesBrandDomain,
  findBrandCommerceProductIdForProductUrl,
  getLessonProductManagementContext,
  loadLessonProductLinks,
  parseLessonProductInput,
  resolveSourceShopDomainForBrand,
  upsertCampaignLessonProductScope,
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
          mode: context.mode,
        })),
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
          campaignProductLink: { select: { campaignId: true, brandCommerceProductId: true } },
        },
      });
      if (existing) {
        const sameScope = existing.campaignProductLink?.campaignId === curation.campaign.campaignId &&
          existing.campaignProductLink.brandCommerceProductId === product.brandCommerceProductId;
        if (sameScope) {
          // Idempotent reattach under the same authorization context.
          await prisma.$transaction(async (tx) => {
            await upsertCampaignLessonProductScope(tx, {
              campaignId: curation.campaign.campaignId,
              brandId: curation.campaign.brandId,
              lessonId,
              brandCommerceProductId: product.brandCommerceProductId,
              legacyLessonProductLinkId: existing.id,
            });
          });
          return NextResponse.json({ data: existing });
        }

        // One snapshot has one scope. The same catalog product may legitimately
        // occur under a second campaign, so create a second server-derived
        // snapshot instead of an active-but-unrenderable unbound scope.
        const created = await prisma.$transaction(async (tx) => {
          const link = await tx.lessonProductLink.create({
            data: {
              lessonId,
              productUrl: product.productUrl,
              title: product.title,
              imageUrl: product.imageUrl,
              priceText: formatCatalogProductPrice(product),
              currency: product.currencyCode || null,
              brandId: product.brandId,
              sourceShopDomain: resolveSourceShopDomainForBrand(access.data.candidateBrands, product.brandId),
            },
            select: { id: true, lessonId: true, productUrl: true, title: true, imageUrl: true, priceText: true, currency: true, brandId: true, sourceShopDomain: true, createdAt: true },
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
        return NextResponse.json({ data: created }, { status: 201 });
      }

      const currency = product.currencyCode || null;
      const priceText = formatCatalogProductPrice(product);
      const sourceShopDomain = resolveSourceShopDomainForBrand(
        access.data.candidateBrands,
        product.brandId,
      );
      // The snapshot write and its campaign scoping row are one atomic unit:
      // an attachment must never exist half-scoped.
      const created = await prisma.$transaction(async (tx) => {
        const link = await tx.lessonProductLink.create({
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

        await upsertCampaignLessonProductScope(tx, {
          campaignId: curation.campaign.campaignId,
          brandId: curation.campaign.brandId,
          lessonId,
          brandCommerceProductId: product.brandCommerceProductId,
          legacyLessonProductLinkId: link.id,
        });

        return link;
      });
      return NextResponse.json({ data: created }, { status: 201 });
    }

    // Legacy compatibility mode below: retain its existing client product
    // snapshot contract unchanged. `curation.kind` is "legacy" (exactly one
    // eligible context, resolved or explicitly selected) or "none" (this
    // Experience has no brand-owning campaign at all, so no brand may be
    // claimed and the link stays brandless, exactly as before).
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

    // Legacy attach lets the creator supply the URL verbatim, so brand
    // selection alone must not be enough to stamp a competitor's URL with this
    // brand's identity. The URL has to belong to the selected brand's store.
    const domainCheck = await assertProductUrlMatchesBrandDomain({
      productUrl: parsed.value.productUrl,
      brandId: parsed.value.brandId,
      candidateBrands: access.data.candidateBrands,
    });

    if (!domainCheck.ok) {
      return NextResponse.json({ error: domainCheck.error }, { status: 400 });
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

    // A CampaignLessonProduct structurally requires a BrandCommerceProduct,
    // which a legacy attach has no direct handle on. Bind it when the brand's
    // own synced catalog contains this exact URL.
    const legacyBrandCommerceProductId =
      legacyContext && parsed.value.brandId
        ? await findBrandCommerceProductIdForProductUrl({
            brandId: parsed.value.brandId,
            productUrl: parsed.value.productUrl,
          })
        : null;

    // Without a catalog match there is no scoping row, and an unscoped
    // LessonProductLink renders under EVERY campaign on the Experience — the
    // correct reading for genuinely pre-Phase-5 rows that predate campaign
    // scoping, but a leak for a link created today under one specific
    // campaign. So the unscoped fallback is allowed only where there is
    // nothing to leak into: at most one eligible campaign context. Once the
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

    const created = await prisma.$transaction(async (tx) => {
      const link = await tx.lessonProductLink.create({
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
