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
 *
 * ===========================================================================
 * PHASE 29 — BOUNDED, CURSOR-PAGINATED (was: unbounded, browser-paginated)
 * ===========================================================================
 * This route previously fetched EVERY eligible product for every visible
 * campaign and every visible brand storefront in one request (no `take:`
 * anywhere) and let the browser slice the full array into pages. For a large
 * catalog that was an unbounded public, anonymous-accessible payload.
 *
 * The listing is a UNION of independently-ordered, cross-deduplicated
 * sources — one "block" per visible campaign, then one "block" per distinct
 * visible brand storefront (excluding anything already shown campaign-scoped)
 * — concatenated, not merged, so a single flat `ORDER BY` cannot express it.
 * Pagination here is therefore BLOCK-AWARE keyset pagination; the mechanics
 * (cursor shape, block-walking, `hasNextPage` proof) live in the pure,
 * DB-free `resolvePublicShopPage` in `@/lib/commerce/public-shop-pagination`.
 * See that file's header for the full design rationale, including why the
 * storefront exclusion set is recomputed narrowly (id-only) on every request
 * rather than being the same unbounded-payload problem this fixes.
 *
 * DEFENSE-IN-DEPTH SPLIT ACROSS TWO CHECKS, DELIBERATELY UNEVEN.
 * `isSafeCuratedProduct` (brand/availability/publication on the already-
 * mapped `CuratedCampaignProduct` shape) is STILL applied, once, per fetched
 * batch, exactly as the unpaginated version applied it — it is what makes
 * "does not surface unavailable, cross-brand, non-public products" testable
 * against a plain injected fake, not only against a real WHERE clause, and
 * it is cheap enough (a handful of boolean/string comparisons on data
 * already in hand) that applying it costs nothing.
 *
 * `isCampaignAssignmentCatalogAuthorized`'s specific checks (assignment
 * active, campaign/brand cross-ownership, eligibility) are NOT separately
 * re-verified in JS here, unlike the unpaginated version. Every field it
 * checks is already a WHERE predicate in `findCampaignProductsPage`, and the
 * composite foreign keys on `CampaignCommerceProduct` make the cross-tenant
 * violations it exists to catch structurally impossible at the database
 * level regardless of this check. Re-adding it would require carrying its
 * raw input fields (`isActive`, `isCampaignEligible`, ...) through the public
 * `CuratedCampaignProduct` shape for no protective value beyond the WHERE
 * clause, and — critically for pagination correctness — a rejecting filter
 * applied AFTER a bounded `take:` can silently under-fill a page (a rejected
 * row still consumes part of the take budget), which `isSafeCuratedProduct`
 * cannot do here specifically because it is proven to never reject a row a
 * correct WHERE clause already admitted. `isCampaignAssignmentCatalogAuthorized`
 * itself remains exhaustively unit-tested as a pure function in
 * `campaign-assignment-catalog-authorization.test.ts`.
 *
 * The real, independent authorization boundary for actually reaching a
 * merchant destination is unchanged either way: the click routes re-derive
 * everything server-side themselves (see `click-attribution.ts`) and never
 * trust what this listing showed.
 */

import { NextRequest, NextResponse } from "next/server";
import { getExperienceAccessContext, resolvePublicCampaignId } from "@/lib/experience-access";
import prisma from "@/lib/prisma";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";
import { formatMinorUnitPriceRange } from "@/lib/commerce/money";
import {
  clampPublicShopLimit,
  decodePublicShopCursor,
  encodePublicShopCursor,
  resolvePublicShopPage,
  type PublicShopBlockCursor,
  type PublicShopPageRow,
} from "@/lib/commerce/public-shop-pagination";

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

