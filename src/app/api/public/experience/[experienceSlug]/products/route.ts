/**
 * Public Experience shop catalog.
 *
 * PHASE 8: PERSISTED CANONICAL TABLES ARE THE ONLY SOURCE.
 *
 * Two legacy paths were removed here:
 *
 *  1. `ExperienceProductLink` — a free-form snapshot table whose rows took
 *     "absolute precedence" over every curated row. That precedence rule existed
 *     only to serve those snapshots, so it went with them.
 *
 *  2. The PUBLIC LIVE-SHOPIFY FALLBACK — when a brand had zero persisted
 *     selections, this route called Shopify's Admin API on the visitor request
 *     path and rendered whatever came back. That made the public storefront
 *     depend on a live third-party call, and it published products the brand had
 *     never curated. It is gone: zero persisted `BrandCommerceProduct`
 *     selections now means zero storefront products, full stop.
 *
 * PUBLIC STOREFRONT GATE. Every listing predicate requires BOTH
 * `isAvailable === true` (provider lifecycle status) and
 * `hasPublicStorefrontUrl === true` (the provider confirmed Online Store
 * publication). A Shopify product can be `status: ACTIVE` yet unpublished from
 * the Online Store channel. Password-protected development stores can still be
 * published and use the canonical fallback URL. The click routes apply the
 * identical pair, so a hidden card is never clickable.
 */

import { NextRequest, NextResponse } from "next/server";
import { getExperienceAccessContext, resolvePublicCampaignId } from "@/lib/experience-access";
import prisma from "@/lib/prisma";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";
import { formatMinorUnitPriceRange } from "@/lib/commerce/money";
import { isCampaignAssignmentCatalogAuthorized } from "@/lib/commerce/campaign-assignment-authorization";

type PublicShopProduct = {
  id?: string;
  productId: string;
  /**
   * Retained as an always-null field purely so the response shape and the
   * legacy link id. Canonical click evidence is CommerceClickAttribution.
   */
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
  /**
   * Explicit canonical card source:
   * - "CAMPAIGN_PRODUCT": explicit active campaign assignment (CampaignCommerceProduct)
   * - "BRAND_STOREFRONT": generic brand-level storefront selection (BrandCommerceProduct.isVisibleInShop)
   */
  source: "CAMPAIGN_PRODUCT" | "BRAND_STOREFRONT";
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
  /** Present for brand storefront catalog items. */
  campaignProductId?: string;
  /** Opaque CampaignCommerceProduct id for a campaign-scoped click hop. */
  campaignAssignmentId?: string;
};

/**
 * The only brand fields this route needs. Every `shopify*` field it used to
 * carry existed solely for the deleted live-Shopify fallback (shop domain,
 * connection status/timestamps/scopes for `isLegacyShopifyBrandConnectionUsable`,
 * and the currency for the live fetch). None is read anymore, so none is loaded
 * — the brand's Shopify connection state is no longer an input to public
 * rendering at all.
 */
type PublicShopBrand = {
  id: string;
  name: string;
  slug: string;
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
    /**
     * Whether the provider actually handed us a publicly reachable storefront
     * URL. Required alongside `isAvailable` for a product to be listed; see this
     * file's header for why neither implies the other.
     */
    hasPublicStorefrontUrl: boolean;
    currencyCode: string | null;
    priceMinMinor: number | null;
    priceMaxMinor: number | null;
    priceMinorUnitExponent: number | null;
  };
};

/**
 * BOTH conditions, always, in every listing predicate in this file.
 *
 * PHASE 18 REPAIR (P1-3): ALSO requires the owning `CommerceConnection` to
 * be `CONNECTED` — an UNINSTALLED/DISCONNECTED/REQUIRES_RECONNECT store's
 * products must never remain publicly LISTED merely because the last sync
 * left `isAvailable`/`hasPublicStorefrontUrl` true. Mirrors the identical
 * gate added to `PUBLICLY_CLICKABLE_CONNECTED_PRODUCT` in
 * `../../../../../../lib/commerce/click-attribution.ts` — a product that is
 * never listed can never be clicked, and a product that somehow is listed
 * (e.g. cached) still cannot be clicked, since the click path re-checks
 * independently.
 */
