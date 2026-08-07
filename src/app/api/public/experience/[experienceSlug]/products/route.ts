import { NextRequest, NextResponse } from "next/server";
import {
  createAnalyticsEvent,
  getExperienceAccessContext,
} from "@/lib/experience-access";
import prisma from "@/lib/prisma";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";
import { fetchNormalizedShopifyProducts } from "@/lib/shopify-products";
import { isProductLinkCurrent } from "@/lib/product-link-compatibility";
import {
  externalAccountIdFromShopDomain,
  isLegacyShopifyBrandConnectionUsable,
} from "@/lib/commerce/connection-service";

type PublicShopProduct = {
  id: string;
  productId: string;
  productLinkId: string | null;
  title: string;
  imageUrl: string | null;
  priceText: string | null;
  productUrl: string;
  brand: {
    id: string;
    name: string;
    slug: string;
  } | null;
  source: "LINKED" | "CAMPAIGN";
  /** Present only for curated campaign catalog products. */
  description?: string | null;
};

type CampaignFallbackBrand = {
  id: string;
  name: string;
  slug: string;
  shopifyShopDomain: string | null;
  shopifyConnectionStatus: string;
  shopifyInstalledAt: Date | null;
  shopifyUninstalledAt: Date | null;
  shopifyLastProductSyncAt: Date | null;
  shopifyGrantedScopes: string | null;
  shopifyCurrencyCode: string | null;
};

type PublicShopAccess = {
  viewer: {
    sessionId: string | null;
    userId: string | null;
  };
  experience: {
    id: string;
    slug: string;
    title: string;
    campaigns: Array<{
      campaignId: string;
      campaign: {
        id: string;
        name: string;
        brand: {
          id: string;
          name: string;
          slug: string;
          logoUrl: string | null;
        } | null;
      };
    }>;
  };
};

type ExperienceProductLinkRow = {
  id: string;
  productUrl: string;
  title: string | null;
  imageUrl: string | null;
  priceText: string | null;
  currency: string | null;
  brandId: string | null;
  sourceShopDomain: string | null;
};

/** A deliberately narrow, public-safe catalog shape. */
export type CuratedCampaignProduct = {
  displayOrder: number;
  titleOverride: string | null;
  shortDescriptionOverride: string | null;
  connectedProduct: {
    id: string;
    brandId: string;
    externalId: string;
    title: string;
    productUrl: string;
    imageUrl: string | null;
    descriptionText: string | null;
    isAvailable: boolean;
    currencyCode: string | null;
    priceMinMinor: number | null;
    priceMaxMinor: number | null;
    priceMinorUnitExponent: number | null;
  };
};

type LegacyCampaignProductsResult = Awaited<
  ReturnType<typeof fetchNormalizedShopifyProducts>
>;

export type PublicExperienceProductsDeps = {
  getAccess(experienceSlug: string, request: NextRequest): Promise<PublicShopAccess | null>;
  ensureSession(options: {
    request: NextRequest;
    userId: string | null;
    campaignId: string | null;
  }): Promise<string>;
  findProductLinks(experienceId: string): Promise<ExperienceProductLinkRow[]>;
  findBrands(brandIds: string[]): Promise<CampaignFallbackBrand[]>;
  /** Counts all selections, including hidden ones: any selection activates curated mode. */
  countBrandSelections(brandId: string): Promise<number>;
  /** Must return only current-brand, visible, available products (see default implementation). */
  findCuratedProducts(brandId: string): Promise<CuratedCampaignProduct[]>;
  fetchLegacyCampaignProducts(options: {
    shopDomain: string;
    brandId: string;
    limit: number;
    currency: string;
  }): Promise<LegacyCampaignProductsResult>;
};

