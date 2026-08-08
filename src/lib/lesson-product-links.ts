import type { Prisma, Role } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { normalizeShopDomain } from "@/lib/shopify";
import { externalAccountIdFromShopDomain } from "@/lib/commerce/connection-service";
import { buildEligibleCampaignContexts, type CampaignContextCandidate } from "@/lib/campaign-context";
import type { LessonCampaignContext } from "@/lib/commerce/campaign-product-curation";

type LessonProductActor = {
  userId: string;
  role: Extract<Role, "ADMIN" | "CREATOR">;
};

/**
 * Includes every field `isLegacyShopifyBrandConnectionUsable` (and, via it,
 * `mapLegacyBrandToConnectionSummary`) needs to decide connectivity through
 * the provider-neutral commerce connection service — NOT
 * `shopifyAdminAccessTokenEncrypted`, which that service deliberately never
 * needs (see `src/lib/commerce/connection-service.ts`'s file header for why
 * `status` alone reproduces the old three-part check). None of these fields
 * are ever serialized directly — every consumer only ever projects
 * `{ id, name, slug }` out of a `CandidateBrand`.
 */
export type CandidateBrand = {
  id: string;
  name: string;
  slug: string;
  shopifyShopDomain: string | null;
  shopifyConnectionStatus: "DISCONNECTED" | "CONNECTED" | "UNINSTALLED" | "REQUIRES_RECONNECT";
  shopifyInstalledAt: Date | null;
  shopifyUninstalledAt: Date | null;
  shopifyLastProductSyncAt: Date | null;
  shopifyGrantedScopes: string | null;
};

export type LessonProductManagementContext = {
  actor: LessonProductActor;
  lesson: {
    id: string;
    title: string;
    course: {
      id: string;
      title: string;
      experience: {
        id: string;
        title: string;
        slug: string;
        creatorUserId: string;
      };
    };
  };
  /**
   * Every brand reachable from this Lesson's Experience through a linked
   * campaign, de-duplicated. This stays a LIST on purpose: it is what
   * `resolveSourceShopDomainForBrand` and the campaign selector need. There is
   * deliberately no `primaryBrand` — "the first connected brand" was a guess
   * that let a co-sponsoring brand capture a shared Experience by writing an
   * extreme `CampaignExperience.sortOrder`.
   */
  candidateBrands: CandidateBrand[];
  /** Campaigns actually linked to this Lesson's Experience, in the persisted
   * campaign sort order. This is server-only context for curation; it is never
   * inferred from a client-supplied brand or provider id. */
  campaigns: LessonCampaignContext[];
  /**
   * The eligible (brand-owning) campaign contexts derived from `campaigns` via
   * the shared resolver, deterministically ordered. Replaces `primaryBrand` as
   * the thing callers resolve a brand from.
   */
  campaignContexts: CampaignContextCandidate[];
};

export type LessonProductLinkRecord = {
  id: string;
  lessonId: string;
  productUrl: string;
  title: string | null;
  imageUrl: string | null;
  priceText: string | null;
  currency: string | null;
  brandId: string | null;
  sourceShopDomain: string | null;
  createdAt: Date;
};

/**
 * Resolves the normalized Shopify domain to stamp as a product link's
 * sourceShopDomain, from the brand's own current connection state — never
 * from client-provided input. Routes the raw domain through the service's
 * `externalAccountIdFromShopDomain` first (a trim-only pass, matching how
 * `CommerceConnectionSummary.externalAccountId` is derived) and then through
 * `normalizeShopDomain` exactly as before — `normalizeShopDomain` also
 * lowercases and validates the domain SHAPE, which the provider-neutral
 * service has no equivalent for, so that validation stays here rather than
 * being silently dropped.
 */