/** One entry in the deterministic, request-scoped block ordering. See the file header. */
type CampaignShopBlock = {
  kind: "CAMPAIGN";
  campaignId: string;
  brandId: string;
  brand: PublicShopBrand;
  productCampaign: { id: string; name: string };
};
type StorefrontShopBlock = {
  kind: "STOREFRONT";
  brandId: string;
  brand: PublicShopBrand;
};
type ShopBlockDef = CampaignShopBlock | StorefrontShopBlock;

/** One candidate product plus the identity used only for cross-source dedup. */
type ShopCandidate = {
  catalogProductId: string;
  product: PublicShopProduct;
};

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
   * The set of `BrandCommerceProduct.id` values that are an authorized,
   * active campaign assignment for one of the given (campaignId, brandId)
   * pairs. Deliberately narrow (id-only) — see the file header for why this
   * is architecturally distinct from the unbounded-payload problem being
   * fixed. Used ONLY to exclude a product from a storefront block that a
   * campaign block already shows.
   */
  findCampaignScopedCatalogIds(
    campaignRefs: Array<{ campaignId: string; brandId: string }>,
  ): Promise<Set<string>>;
  /**
   * One bounded, keyset-paginated page of ONE campaign's active, authorized
   * assignments. Ordered by `(displayOrder, connectedProduct.title,
   * brandCommerceProductId)` ascending — the same order the unpaginated
   * version used. `cursor` scopes strictly-after; `null` starts at the top.
   */
  findCampaignProductsPage(options: {
    campaignId: string;
    brandId: string;
    cursor: PublicShopBlockCursor | null;
    limit: number;
  }): Promise<CuratedCampaignProduct[]>;
  /**
   * One bounded, keyset-paginated page of ONE brand's generic storefront
   * catalog, excluding `excludeBrandCommerceProductIds`. Ordered by
   * `(displayOrder, connectedProduct.title, connectedProductId)` ascending —
   * the same order the unpaginated version used.
   */
  findCuratedProductsPage(options: {
    brandId: string;
    excludeBrandCommerceProductIds: string[];
    cursor: PublicShopBlockCursor | null;
    limit: number;
  }): Promise<CuratedCampaignProduct[]>;
};

/** Keyset predicate for `(displayOrder, title, tiebreak) > cursor` under that ascending order. */
/**
 * `titlePath`/`titleEqPath` are arbitrary Prisma relation-filter fragments
 * (e.g. `{ connectedProduct: { title: { gt: ... } } }` or, one relation
 * deeper, `{ brandCommerceProduct: { connectedProduct: { title: { gt: ... } } } }`)
 * — left as `Record<string, unknown>` rather than a strict union because the
 * two call sites nest the same `title` predicate at different relation
 * depths. Prisma's own generated types validate the ACTUAL query object this
 * is spread into; this helper only assembles the shared 3-branch keyset
 * shape once.
 */