const DEFAULT_DEPS: PublicExperienceProductsDeps = {
  getAccess: getExperienceAccessContext,
  ensureSession: ensureViewerSession,
  findProductLinks(experienceId) {
    return prisma.experienceProductLink.findMany({
      where: { experienceId },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        productUrl: true,
        title: true,
        imageUrl: true,
        priceText: true,
        currency: true,
        brandId: true,
        sourceShopDomain: true,
      },
    });
  },
  findBrands(brandIds) {
    return prisma.brand.findMany({
      where: { id: { in: brandIds } },
      select: {
        id: true,
        name: true,
        slug: true,
        shopifyShopDomain: true,
        shopifyConnectionStatus: true,
        shopifyInstalledAt: true,
        shopifyUninstalledAt: true,
        shopifyLastProductSyncAt: true,
        shopifyGrantedScopes: true,
        shopifyCurrencyCode: true,
      },
    });
  },
  countBrandSelections(brandId) {
    return prisma.brandCommerceProduct.count({ where: { brandId } });
  },
  findCuratedProducts(brandId) {
    return prisma.brandCommerceProduct.findMany({
      // The relation predicate is intentional defense in depth. The schema
      // does not make the two brand ids a composite foreign key, so a bad
      // historical row must never expose another brand's catalog item.
      where: {
        brandId,
        isVisibleInShop: true,
        connectedProduct: { brandId, isAvailable: true },
      },
      orderBy: [
        { displayOrder: "asc" },
        { connectedProduct: { title: "asc" } },
        { connectedProductId: "asc" },
      ],
      select: {
        displayOrder: true,
        titleOverride: true,
        shortDescriptionOverride: true,
        connectedProduct: {
          select: {
            id: true,
            brandId: true,
            externalId: true,
            title: true,
            productUrl: true,
            imageUrl: true,
            descriptionText: true,
            isAvailable: true,
            currencyCode: true,
            priceMinMinor: true,
            priceMaxMinor: true,
            priceMinorUnitExponent: true,
          },
        },
      },
    });
  },
  fetchLegacyCampaignProducts: fetchNormalizedShopifyProducts,
};

export type PublicExperienceProductsPostDeps = {
  getAccess(experienceSlug: string, request: NextRequest): Promise<PublicShopAccess | null>;
  ensureSession(options: {
    request: NextRequest;
    userId: string | null;
    campaignId: string | null;
  }): Promise<string>;
  findViewerSession(sessionId: string): Promise<{
    qrCodeId: string | null;
    qrCode: { batchId: string | null } | null;
  } | null>;
  createAnalyticsEvent: typeof createAnalyticsEvent;
};

const DEFAULT_POST_DEPS: PublicExperienceProductsPostDeps = {
  getAccess: getExperienceAccessContext,
  ensureSession: ensureViewerSession,
  findViewerSession(sessionId) {
    return prisma.userSession.findUnique({
      where: { id: sessionId },
      select: {
        qrCodeId: true,
        qrCode: { select: { batchId: true } },
      },
    });
  },
  createAnalyticsEvent,
};

function formatPersistedPrice(product: CuratedCampaignProduct["connectedProduct"]): string | null {
  const { priceMinMinor, priceMaxMinor, priceMinorUnitExponent, currencyCode } = product;
  if (
    priceMinMinor === null ||
    priceMaxMinor === null ||
    !currencyCode ||
    priceMinorUnitExponent === null ||
    !Number.isInteger(priceMinorUnitExponent) ||
    priceMinorUnitExponent < 0 ||
    priceMinorUnitExponent > 6
  ) {
    return null;
  }

  try {
    const divisor = 10 ** priceMinorUnitExponent;
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
    });
    const min = formatter.format(priceMinMinor / divisor);
    const max = formatter.format(priceMaxMinor / divisor);
    return priceMinMinor === priceMaxMinor ? min : `${min} - ${max}`;
  } catch {
    return null;
  }
}

function logCampaignFallbackIssue(options: {
  experienceSlug: string;
  experienceId: string;
  directProductCount: number;
  fallbackProductCount: number;
  primaryBrand: CampaignFallbackBrand | null;
  reason: string;
  tokenReason?: string;
}) {
  console.warn("[public/experience/products][GET] Campaign fallback skipped:", {
    experienceSlug: options.experienceSlug,
    experienceId: options.experienceId,
    directProductCount: options.directProductCount,
    fallbackProductCount: options.fallbackProductCount,
    primaryBrand: options.primaryBrand
      ? {
          id: options.primaryBrand.id,
          name: options.primaryBrand.name,
        }
      : null,
    shopifyConnectionStatus:
      options.primaryBrand?.shopifyConnectionStatus || null,
    reason: options.reason,
    tokenResultReason: options.tokenReason || null,
  });
}

