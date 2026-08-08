import prisma from "@/lib/prisma";
import { formatMinorUnitPriceRange } from "@/lib/commerce/money";
import {
  buildEligibleCampaignContexts,
  resolveCampaignSelection,
  type CampaignContextCandidate,
} from "@/lib/campaign-context";

/**
 * Server-side campaign product curation for creator lesson attachments.
 *
 * This module deliberately speaks only in SQRATCH catalog ids. Provider ids,
 * provider metadata, and connection credentials never cross this boundary.
 */
export type LessonCampaignContext = {
  id: string;
  name: string;
  brandId: string | null;
  brandName: string | null;
  /** Persisted CampaignExperience.sortOrder; presentation only, never trusted
   * as a tiebreak on its own (see `src/lib/campaign-context.ts`). */
  sortOrder: number;
};

export type CampaignSelectorOption = {
  id: string;
  name: string;
  brandId: string;
  brandName: string | null;
};

export type AuthorizedCatalogProduct = {
  id: string;
  /** The BrandCommerceProduct id that authorized this product for the
   * campaign. Required to write the campaign-scoped CampaignLessonProduct row;
   * deliberately never included in any client-facing response. */
  brandCommerceProductId: string;
  brandId: string;
  title: string;
  handle: string | null;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  sku: string | null;
  currencyCode: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  priceMinorUnitExponent: number | null;
  /**
   * Brand-authored display overrides from `BrandCommerceProduct`. Selected here
   * so a lesson attachment renders the same brand-curated title/description the
   * Experience shop does — the previous selection omitted them entirely, which
   * is why lesson products silently ignored a brand's title override.
   *
   * These are brand-authored copy, never provider identity, and are safe to
   * expose in a creator/public response.
   */
  titleOverride: string | null;
  shortDescriptionOverride: string | null;
};

export type CampaignCurationRepository = {
  listAuthorizedProducts(input: {
    campaignId: string;
    brandId: string;
  }): Promise<Array<AuthorizedCatalogProduct & { displayOrder: number }>>;
  findAuthorizedProduct(input: {
    campaignId: string;
    brandId: string;
    catalogProductId: string;
  }): Promise<AuthorizedCatalogProduct | null>;
};

export type CampaignCurationResolution =
  | { kind: "none" }
  | { kind: "selection_required"; campaigns: CampaignSelectorOption[] }
  | { kind: "resolved"; campaign: CampaignContextCandidate };

function toSelectorOption(context: CampaignContextCandidate): CampaignSelectorOption {
  return {
    id: context.campaignId,
    name: context.campaignName,
    brandId: context.brandId,
    brandName: context.brandName,
  };
}

/**
 * Resolves which campaign context a creator product mutation operates in, from
 * the campaigns actually linked to the lesson's Experience.
 *
 * This is now a thin policy layer over the shared resolver in
 * `src/lib/campaign-context.ts`; the 0/1/N and explicit-selection rules live
 * there. One policy is applied here on top of the generic resolution:
 *
 * NO SILENT FIRST-OF-SEVERAL. Ambiguity is an explicit API state
 * (`selection_required`), never a guess, and a client-supplied campaign id is
 * always validated rather than dropped.
 *
 * PHASE 8: there is no longer a curated/legacy mode distinction. Every
 * eligible (brand-owning) context resolves through the SAME canonical
 * `CampaignCommerceProduct -> BrandCommerceProduct -> ConnectedCommerceProduct`
 * chain, so every eligible context is selectable on the same terms as every
 * other. Cross-context isolation is enforced downstream by campaign-scoped
 * `CampaignLessonProduct` rows (rendering and scoping are per-campaign, not
 * per-Experience), never by hiding sibling campaigns from the selector.
 *
 * `{ kind: "none" }` means the Experience has no eligible (brand-owning)
 * campaign at all: there is no brand to authorize against and no commerce
 * context.
 */
export function resolveCampaignCuration(
  campaigns: LessonCampaignContext[],
  requestedCampaignId: string | null | undefined,
): CampaignCurationResolution | { kind: "invalid_campaign" } {
  const contexts = buildEligibleCampaignContexts(
    campaigns.map((campaign) => ({
      campaignId: campaign.id,
      campaignName: campaign.name,
      sortOrder: campaign.sortOrder,
      brandId: campaign.brandId,
      brandName: campaign.brandName,
    })),
  );

  const selection = resolveCampaignSelection(contexts, requestedCampaignId);

  switch (selection.kind) {
    case "none":
      return { kind: "none" };
    case "invalid_campaign":
      return { kind: "invalid_campaign" };
    case "selection_required":
      return {
        kind: "selection_required",
        campaigns: selection.contexts.map(toSelectorOption),
      };
    case "resolved":
      return { kind: "resolved", campaign: selection.context };
  }
}

