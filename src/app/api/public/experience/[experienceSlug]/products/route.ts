import { NextRequest, NextResponse } from "next/server";
import {
  createAnalyticsEvent,
  getExperienceAccessContext,
  resolvePublicCampaignId,
} from "@/lib/experience-access";
import prisma from "@/lib/prisma";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";
import { fetchNormalizedShopifyProducts } from "@/lib/shopify-products";
import { isProductLinkCurrent } from "@/lib/product-link-compatibility";
import {
  externalAccountIdFromShopDomain,
  isLegacyShopifyBrandConnectionUsable,
} from "@/lib/commerce/connection-service";
import { isCampaignAssignmentCatalogAuthorized } from "@/lib/commerce/campaign-assignment-authorization";

type PublicShopProduct = {
  id?: string;
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
  /**
   * A campaign-specific product remains identified as such when a direct
   * Experience entry displays the union of several sponsors' products. This
   * is presentation context only; the click route revalidates it server-side.
   */
  productCampaign?: {
    id: string;
    name: string;
  } | null;
  /** Opaque CampaignCommerceProduct id for a campaign-scoped click hop. */
  campaignAssignmentId?: string;
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
  /** Compatibility projection for older injected test doubles. */
  storedCampaignId?: string | null;
  /**
   * Explicit server-resolved entry semantics. DIRECT must override any stale
   * stored campaign; CAMPAIGN is already validated against this Experience.
   */
  entryContext?: { kind: "DIRECT" } | { kind: "CAMPAIGN"; campaignId: string };
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
  id?: string;
  /** Present only for a CampaignCommerceProduct projection. */
  campaignAssignmentId?: string;
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
  getAccess(
    experienceSlug: string,
    request: NextRequest,
  ): Promise<PublicShopAccess | null>;
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
  /**
   * Active, same-brand campaign assignments. Unlike the public brand
   * storefront, these are explicitly campaign-scoped and must retain that
   * identity when a direct Experience renders more than one campaign.
   */
  findCampaignProducts(options: {
    campaignId: string;
    brandId: string;
  }): Promise<CuratedCampaignProduct[]>;
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
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
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
        id: true,
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
  findCampaignProducts({ campaignId, brandId }) {
    return prisma.campaignCommerceProduct
      .findMany({
        // Both relations are constrained by brandId in the schema. These
        // predicates remain deliberate defense in depth for historical rows and
        // for any future repository replacement.
        where: {
          campaignId,
          brandId,
          isActive: true,
          campaign: {
            id: campaignId,
            brandId,
            commerceProductCurationEnabled: true,
          },
          brandCommerceProduct: {
            brandId,
            isCampaignEligible: true,
            connectedProduct: { brandId, isAvailable: true },
          },
        },
        orderBy: [
          { displayOrder: "asc" },
          { brandCommerceProduct: { connectedProduct: { title: "asc" } } },
          { brandCommerceProductId: "asc" },
        ],
        select: {
          id: true,
          campaignId: true,
          brandId: true,
          isActive: true,
          displayOrder: true,
          campaign: {
            select: {
              id: true,
              brandId: true,
              commerceProductCurationEnabled: true,
            },
          },
          brandCommerceProduct: {
            select: {
              id: true,
              brandId: true,
              isCampaignEligible: true,
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
          },
        },
      })
      .then((rows) =>
        rows
          .filter((row) =>
            isCampaignAssignmentCatalogAuthorized({
              assignment: row,
              campaign: row.campaign,
              brandCommerceProduct: row.brandCommerceProduct,
            }),
          )
          .map((row) => ({
            campaignAssignmentId: row.id,
            displayOrder: row.displayOrder,
            ...row.brandCommerceProduct,
          })),
      );
  },
  fetchLegacyCampaignProducts: fetchNormalizedShopifyProducts,
};

export type PublicExperienceProductsPostDeps = {
  getAccess(
    experienceSlug: string,
    request: NextRequest,
  ): Promise<PublicShopAccess | null>;
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

/**
 * The campaign acquisition context for this public shop request. Direct entry
 * is an explicit unscoped state, not an invitation to select a first campaign.
 * The compatibility branch exists only for isolated older test doubles; live
 * access contexts always include `entryContext`.
 */
function resolvePrimaryCampaign(access: PublicShopAccess) {
  const entryContext = access.entryContext;

  if (entryContext?.kind === "DIRECT") {
    return null;
  }

  if (entryContext?.kind === "CAMPAIGN") {
    return (
      access.experience.campaigns.find(
        (item) => item.campaignId === entryContext.campaignId,
      ) || null
    );
  }

  const resolvedCampaignId = resolvePublicCampaignId({
    campaigns: access.experience.campaigns.map((item) => ({
      campaignId: item.campaignId,
      brandId: item.campaign.brand?.id ?? null,
    })),
    storedCampaignId: access.storedCampaignId ?? null,
  });

  return (
    access.experience.campaigns.find(
      (item) => item.campaignId === resolvedCampaignId,
    ) || null
  );
}

function formatPersistedPrice(
  product: CuratedCampaignProduct["connectedProduct"],
): string | null {
  const { priceMinMinor, priceMaxMinor, priceMinorUnitExponent, currencyCode } =
    product;
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

function isSafeCuratedProduct(
  selection: CuratedCampaignProduct,
  brandId: string,
) {
  return (
    selection.connectedProduct.brandId === brandId &&
    selection.connectedProduct.isAvailable
  );
}

function sortCuratedProducts(products: CuratedCampaignProduct[]) {
  return products
    .filter((product) => Number.isFinite(product.displayOrder))
    .sort(
      (a, b) =>
        a.displayOrder - b.displayOrder ||
        a.connectedProduct.title.localeCompare(b.connectedProduct.title) ||
        a.connectedProduct.id.localeCompare(b.connectedProduct.id),
    );
}

function serializeCuratedProduct(options: {
  selection: CuratedCampaignProduct;
  brand: CampaignFallbackBrand;
  productCampaign?: { id: string; name: string } | null;
  /** Keeps pre-union single-brand card ids response-compatible. */
  directUnion?: boolean;
}): PublicShopProduct {
  const product = options.selection.connectedProduct;
  const selectionId = options.selection.id || product.externalId;
  const idSuffix = options.productCampaign
    ? `${options.productCampaign.id}-${selectionId}`
    : options.directUnion
      ? `${options.brand.id}-${selectionId}`
      : product.externalId;

  return {
    id: `campaign-${idSuffix}`,
    productId: product.externalId,
    productLinkId: null,
    ...(options.selection.id
      ? { campaignProductId: options.selection.id }
      : {}),
    ...(options.selection.campaignAssignmentId
      ? { campaignAssignmentId: options.selection.campaignAssignmentId }
      : {}),
    title: options.selection.titleOverride?.trim() || product.title,
    description:
      options.selection.shortDescriptionOverride?.trim() ||
      product.descriptionText,
    imageUrl: product.imageUrl,
    priceText: formatPersistedPrice(product),
    productUrl: product.productUrl,
    brand: {
      id: options.brand.id,
      name: options.brand.name,
      slug: options.brand.slug,
    },
    source: "CAMPAIGN",
    ...(options.productCampaign
      ? { productCampaign: options.productCampaign }
      : {}),
  };
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

    const primaryCampaign = resolvePrimaryCampaign(access);
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
    // A resolved campaign is an authorization boundary. An unscoped direct
    // entry is deliberately different: it may show the union of *all* linked
    // campaign/brand contexts, but never chooses one as the visitor's campaign.
    // CampaignExperience.sortOrder is presentation data, not authorization.
    const primaryBrand = primaryCampaign?.campaign.brand?.id
      ? brandMap.get(primaryCampaign.campaign.brand.id) || null
      : null;
    const eligibleCampaigns = access.experience.campaigns
      .filter((campaignLink) => {
        const brandId = campaignLink.campaign.brand?.id;
        return Boolean(brandId && brandMap.has(brandId));
      })
      .sort(
        (a, b) =>
          a.campaign.name.localeCompare(b.campaign.name) ||
          a.campaignId.localeCompare(b.campaignId),
      );
    const visibleCampaigns = primaryCampaign
      ? primaryBrand
        ? [primaryCampaign]
        : []
      : eligibleCampaigns;
    const isDirectUnion = !primaryCampaign && visibleCampaigns.length > 1;

    // A stored direct link is current only when its sourceShopDomain matches
    // its brand's current Shopify domain. Stale/unknown-source links are
    // treated as absent here (never deleted) so they don't suppress the
    // campaign-products fallback below.
    const domainByBrandId = new Map(
      brands.map((brand) => [
        brand.id,
        externalAccountIdFromShopDomain(brand.shopifyShopDomain),
      ]),
    );
    const currentProductLinks = productLinks.filter((link) =>
      isProductLinkCurrent(link, domainByBrandId),
    );

    const linkedProducts: PublicShopProduct[] = currentProductLinks.map(
      (link) => {
        // Every current direct link is still returned, exactly as before. Only
        // the DISPLAY brand of a link that carries no brand of its own falls back
        // to the resolved context's brand — and to null (no brand shown) when
        // that context is ambiguous, rather than labelling the product with an
        // arbitrary co-sponsor's name.
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
      },
    );

    // 1. Direct ExperienceProductLink rows are intentionally global. They are
    // never filtered by campaign context and no longer suppress the scoped or
    // brand-storefront rows that follow.
    //
    // 2. CampaignCommerceProduct is explicit authorization. On a campaign
    // entry only that campaign is queried; on a direct entry all valid linked
    // campaigns are queried and each card retains its own campaign identity.
    const scopedCandidates = await Promise.all(
      visibleCampaigns.map(async (campaignLink) => {
        const brandId = campaignLink.campaign.brand!.id;
        const brand = brandMap.get(brandId)!;
        const selections = sortCuratedProducts(
          (
            await deps.findCampaignProducts({
              campaignId: campaignLink.campaignId,
              brandId,
            })
          ).filter((selection) => isSafeCuratedProduct(selection, brandId)),
        );
        return selections.map((selection) => ({
          catalogProductId: selection.id || selection.connectedProduct.id,
          product: serializeCuratedProduct({
            selection,
            brand,
            productCampaign: {
              id: campaignLink.campaign.id,
              name: campaignLink.campaign.name,
            },
          }),
        }));
      }),
    );
    const scopedProducts = scopedCandidates.flat();
    const campaignScopedCatalogIds = new Set(
      scopedProducts.map((candidate) => candidate.catalogProductId),
    );

    // 3. Brand storefront catalog rows are intentionally generic: they may be
    // shown once for every distinct linked Brand, but never manufactured into
    // campaign attribution. A campaign-scoped card wins over the same BCP id
    // so a direct union cannot erase meaningful campaign identity by rendering
    // a second generic card for it.
    const distinctVisibleBrandIds = Array.from(
      new Set(
        visibleCampaigns
          .map((campaignLink) => campaignLink.campaign.brand?.id || null)
          .filter((brandId): brandId is string => Boolean(brandId)),
      ),
    ).sort((a, b) => {
      const brandA = brandMap.get(a)!;
      const brandB = brandMap.get(b)!;
      return brandA.name.localeCompare(brandB.name) || a.localeCompare(b);
    });

    const storefrontCandidates = await Promise.all(
      distinctVisibleBrandIds.map(async (brandId) => {
        const brand = brandMap.get(brandId)!;
        // A selection row (including a hidden one) makes the persisted catalog
        // authoritative. Zero rows retain the established live-Shopify
        // compatibility fallback for that one brand.
        const selectionCount = await deps.countBrandSelections(brand.id);
        if (selectionCount > 0) {
          return sortCuratedProducts(
            (await deps.findCuratedProducts(brand.id)).filter((selection) =>
              isSafeCuratedProduct(selection, brand.id),
            ),
          )
            .filter(
              (selection) =>
                !campaignScopedCatalogIds.has(
                  selection.id || selection.connectedProduct.id,
                ),
            )
            .map((selection) => ({
              catalogProductId: selection.id || selection.connectedProduct.id,
              product: serializeCuratedProduct({
                selection,
                brand,
                directUnion: isDirectUnion,
              }),
            }));
        }

        if (
          !brand.shopifyShopDomain ||
          !isLegacyShopifyBrandConnectionUsable(brand)
        ) {
          logCampaignFallbackIssue({
            experienceSlug,
            experienceId: access.experience.id,
            directProductCount: linkedProducts.length,
            fallbackProductCount: 0,
            primaryBrand: brand,
            reason: brand.shopifyShopDomain
              ? "Brand Shopify connection is not connected."
              : "Brand Shopify shop domain is missing.",
          });
          return [];
        }

        const products = await deps.fetchLegacyCampaignProducts({
          shopDomain: brand.shopifyShopDomain,
          brandId: brand.id,
          limit: 100,
          currency: brand.shopifyCurrencyCode || "USD",
        });
        if (!products.ok) {
          logCampaignFallbackIssue({
            experienceSlug,
            experienceId: access.experience.id,
            directProductCount: linkedProducts.length,
            fallbackProductCount: 0,
            primaryBrand: brand,
            reason: products.error,
            tokenReason: products.tokenReason,
          });
          return [];
        }

        return products.items.map((product) => ({
          catalogProductId: `legacy:${brand.id}:${product.id}`,
          product: {
            id: isDirectUnion
              ? `campaign-${brand.id}-${product.id}`
              : `campaign-${product.id}`,
            productId: product.id,
            productLinkId: null,
            title: product.title,
            imageUrl: product.imageUrl,
            priceText: product.priceText,
            productUrl: product.productUrl,
            brand: { id: brand.id, name: brand.name, slug: brand.slug },
            source: "CAMPAIGN" as const,
            productCampaign: null,
          },
        }));
      }),
    );
    const seenStorefrontCatalogIds = new Set<string>();
    const storefrontProducts = storefrontCandidates
      .flat()
      .filter((candidate) => {
        if (seenStorefrontCatalogIds.has(candidate.catalogProductId))
          return false;
        seenStorefrontCatalogIds.add(candidate.catalogProductId);
        return true;
      })
      .map((candidate) => candidate.product);

    const campaignProducts = [
      ...scopedProducts.map((candidate) => candidate.product),
      ...storefrontProducts,
    ];

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
        products: [...linkedProducts, ...campaignProducts],
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
  const deps: PublicExperienceProductsPostDeps = {
    ...DEFAULT_POST_DEPS,
    ...overrides,
  };

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

    if (!productId) {
      return NextResponse.json(
        { error: "productId is required." },
        { status: 400 },
      );
    }

    // Attribution follows the same resolved context as the catalog. When it is
    // ambiguous, `brandId`/`campaignId` are omitted (both columns are nullable
    // on AnalyticsEvent) so the click is recorded honestly as unattributed
    // rather than credited to — or charged against — an arbitrary co-sponsor.
    // The event itself still fires: dropping it would lose the click entirely.
    const primaryCampaign = resolvePrimaryCampaign(access);
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