function logPublicShopProductResult(options: {
  experienceSlug: string;
  experienceId: string;
  directProductCount: number;
  fallbackProductCount: number;
  primaryBrand: CampaignFallbackBrand | null;
}) {
  console.info("[public/experience/products][GET] Products loaded:", {
    experienceSlug: options.experienceSlug,
    experienceId: options.experienceId,
    directProductCount: options.directProductCount,
    fallbackProductCount: options.fallbackProductCount,
    primaryBrand: options.primaryBrand
      ? {
          id: options.primaryBrand.id,
          name: options.primaryBrand.name,
          shopifyConnectionStatus: options.primaryBrand.shopifyConnectionStatus,
        }
      : null,
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
) {
  return publicExperienceProductsGetImpl(request, context);
}

export async function publicExperienceProductsGetImpl(
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
  overrides: Partial<PublicExperienceProductsDeps> = {},
) {
  const deps: PublicExperienceProductsDeps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const { experienceSlug } = await context.params;
    const access = await deps.getAccess(experienceSlug, request);

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const primaryCampaign = access.experience.campaigns[0];
    const sessionId =
      access.viewer.sessionId ||
      (await deps.ensureSession({
        request,
        userId: access.viewer.userId,
        campaignId: primaryCampaign?.campaignId || null,
      }));

    const productLinks = await deps.findProductLinks(access.experience.id);

    const candidateBrandIds = new Set<string>();
    productLinks.forEach((link) => {
      if (link.brandId) {
        candidateBrandIds.add(link.brandId);
      }
    });
    access.experience.campaigns.forEach((campaignLink) => {
      if (campaignLink.campaign.brand?.id) {
        candidateBrandIds.add(campaignLink.campaign.brand.id);
      }
    });

    const brands = candidateBrandIds.size
      ? await deps.findBrands(Array.from(candidateBrandIds))
      : [];

    const brandMap = new Map(brands.map((brand) => [brand.id, brand]));
    const primaryBrand = primaryCampaign?.campaign.brand?.id
      ? brandMap.get(primaryCampaign.campaign.brand.id) || null
      : null;

    // A stored direct link is current only when its sourceShopDomain matches
    // its brand's current Shopify domain. Stale/unknown-source links are
    // treated as absent here (never deleted) so they don't suppress the
    // campaign-products fallback below.
    const domainByBrandId = new Map(
      brands.map((brand) => [brand.id, externalAccountIdFromShopDomain(brand.shopifyShopDomain)]),
    );
    const currentProductLinks = productLinks.filter((link) =>
      isProductLinkCurrent(link, domainByBrandId),
    );

    const linkedProducts: PublicShopProduct[] = currentProductLinks.map((link) => {
      const linkedBrand =
        (link.brandId ? brandMap.get(link.brandId) : null) || primaryBrand;

      return {
        id: link.id,
        productId: link.id,
        productLinkId: link.id,
        title: link.title || "Shop product",
        imageUrl: link.imageUrl,
        priceText: link.priceText,
        productUrl: link.productUrl,
        brand: linkedBrand
          ? {
              id: linkedBrand.id,
              name: linkedBrand.name,
              slug: linkedBrand.slug,
            }
          : null,
        source: "LINKED",
      };
    });

    let campaignProducts: PublicShopProduct[] = [];
    let usesCuratedCatalog = false;

    if (linkedProducts.length === 0 && primaryBrand) {
      // A single selection (even a hidden one) switches the brand to the
      // persisted catalog. This preserves the legacy live-Shopify path for
      // unmigrated brands while allowing a brand to intentionally publish an
      // empty shop by hiding every selected product.
      const selectionCount = await deps.countBrandSelections(primaryBrand.id);

      if (selectionCount > 0) {
        usesCuratedCatalog = true;
        const curatedProducts = (await deps.findCuratedProducts(primaryBrand.id))
          // The database query above enforces these predicates. Keeping them
          // at the serialization boundary too makes the public contract safe
          // if a future query is widened or a repository implementation is
          // substituted.
          .filter(
            (selection) =>
              selection.connectedProduct.brandId === primaryBrand.id &&
              selection.connectedProduct.isAvailable,
          )
          .sort(
            (a, b) =>
              a.displayOrder - b.displayOrder ||
              a.connectedProduct.title.localeCompare(b.connectedProduct.title) ||
              a.connectedProduct.id.localeCompare(b.connectedProduct.id),
          );
        campaignProducts = curatedProducts.map((selection) => {
          const product = selection.connectedProduct;
          return {
            id: `campaign-${product.externalId}`,
            productId: product.externalId,
            productLinkId: null,
            title: selection.titleOverride?.trim() || product.title,
            description:
              selection.shortDescriptionOverride?.trim() || product.descriptionText,
            // The connected provider catalog remains authoritative for the image.
            imageUrl: product.imageUrl,
            priceText: formatPersistedPrice(product),
            productUrl: product.productUrl,
            brand: {
              id: primaryBrand.id,
              name: primaryBrand.name,
              slug: primaryBrand.slug,
            },
            source: "CAMPAIGN",
          };
        });
      }
    }

    if (
      linkedProducts.length === 0 &&
      !usesCuratedCatalog &&
      primaryBrand?.shopifyShopDomain &&
      isLegacyShopifyBrandConnectionUsable(primaryBrand)
    ) {
      const products = await deps.fetchLegacyCampaignProducts({
        shopDomain: primaryBrand.shopifyShopDomain,
        brandId: primaryBrand.id,
        limit: 100,
        currency: primaryBrand.shopifyCurrencyCode || "USD",
      });

      if (products.ok) {
        campaignProducts = products.items.map((product) => ({
          id: `campaign-${product.id}`,
          productId: product.id,
          productLinkId: null,
          title: product.title,
          imageUrl: product.imageUrl,
          priceText: product.priceText,
          productUrl: product.productUrl,
          brand: {
            id: primaryBrand.id,
            name: primaryBrand.name,
            slug: primaryBrand.slug,
          },
          source: "CAMPAIGN",
        }));
      } else {
        logCampaignFallbackIssue({
          experienceSlug,
          experienceId: access.experience.id,
          directProductCount: linkedProducts.length,
          fallbackProductCount: campaignProducts.length,
          primaryBrand,
          reason: products.error,
          tokenReason: products.tokenReason,
        });
      }
    } else if (linkedProducts.length === 0 && !usesCuratedCatalog) {
      logCampaignFallbackIssue({
        experienceSlug,
        experienceId: access.experience.id,
        directProductCount: linkedProducts.length,
        fallbackProductCount: campaignProducts.length,
        primaryBrand,
        reason: primaryBrand?.shopifyShopDomain
          ? "Primary brand Shopify connection is not connected."
          : "Primary brand Shopify shop domain is missing.",
      });
    }

    logPublicShopProductResult({
      experienceSlug,
      experienceId: access.experience.id,
      directProductCount: linkedProducts.length,
      fallbackProductCount: campaignProducts.length,
      primaryBrand,
    });

    const response = NextResponse.json({
      data: {
        experience: {
          id: access.experience.id,
          slug: access.experience.slug,
          title: access.experience.title,
        },
        campaign: primaryCampaign
          ? {
              id: primaryCampaign.campaign.id,
              name: primaryCampaign.campaign.name,
              brand: primaryCampaign.campaign.brand,
            }
          : null,
        products: linkedProducts.length > 0 ? linkedProducts : campaignProducts,
      },
    });

    attachSessionCookie(response, sessionId);
    return response;
  } catch (error) {
    console.error("[public/experience/products][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load shop products." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
) {
  return publicExperienceProductsPostImpl(request, context);
}

export async function publicExperienceProductsPostImpl(
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
  overrides: Partial<PublicExperienceProductsPostDeps> = {},
) {
  const deps: PublicExperienceProductsPostDeps = { ...DEFAULT_POST_DEPS, ...overrides };

  try {
    const { experienceSlug } = await context.params;
    const access = await deps.getAccess(experienceSlug, request);

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const body = await request.json().catch(() => null);
    const productId = String(body?.productId || "").trim();
    const productLinkId = String(body?.productLinkId || "").trim() || null;
    const productUrl = String(body?.productUrl || "").trim();

    if (!productId || !productUrl) {
      return NextResponse.json(
        { error: "productId and productUrl are required." },
        { status: 400 },
      );
    }

    const primaryCampaign = access.experience.campaigns[0];
    const sessionId =
      access.viewer.sessionId ||
      (await deps.ensureSession({
        request,
        userId: access.viewer.userId,
        campaignId: primaryCampaign?.campaignId || null,
      }));

    const viewerSession = await deps.findViewerSession(sessionId);

    await deps.createAnalyticsEvent({
      request,
      name: "shop_click",
      brandId: primaryCampaign?.campaign.brand?.id || null,
      campaignId: primaryCampaign?.campaignId || null,
      qrCodeId: viewerSession?.qrCodeId || null,
      experienceId: access.experience.id,
      userId: access.viewer.userId,
      sessionId,
      pagePath: `/x/${access.experience.slug}/shop`,
      data: {
        productId,
        productLinkId,
        productUrl,
        batchId: viewerSession?.qrCode?.batchId || null,
      },
    });

    const response = NextResponse.json({ ok: true });
    attachSessionCookie(response, sessionId);
    return response;
  } catch (error) {
    console.error("[public/experience/products][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to track shop click." },
      { status: 500 },
    );
  }
}