function buildKeysetAfter(
  cursor: PublicShopBlockCursor,
  titlePath: Record<string, unknown>,
  titleEqPath: Record<string, unknown>,
  tiebreakField: "brandCommerceProductId" | "connectedProductId",
) {
  return {
    OR: [
      { displayOrder: { gt: cursor.displayOrder } },
      { displayOrder: cursor.displayOrder, ...titlePath },
      {
        displayOrder: cursor.displayOrder,
        ...titleEqPath,
        [tiebreakField]: { gt: cursor.catalogId },
      },
    ],
  };
}

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
  async findCampaignScopedCatalogIds(campaignRefs) {
    if (campaignRefs.length === 0) {
      return new Set();
    }
    const rows = await prisma.campaignCommerceProduct.findMany({
      where: {
        isActive: true,
        // One OR-branch per visible campaign. This is the ONLY top-level
        // key in this query's `where`, so it cannot collide with any other
        // predicate (there is no cursor/pagination applied to this
        // exclusion-set computation — see the file header for why it must
        // see ALL visible campaigns' assignments, not just one page's worth).
        OR: campaignRefs.map(({ campaignId, brandId }) => ({
          campaignId,
          brandId,
          campaign: { id: campaignId, brandId },
          brandCommerceProduct: {
            brandId,
            isCampaignEligible: true,
            connectedProduct: { brandId, ...PUBLICLY_LISTABLE_CONNECTED_PRODUCT },
          },
        })),
      },
      // NARROW BY DESIGN: only the id this set is keyed by. No title, image,
      // description, or price — this is an authorization/dedup lookup, not
      // presentation data, and its result never reaches the client.
      select: { brandCommerceProductId: true },
    });
    return new Set(rows.map((row) => row.brandCommerceProductId));
  },
  async findCampaignProductsPage({ campaignId, brandId, cursor, limit }) {
    const rows = await prisma.campaignCommerceProduct.findMany({
      where: {
        campaignId,
        brandId,
        isActive: true,
        campaign: { id: campaignId, brandId },
        brandCommerceProduct: {
          brandId,
          isCampaignEligible: true,
          connectedProduct: { brandId, ...PUBLICLY_LISTABLE_CONNECTED_PRODUCT },
        },
        // Cursor keyset nested under AND — never spread as a second
        // top-level OR — so a future filter added to this query's base
        // predicates can never silently collide with it. Mirrors
        // `order-list.ts`'s `buildOrderListWhere` reasoning exactly.
        ...(cursor
          ? {
              AND: [
                buildKeysetAfter(
                  cursor,
                  { brandCommerceProduct: { connectedProduct: { title: { gt: cursor.sortKey } } } },
                  { brandCommerceProduct: { connectedProduct: { title: cursor.sortKey } } },
                  "brandCommerceProductId",
                ),
              ],
            }
          : {}),
      },
      orderBy: [
        { displayOrder: "asc" },
        { brandCommerceProduct: { connectedProduct: { title: "asc" } } },
        { brandCommerceProductId: "asc" },
      ],
      take: limit,
      select: {
        id: true,
        displayOrder: true,
        brandCommerceProduct: {
          select: {
            id: true,
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
    });
    return rows.map((row) => ({
      campaignAssignmentId: row.id,
      displayOrder: row.displayOrder,
      ...row.brandCommerceProduct,
    }));
  },
  async findCuratedProductsPage({ brandId, excludeBrandCommerceProductIds, cursor, limit }) {
    const rows = await prisma.brandCommerceProduct.findMany({
      // The relation predicate is intentional defense in depth. The schema
      // does not make the two brand ids a composite foreign key, so a bad
      // historical row must never expose another brand's catalog item.
      where: {
        brandId,
        isVisibleInShop: true,
        ...(excludeBrandCommerceProductIds.length > 0
          ? { id: { notIn: excludeBrandCommerceProductIds } }
          : {}),
        connectedProduct: {
          brandId,
          ...PUBLICLY_LISTABLE_CONNECTED_PRODUCT,
        },
        ...(cursor
          ? {
              AND: [
                buildKeysetAfter(
                  cursor,
                  { connectedProduct: { title: { gt: cursor.sortKey } } },
                  { connectedProduct: { title: cursor.sortKey } },
                  "connectedProductId",
                ),
              ],
            }
          : {}),
      },
      orderBy: [
        { displayOrder: "asc" },
        { connectedProduct: { title: "asc" } },
        { connectedProductId: "asc" },
      ],
      take: limit,
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
    return rows;
  },
};

/**
 * In-process re-check of the same conditions the queries enforce. Defense in
 * depth against a replaced repository or an injected dependency that forgets
 * a predicate: BOTH `isAvailable` and `hasPublicStorefrontUrl` must hold, in
 * addition to the same-brand check. See this file's header for why this is
 * the one JS-level check retained after pagination, and applied without a
 * retry: it is proven to never reject a row a correct WHERE clause already
 * admitted, so it can never under-fill a bounded page.
 */
/**
 * Defense in depth, matching `isSafeCuratedProduct`'s philosophy: re-sorts
 * ONE fetched batch (bounded by page size, never the full catalog) by the
 * exact `(displayOrder, sortKey, catalogId)` order every block's own
 * `orderBy` already requests. `resolvePublicShopPage` documents that
 * `fetchBlockPage` MUST return ascending-ordered rows — a real Prisma call
 * already guarantees that, but a replaced repository or an injected test
 * double can trivially violate it by construction. Getting this wrong would
 * not just misorder cards: it would corrupt the KEYSET CURSOR derived from
 * "the last row", silently breaking pagination (skipped or repeated rows) —
 * a materially worse consequence than the display-order-only risk the
 * original unpaginated `sortCuratedProducts` guarded against, so it is kept.
 */
function sortPageRows<T>(rows: Array<PublicShopPageRow<T>>): Array<PublicShopPageRow<T>> {
  return [...rows].sort(
    (a, b) =>
      a.displayOrder - b.displayOrder ||
      a.sortKey.localeCompare(b.sortKey) ||
      a.catalogId.localeCompare(b.catalogId),
  );
}

function isSafeCuratedProduct(selection: CuratedCampaignProduct, brandId: string) {
  return (
    selection.connectedProduct.brandId === brandId &&
    selection.connectedProduct.isAvailable &&
    selection.connectedProduct.hasPublicStorefrontUrl
  );
}

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

function serializeCuratedProduct(options: {
  selection: CuratedCampaignProduct;
  brand: PublicShopBrand;
  productCampaign?: { id: string; name: string } | null;
  source: "CAMPAIGN_PRODUCT" | "BRAND_STOREFRONT";
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
    // The one shared minor-unit formatter (hardcoded "en-US"); behavior is
    // identical to the local copy it replaced.
    priceText: formatMinorUnitPriceRange(product),
    productUrl: product.productUrl,
    brand: {
      id: options.brand.id,
      name: options.brand.name,
      slug: options.brand.slug,
    },
    source: options.source,
    ...(options.source === "CAMPAIGN_PRODUCT" && options.productCampaign
      ? { productCampaign: options.productCampaign }
      : {}),
  };
}

function logPublicShopProductResult(options: {
  experienceSlug: string;
  experienceId: string;
  pageProductCount: number;
  hasNextPage: boolean;
  primaryBrand: PublicShopBrand | null;
}) {
  console.info("[public/experience/products][GET] Page loaded:", {
    experienceSlug: options.experienceSlug,
    experienceId: options.experienceId,
    pageProductCount: options.pageProductCount,
    hasNextPage: options.hasNextPage,
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

    // The deterministic block ordering this request's cursor addresses:
    // every visible campaign's block, in the SAME order `visibleCampaigns`
    // is already sorted in, followed by every distinct visible brand's
    // storefront block, in brand-name order. This exact ordering is what a
    // cursor's `blockIndex` means for THIS request; it is recomputed fresh
    // every request from the same deterministic inputs, so an unchanged
    // dataset yields the same block assignment across pages.
    const campaignBlocks: CampaignShopBlock[] = visibleCampaigns
      .map((campaignLink): CampaignShopBlock | null => {
        const brandId = campaignLink.campaign.brand?.id;
        const brand = brandId ? brandMap.get(brandId) : null;
        if (!brandId || !brand) {
          return null;
        }
        return {
          kind: "CAMPAIGN",
          campaignId: campaignLink.campaignId,
          brandId,
          brand,
          productCampaign: {
            id: campaignLink.campaign.id,
            name: campaignLink.campaign.name,
          },
        };
      })
      .filter((block): block is CampaignShopBlock => block !== null);

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

    const storefrontBlocks: StorefrontShopBlock[] = distinctVisibleBrandIds.map((brandId) => ({
      kind: "STOREFRONT",
      brandId,
      brand: brandMap.get(brandId)!,
    }));

    const orderedBlocks: ShopBlockDef[] = [...campaignBlocks, ...storefrontBlocks];

    // Computed ONCE per request, across ALL visible campaigns regardless of
    // which block is currently being paged — see the file header and
    // `findCampaignScopedCatalogIds`'s own doc comment for why this must be
    // complete rather than scoped to the current page.
    const campaignScopedCatalogIds = await deps.findCampaignScopedCatalogIds(
      campaignBlocks.map((block) => ({ campaignId: block.campaignId, brandId: block.brandId })),
    );

    const params = request.nextUrl.searchParams;
    const limit = clampPublicShopLimit(params.get("limit"));
    const decodedCursor = decodePublicShopCursor(params.get("cursor"));

    const page = await resolvePublicShopPage<ShopCandidate>(
      { cursor: decodedCursor, limit },
      {
        blockCount: orderedBlocks.length,
        async fetchBlockPage(blockIndex, cursor, blockLimit) {
          const block = orderedBlocks[blockIndex];
          if (!block) {
            return [];
          }

          if (block.kind === "CAMPAIGN") {
            const rows = (
              await deps.findCampaignProductsPage({
                campaignId: block.campaignId,
                brandId: block.brandId,
                cursor,
                limit: blockLimit,
              })
            ).filter((selection) => isSafeCuratedProduct(selection, block.brandId));
            return sortPageRows(
              rows.map(
                (selection): PublicShopPageRow<ShopCandidate> => ({
                  displayOrder: selection.displayOrder,
                  sortKey: selection.connectedProduct.title,
                  // Tiebreak matches this block's own orderBy: brandCommerceProductId.
                  catalogId: selection.id || selection.connectedProduct.id,
                  item: {
                    catalogProductId: selection.id || selection.connectedProduct.id,
                    product: serializeCuratedProduct({
                      selection,
                      brand: block.brand,
                      source: "CAMPAIGN_PRODUCT",
                      productCampaign: block.productCampaign,
                    }),
                  },
                }),
              ),
            );
          }

          const rows = (
            await deps.findCuratedProductsPage({
              brandId: block.brandId,
              excludeBrandCommerceProductIds: Array.from(campaignScopedCatalogIds),
              cursor,
              limit: blockLimit,
            })
          ).filter((selection) => isSafeCuratedProduct(selection, block.brandId));
          return sortPageRows(
            rows.map(
              (selection): PublicShopPageRow<ShopCandidate> => ({
                displayOrder: selection.displayOrder,
                sortKey: selection.connectedProduct.title,
                // Tiebreak matches this block's own orderBy: connectedProductId
                // (NOT BrandCommerceProduct.id — a different column from the
                // exclusion set's key, used only for THIS block's ordering).
                catalogId: selection.connectedProduct.id,
                item: {
                  catalogProductId: selection.id || selection.connectedProduct.id,
                  product: serializeCuratedProduct({
                    selection,
                    brand: block.brand,
                    source: "BRAND_STOREFRONT",
                    directUnion: isDirectUnion,
                  }),
                },
              }),
            ),
          );
        },
      },
    );

    const products = page.items.map((candidate) => candidate.product);

    logPublicShopProductResult({
      experienceSlug,
      experienceId: access.experience.id,
      pageProductCount: products.length,
      hasNextPage: page.hasNextPage,
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
        products,
      },
      // OUTSIDE `data`, matching this repository's other keyset-pagination
      // envelopes (`order-list.ts`, the campaign-products route). `fetchJson`
      // unwraps to `json.data` only, so a client reading this endpoint MUST
      // use a raw `fetch()` and parse the full body — see
      // `parsePublicShopEnvelope` in `public-commerce-response.ts` — never
      // `fetchJson<T>()`, which would silently discard `meta` exactly as the
      // Brand campaign-products page once did.
      meta: {
        hasNextPage: page.hasNextPage,
        nextCursor: page.nextCursor ? encodePublicShopCursor(page.nextCursor) : null,
        limit,
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