const PUBLICLY_LISTABLE_CONNECTED_PRODUCT = {
  isAvailable: true,
  hasPublicStorefrontUrl: true,
  connection: { is: { status: "CONNECTED" as const } },
} as const;

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
  findBrands(brandIds: string[]): Promise<PublicShopBrand[]>;
  /**
   * Must return only current-brand, visible, available, publicly-reachable
   * products (see default implementation). Zero rows means an intentionally
   * empty storefront — there is no live-provider fallback behind it.
   */
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
};

const DEFAULT_DEPS: PublicExperienceProductsDeps = {
  getAccess: getExperienceAccessContext,
  ensureSession: ensureViewerSession,
  findBrands(brandIds) {
    return prisma.brand.findMany({
      where: { id: { in: brandIds } },
      select: {
        id: true,
        name: true,
        slug: true,
      },
    });
  },
  findCuratedProducts(brandId) {
    return prisma.brandCommerceProduct.findMany({
      // The relation predicate is intentional defense in depth. The schema
      // does not make the two brand ids a composite foreign key, so a bad
      // historical row must never expose another brand's catalog item.
      where: {
        brandId,
        isVisibleInShop: true,
        connectedProduct: {
          brandId,
          ...PUBLICLY_LISTABLE_CONNECTED_PRODUCT,
        },
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
            hasPublicStorefrontUrl: true,
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
          },
          brandCommerceProduct: {
            brandId,
            isCampaignEligible: true,
            connectedProduct: {
              brandId,
              ...PUBLICLY_LISTABLE_CONNECTED_PRODUCT,
            },
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
                  hasPublicStorefrontUrl: true,
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

/**
 * In-process re-check of the same conditions the queries enforce. Defense in
 * depth against a replaced repository or an injected dependency that forgets a
 * predicate: BOTH `isAvailable` and `hasPublicStorefrontUrl` must hold, in
 * addition to the same-brand check.
 */
function isSafeCuratedProduct(
  selection: CuratedCampaignProduct,
  brandId: string,
) {
  return (
    selection.connectedProduct.brandId === brandId &&
    selection.connectedProduct.isAvailable &&
    selection.connectedProduct.hasPublicStorefrontUrl
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
  brand: PublicShopBrand;
  productCampaign?: { id: string; name: string } | null;
  source?: "CAMPAIGN_PRODUCT" | "BRAND_STOREFRONT";
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

  const isCampaignProduct = Boolean(options.selection.campaignAssignmentId || options.productCampaign);
  const source: "CAMPAIGN_PRODUCT" | "BRAND_STOREFRONT" =
    options.source || (isCampaignProduct ? "CAMPAIGN_PRODUCT" : "BRAND_STOREFRONT");

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
    // The one shared minor-unit formatter (hardcoded "en-US"); behavior is
    // identical to the local copy it replaced.
    priceText: formatMinorUnitPriceRange(product),
    productUrl: product.productUrl,
    brand: {
      id: options.brand.id,
      name: options.brand.name,
      slug: options.brand.slug,
    },
    source,
    ...(source === "CAMPAIGN_PRODUCT" && options.productCampaign
      ? { productCampaign: options.productCampaign }
      : {}),
  };
}

function logPublicShopProductResult(options: {
  experienceSlug: string;
  experienceId: string;
  catalogProductCount: number;
  primaryBrand: PublicShopBrand | null;
}) {
  console.info("[public/experience/products][GET] Products loaded:", {
    experienceSlug: options.experienceSlug,
    experienceId: options.experienceId,
    catalogProductCount: options.catalogProductCount,
    primaryBrand: options.primaryBrand
      ? {
          id: options.primaryBrand.id,
          name: options.primaryBrand.name,
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

    const candidateBrandIds = new Set<string>();
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

    // 1. CampaignCommerceProduct is explicit authorization. On a campaign entry
    // only that campaign is queried; on a direct entry all valid linked
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
            source: "CAMPAIGN_PRODUCT",
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

    // 2. Brand storefront catalog rows are intentionally generic: they may be
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
        // THE PERSISTED CATALOG IS THE ONLY SOURCE. Zero rows is an
        // intentionally empty storefront, not a cue to call the provider live on
        // the visitor request path.
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
              source: "BRAND_STOREFRONT",
              directUnion: isDirectUnion,
            }),
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
      catalogProductCount: campaignProducts.length,
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
        products: campaignProducts,
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