/**
 * Brand-authored title override wins when set and non-blank; otherwise the
 * title synced from the provider. Same precedence the Experience shop applies,
 * kept in one place so creator and public surfaces cannot drift.
 */
export function resolveCuratedProductTitle(product: {
  title: string;
  titleOverride: string | null;
}): string {
  return product.titleOverride?.trim() || product.title;
}

/**
 * One canonical lesson product attachment, as returned to the creator.
 *
 * `id` is the opaque `CampaignLessonProduct.id` and is the ONLY identifier in
 * this shape. `brandCommerceProductId`, `connectedProductId`, any provider GID
 * and any shop domain are deliberately absent: a creator client never needs
 * them, and echoing them back invites a client to send one as authorization
 * evidence.
 */
export type CreatorLessonProductItem = {
  id: string;
  lessonId: string;
  productUrl: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  priceText: string | null;
  currency: string | null;
  brandId: string;
  displayOrder: number;
  campaign: { id: string; name: string; brandName: string | null } | null;
  createdAt: Date;
};

/** Server-side projection of one canonical attachment into the creator shape. */
export function toCreatorLessonProductItem(input: {
  attachment: { id: string; lessonId: string; brandId: string; displayOrder: number; createdAt: Date };
  campaign: { id: string; name: string; brandName: string | null } | null;
  product: {
    productUrl: string;
    title: string;
    titleOverride: string | null;
    shortDescriptionOverride: string | null;
    imageUrl: string | null;
    currencyCode: string | null;
    priceMinMinor: number | null;
    priceMaxMinor: number | null;
    priceMinorUnitExponent: number | null;
  };
}): CreatorLessonProductItem {
  return {
    id: input.attachment.id,
    lessonId: input.attachment.lessonId,
    productUrl: input.product.productUrl,
    title: resolveCuratedProductTitle(input.product),
    description: input.product.shortDescriptionOverride,
    imageUrl: input.product.imageUrl,
    priceText: formatMinorUnitPriceRange(input.product),
    currency: input.product.currencyCode,
    brandId: input.attachment.brandId,
    displayOrder: input.attachment.displayOrder,
    campaign: input.campaign,
    createdAt: input.attachment.createdAt,
  };
}

/**
 * Canonical attachment projection. Deliberately carries NO eligibility filter
 * beyond `isActive`: an attachment a creator already made must stay visible
 * (and therefore removable) even after the underlying product becomes
 * ineligible, unavailable or deactivated. Only NEW/replacement attachments
 * fail closed — that asymmetry is an explicit Phase 4 guarantee.
 */
export const CANONICAL_ATTACHMENT_SELECT = {
  id: true,
  lessonId: true,
  brandId: true,
  displayOrder: true,
  createdAt: true,
  campaign: {
    select: {
      id: true,
      name: true,
      brand: { select: { name: true } },
    },
  },
  brandCommerceProduct: {
    select: {
      titleOverride: true,
      shortDescriptionOverride: true,
      connectedProduct: {
        select: {
          title: true,
          productUrl: true,
          imageUrl: true,
          currencyCode: true,
          priceMinMinor: true,
          priceMaxMinor: true,
          priceMinorUnitExponent: true,
        },
      },
    },
  },
} as const;

type CanonicalAttachmentRow = {
  id: string;
  lessonId: string;
  brandId: string;
  displayOrder: number;
  createdAt: Date;
  campaign: { id: string; name: string; brand: { name: string } | null } | null;
  brandCommerceProduct: {
    titleOverride: string | null;
    shortDescriptionOverride: string | null;
    connectedProduct: {
      title: string;
      productUrl: string;
      imageUrl: string | null;
      currencyCode: string | null;
      priceMinMinor: number | null;
      priceMaxMinor: number | null;
      priceMinorUnitExponent: number | null;
    };
  };
};

export function projectCanonicalAttachment(row: CanonicalAttachmentRow) {
  return toCreatorLessonProductItem({
    attachment: {
      id: row.id,
      lessonId: row.lessonId,
      brandId: row.brandId,
      displayOrder: row.displayOrder,
      createdAt: row.createdAt,
    },
    campaign: row.campaign
      ? {
          id: row.campaign.id,
          name: row.campaign.name,
          brandName: row.campaign.brand?.name ?? null,
        }
      : null,
    product: {
      ...row.brandCommerceProduct.connectedProduct,
      titleOverride: row.brandCommerceProduct.titleOverride,
      shortDescriptionOverride: row.brandCommerceProduct.shortDescriptionOverride,
    },
  });
}