export function resolveSourceShopDomainForBrand(
  candidateBrands: CandidateBrand[],
  brandId: string | null,
): string | null {
  if (!brandId) {
    return null;
  }

  const brand = candidateBrands.find((candidate) => candidate.id === brandId);
  return normalizeShopDomain(externalAccountIdFromShopDomain(brand?.shopifyShopDomain));
}

/** Lowercased hostname of an absolute http(s) URL, with a leading `www.`
 * stripped. Null for anything that is not a parseable http(s) URL. */
function productUrlHostname(productUrl: string): string | null {
  try {
    const url = new URL(productUrl);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }

    return url.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Pure host comparison for the legacy attach gate. Exported for unit tests.
 *
 * `shopDomain` must already be normalized (`resolveSourceShopDomainForBrand`
 * routes it through `externalAccountIdFromShopDomain` + `normalizeShopDomain`,
 * which lowercases and validates the domain shape). Domain normalization is
 * never reimplemented here.
 */
export function productUrlMatchesShopDomain(
  productUrl: string,
  shopDomain: string | null,
): boolean {
  if (!shopDomain) {
    return false;
  }

  const hostname = productUrlHostname(productUrl);
  return hostname !== null && hostname === shopDomain.toLowerCase().replace(/^www\./, "");
}

/**
 * LEGACY-MODE ATTACH AUTHORIZATION.
 *
 * A legacy attach lets the creator supply the productUrl verbatim. Selecting a
 * brand therefore used to be enough to stamp an arbitrary third-party URL —
 * including a competitor's — with a legitimate brand's id and source shop
 * domain. This is the gate that closes that: the URL must actually belong to
 * the selected brand's store.
 *
 * A URL is accepted when EITHER:
 *
 *  1. its hostname equals the brand's current normalized Shopify shop domain
 *     (the `*.myshopify.com` domain the brand connected), OR
 *  2. that exact URL already exists in the brand's OWN synced catalog
 *     (`ConnectedCommerceProduct` for this brandId). Shopify's
 *     `onlineStoreUrl` — which is what the legacy product picker returns and
 *     what a creator pastes — uses the merchant's CUSTOM storefront domain, so
 *     rule 1 alone would reject legitimate attaches for every brand that has
 *     one. This second rule is still fully server-derived: it proves ownership
 *     from the brand's own synced rows, never from client input.
 *
 * `brandId: null` is allowed through: the Experience has no brand-owning
 * campaign, so no brand's authorization is being claimed and there is nothing
 * to impersonate. Likewise a brand with no connected shop domain and no synced
 * catalog has no domain to verify against; that case is allowed and is
 * unchanged from today's behavior.
 */
export async function assertProductUrlMatchesBrandDomain(options: {
  productUrl: string;
  brandId: string | null;
  candidateBrands: CandidateBrand[];
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { productUrl, brandId, candidateBrands } = options;

  if (!brandId) {
    return { ok: true };
  }

  const shopDomain = resolveSourceShopDomainForBrand(candidateBrands, brandId);

  if (productUrlMatchesShopDomain(productUrl, shopDomain)) {
    return { ok: true };
  }

  const ownedByBrand = await prisma.connectedCommerceProduct.findFirst({
    where: { brandId, productUrl },
    select: { id: true },
  });

  if (ownedByBrand) {
    return { ok: true };
  }

  if (!shopDomain) {
    // Nothing to verify against: no connected shop domain and no synced
    // catalog row. Preserves the pre-existing behavior for unconnected brands.
    return { ok: true };
  }

  return {
    ok: false,
    error: "Product URL must point at the selected brand's store.",
  };
}

type ProductInputResult =
  | {
      ok: true;
      value: {
        productUrl: string;
        title: string | null;
        imageUrl: string | null;
        priceText: string | null;
        currency: string | null;
        brandId: string | null;
      };
    }
  | {
      ok: false;
      error: string;
    };

function toNullableString(value: unknown) {
  const normalized = String(value || "").trim();
  return normalized ? normalized : null;
}

export function normalizeProductUrl(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    return "";
  }

  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    return url.toString();
  } catch {
    return trimmed;
  }
}