/** Public-safe, response-compatible product row for the creator picker. */
export function toCreatorCatalogProduct(product: AuthorizedCatalogProduct) {
  return {
    // `id` is the internal catalog id.
    id: product.id,
    catalogProductId: product.id,
    title: product.title,
    handle: product.handle || "",
    productUrl: product.productUrl,
    images: product.images,
    imageUrl: product.imageUrl,
    priceRange: { min: null, max: null },
    priceText: formatMinorUnitPriceRange(product),
    currency: product.currencyCode || "USD",
    variantIds: [],
    sku: product.sku,
  };
}

async function defaultListAuthorizedProducts(input: {
  campaignId: string;
  brandId: string;
}): Promise<Array<AuthorizedCatalogProduct & { displayOrder: number }>> {
  return prisma.campaignCommerceProduct.findMany({
    where: {
      campaignId: input.campaignId,
      brandId: input.brandId,
      isActive: true,
      campaign: {
        id: input.campaignId,
        brandId: input.brandId,
      },
      brandCommerceProduct: {
        brandId: input.brandId,
        isCampaignEligible: true,
        connectedProduct: {
          brandId: input.brandId,
          isAvailable: true,
        },
      },
    },
    orderBy: [{ displayOrder: "asc" }, { id: "asc" }],
    select: {
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
              title: true,
              handle: true,
              productUrl: true,
              imageUrl: true,
              images: true,
              sku: true,
              currencyCode: true,
              priceMinMinor: true,
              priceMaxMinor: true,
              priceMinorUnitExponent: true,
            },
          },
        },
      },
    },
  }).then((rows) => rows.map((row) => ({
    displayOrder: row.displayOrder,
    brandCommerceProductId: row.brandCommerceProduct.id,
    titleOverride: row.brandCommerceProduct.titleOverride,
    shortDescriptionOverride: row.brandCommerceProduct.shortDescriptionOverride,
    ...row.brandCommerceProduct.connectedProduct,
  })));
}

async function defaultFindAuthorizedProduct(input: {
  campaignId: string;
  brandId: string;
  catalogProductId: string;
}): Promise<AuthorizedCatalogProduct | null> {
  const assignment = await prisma.campaignCommerceProduct.findFirst({
    where: {
      campaignId: input.campaignId,
      brandId: input.brandId,
      isActive: true,
      campaign: {
        id: input.campaignId,
        brandId: input.brandId,
      },
      brandCommerceProduct: {
        brandId: input.brandId,
        isCampaignEligible: true,
        connectedProduct: {
          id: input.catalogProductId,
          brandId: input.brandId,
          isAvailable: true,
        },
      },
    },
    select: {
      brandCommerceProduct: {
        select: {
          id: true,
          titleOverride: true,
          shortDescriptionOverride: true,
          connectedProduct: {
            select: {
              id: true,
              brandId: true,
              title: true,
              handle: true,
              productUrl: true,
              imageUrl: true,
              images: true,
              sku: true,
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

  if (!assignment) {
    return null;
  }

  return {
    brandCommerceProductId: assignment.brandCommerceProduct.id,
    titleOverride: assignment.brandCommerceProduct.titleOverride,
    shortDescriptionOverride: assignment.brandCommerceProduct.shortDescriptionOverride,
    ...assignment.brandCommerceProduct.connectedProduct,
  };
}

export const defaultCampaignCurationRepository: CampaignCurationRepository = {
  listAuthorizedProducts: defaultListAuthorizedProducts,
  findAuthorizedProduct: defaultFindAuthorizedProduct,
};

/**
 * Optional, bounded presentation order for a lesson attachment. Never
 * authorization-relevant — it only affects display order — and deliberately
 * bounded so a client cannot write an extreme value.
 */
export function parseDisplayOrder(input: unknown): number | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = (input as Record<string, unknown>).displayOrder;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 10_000) {
    return undefined;
  }
  return value;
}

export function parseCatalogProductId(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const body = input as Record<string, unknown>;
  const product = body.product && typeof body.product === "object" && !Array.isArray(body.product)
    ? body.product as Record<string, unknown>
    : {};
  const value = product.catalogProductId ?? body.catalogProductId;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