function normalizeCurrency(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  return normalized || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function getLessonProductManagementContext(
  lessonId: string,
): Promise<
  | { ok: false; status: number; error: string }
  | { ok: true; data: LessonProductManagementContext }
> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || null;
  const role = session?.user?.role || null;

  if (!userId) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }

  if (role !== "CREATOR" && role !== "ADMIN") {
    return { ok: false, status: 403, error: "Creator or admin access required." };
  }

  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      title: true,
      course: {
        select: {
          id: true,
          title: true,
          experience: {
            select: {
              id: true,
              title: true,
              slug: true,
              creator: {
                select: {
                  userId: true,
                },
              },
              campaigns: {
                // `sortOrder` is brand-writable and not unique, so it alone
                // leaves ties undefined. The `campaignId` tiebreak matches the
                // code-level tiebreak in `buildEligibleCampaignContexts`.
                orderBy: [{ sortOrder: "asc" }, { campaignId: "asc" }],
                select: {
                  sortOrder: true,
                  campaign: {
                    select: {
                      id: true,
                      name: true,
                      brandId: true,
                      commerceProductCurationEnabled: true,
                      brand: {
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
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!lesson) {
    return { ok: false, status: 404, error: "Lesson not found." };
  }

  if (role === "CREATOR" && lesson.course.experience.creator.userId !== userId) {
    return { ok: false, status: 403, error: "Lesson access denied." };
  }

  const brandMap = new Map<string, CandidateBrand>();
  lesson.course.experience.campaigns.forEach((item) => {
    const brand = item.campaign.brand;

    if (brand && !brandMap.has(brand.id)) {
      brandMap.set(brand.id, brand);
    }
  });

  const candidateBrands = Array.from(brandMap.values());
  const campaigns = lesson.course.experience.campaigns.map((item) => ({
    id: item.campaign.id,
    name: item.campaign.name,
    brandId: item.campaign.brandId,
    brandName: item.campaign.brand?.name ?? null,
    sortOrder: item.sortOrder,
    commerceProductCurationEnabled: item.campaign.commerceProductCurationEnabled,
  }));

  const campaignContexts = buildEligibleCampaignContexts(
    campaigns.map((campaign) => ({
      campaignId: campaign.id,
      campaignName: campaign.name,
      sortOrder: campaign.sortOrder,
      brandId: campaign.brandId,
      brandName: campaign.brandName,
      curationEnabled: campaign.commerceProductCurationEnabled,
    })),
  );

  return {
    ok: true,
    data: {
      actor: {
        userId,
        role,
      },
      lesson: {
        id: lesson.id,
        title: lesson.title,
        course: {
          id: lesson.course.id,
          title: lesson.course.title,
          experience: {
            id: lesson.course.experience.id,
            title: lesson.course.experience.title,
            slug: lesson.course.experience.slug,
            creatorUserId: lesson.course.experience.creator.userId,
          },
        },
      },
      candidateBrands,
      campaigns,
      campaignContexts,
    },
  };
}

export async function loadLessonProductLinks(lessonId: string) {
  const items = await prisma.lessonProductLink.findMany({
    where: {
      lessonId,
    },
    orderBy: [{ createdAt: "desc" }],
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

  return items satisfies LessonProductLinkRecord[];
}

/**
 * The campaign-scoped identity of one lesson product attachment.
 * `legacyLessonProductLinkId` is the LessonProductLink snapshot this
 * attachment displays through, or null when it has none.
 */
export type CampaignLessonProductScope = {
  campaignId: string;
  brandId: string;
  lessonId: string;
  brandCommerceProductId: string;
  legacyLessonProductLinkId: string | null;
};

/**
 * Creates or reactivates the campaign-scoped attachment row for one
 * (campaign, lesson, brand product) tuple. Mirrors CampaignCommerceProduct's
 * reactivate-don't-duplicate lifecycle: the unique tuple index makes a second
 * active row structurally impossible, so a previously deactivated attachment
 * is revived rather than duplicated.
 *
 * Must be called inside the same transaction as the LessonProductLink write it
 * accompanies, so an attachment is never half-written.
 *
 * At most one scoping row may claim a given snapshot (`legacyLessonProductLinkId`
 * is unique). Callers must create a distinct snapshot before attaching the
 * same catalog product under a different campaign. An unbound active scope is
 * unusable for public rendering and click authorization, so refusing it is
 * safer than silently recording an attachment that can never be displayed.
 */
export async function upsertCampaignLessonProductScope(
  tx: Prisma.TransactionClient,
  scope: CampaignLessonProductScope,
): Promise<void> {
  const legacyLessonProductLinkId = scope.legacyLessonProductLinkId;

  if (legacyLessonProductLinkId) {
    const claimed = await tx.campaignLessonProduct.findUnique({
      where: { legacyLessonProductLinkId },
      select: { campaignId: true, lessonId: true, brandCommerceProductId: true },
    });

    if (
      claimed &&
      (claimed.campaignId !== scope.campaignId ||
        claimed.lessonId !== scope.lessonId ||
        claimed.brandCommerceProductId !== scope.brandCommerceProductId)
    ) {
      throw new Error("Campaign lesson product snapshot is already scoped to another campaign");
    }
  }

  await tx.campaignLessonProduct.upsert({
    where: {
      campaignId_lessonId_brandCommerceProductId: {
        campaignId: scope.campaignId,
        lessonId: scope.lessonId,
        brandCommerceProductId: scope.brandCommerceProductId,
      },
    },
    create: {
      brandId: scope.brandId,
      campaignId: scope.campaignId,
      lessonId: scope.lessonId,
      brandCommerceProductId: scope.brandCommerceProductId,
      legacyLessonProductLinkId,
      isActive: true,
    },
    update: {
      isActive: true,
      deactivatedAt: null,
      // Only rebind when we have a binding we are allowed to take; never clear
      // an existing one as a side effect of reactivation.
      ...(legacyLessonProductLinkId ? { legacyLessonProductLinkId } : {}),
    },
    select: { id: true },
  });
}

/**
 * Detaches and deactivates the scoping row bound to a LessonProductLink whose
 * snapshot is about to be deleted or repointed.
 *
 * The database FK is ON DELETE SET NULL, which detaches but leaves the row
 * ACTIVE. This is the application-layer half of that contract documented in
 * migration 20260807140000: an active attachment must never point at a null
 * legacy link, so it is deactivated (with `deactivatedAt`) rather than deleted
 * — the campaign-scoped attribution history is kept.
 *
 * `keep` names the tuple that is legitimately taking over this snapshot (a
 * PATCH replacing a product with itself); that row is left untouched.
 *
 * Must be called inside the same transaction as the delete/update it precedes.
 */
export async function detachCampaignLessonProductFromLink(
  tx: Prisma.TransactionClient,
  options: {
    legacyLessonProductLinkId: string;
    keep?: {
      campaignId: string;
      lessonId: string;
      brandCommerceProductId: string;
    } | null;
  },
): Promise<void> {
  const existing = await tx.campaignLessonProduct.findUnique({
    where: { legacyLessonProductLinkId: options.legacyLessonProductLinkId },
    select: {
      id: true,
      campaignId: true,
      lessonId: true,
      brandCommerceProductId: true,
    },
  });

  if (!existing) {
    return;
  }

  const keep = options.keep;

  if (
    keep &&
    keep.campaignId === existing.campaignId &&
    keep.lessonId === existing.lessonId &&
    keep.brandCommerceProductId === existing.brandCommerceProductId
  ) {
    return;
  }

  await tx.campaignLessonProduct.update({
    where: { id: existing.id },
    data: {
      isActive: false,
      deactivatedAt: new Date(),
      legacyLessonProductLinkId: null,
    },
  });
}

/**
 * Best-effort resolution of a legacy (free-form) product URL to the brand's own
 * catalog row, so a legacy attach can still be campaign-scoped.
 *
 * A CampaignLessonProduct structurally requires a BrandCommerceProduct, and a
 * legacy attach has no catalog product by definition. Matching on exact
 * productUrl within the brand's own synced catalog is a sound ownership proof:
 * both the brand id and the URL come from the brand's own synced rows. Returns
 * null when the brand has not synced (or does not sell) that product, in which
 * case the attach proceeds unscoped exactly as it does today.
 */
export async function findBrandCommerceProductIdForProductUrl(options: {
  brandId: string;
  productUrl: string;
}): Promise<string | null> {
  const row = await prisma.brandCommerceProduct.findFirst({
    where: {
      brandId: options.brandId,
      connectedProduct: {
        brandId: options.brandId,
        productUrl: options.productUrl,
      },
    },
    select: { id: true },
  });

  return row?.id ?? null;
}

export function parseLessonProductInput(
  input: unknown,
  options: {
    defaultBrandId?: string | null;
    /**
     * Required. The brands this request may attach under, already resolved
     * server-side from the selected campaign context. An EMPTY list means no
     * brand may be claimed at all — previously an empty list disabled the
     * check entirely and let a client-supplied brandId through verbatim.
     */
    allowedBrandIds: string[];
  },
): ProductInputResult {
  const body = isRecord(input) ? input : {};
  const product = isRecord(body.product) ? body.product : {};

  const productUrl = normalizeProductUrl(
    String(product.productUrl || body.productUrl || "").trim(),
  );
  const title = toNullableString(product.title || body.title);
  const imageUrl = toNullableString(
    product.imageUrl ||
      (Array.isArray(product.images) ? product.images[0] : null) ||
      body.imageUrl,
  );
  const currency =
    normalizeCurrency(product.currency || body.currency) ||
    (product.priceRange ? "USD" : null);

  const range = isRecord(product.priceRange) ? product.priceRange : null;
  const minPrice =
    typeof range?.min === "number" && Number.isFinite(range.min)
      ? range.min
      : null;
  const maxPrice =
    typeof range?.max === "number" && Number.isFinite(range.max)
      ? range.max
      : null;

  let priceText = toNullableString(product.priceText || body.priceText);

  if (!priceText && (minPrice !== null || maxPrice !== null)) {
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    });

    if (minPrice !== null && maxPrice !== null && minPrice !== maxPrice) {
      priceText = `${formatter.format(minPrice)} - ${formatter.format(maxPrice)}`;
    } else if (minPrice !== null) {
      priceText = formatter.format(minPrice);
    } else if (maxPrice !== null) {
      priceText = formatter.format(maxPrice);
    }
  }

  const requestedBrandId = toNullableString(product.brandId || body.brandId);
  const allowedBrandIds = new Set(options.allowedBrandIds);

  if (requestedBrandId && !allowedBrandIds.has(requestedBrandId)) {
    return {
      ok: false,
      error: "Selected brand is not available for this lesson.",
    };
  }

  if (!productUrl) {
    return {
      ok: false,
      error: "productUrl is required.",
    };
  }

  try {
    const url = new URL(productUrl);

    if (!["http:", "https:"].includes(url.protocol)) {
      return {
        ok: false,
        error: "productUrl must be an absolute http or https URL.",
      };
    }
  } catch {
    return {
      ok: false,
      error: "productUrl must be a valid URL.",
    };
  }

  return {
    ok: true,
    value: {
      productUrl,
      title,
      imageUrl,
      priceText,
      currency,
      brandId: requestedBrandId || options.defaultBrandId || null,
    },
  };
}
