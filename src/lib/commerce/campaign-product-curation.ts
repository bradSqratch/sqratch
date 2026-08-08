import prisma from "@/lib/prisma";
import {
  buildEligibleCampaignContexts,
  resolveCampaignSelection,
  type CampaignContextCandidate,
  type CampaignContextMode,
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
  commerceProductCurationEnabled: boolean;
};

export type CampaignSelectorOption = {
  id: string;
  name: string;
  brandId: string;
  brandName: string | null;
  /** Lets one selector render curated and legacy contexts together without
   * collapsing either into the other. */
  mode: CampaignContextMode;
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
  | { kind: "legacy"; campaign: CampaignContextCandidate }
  | { kind: "curated"; campaign: CampaignContextCandidate };

function toSelectorOption(context: CampaignContextCandidate): CampaignSelectorOption {
  return {
    id: context.campaignId,
    name: context.campaignName,
    brandId: context.brandId,
    brandName: context.brandName,
    mode: context.mode,
  };
}

/**
 * Resolves which campaign context a creator product mutation operates in, from
 * the campaigns actually linked to the lesson's Experience.
 *
 * This is now a thin policy layer over the shared resolver in
 * `src/lib/campaign-context.ts`; the 0/1/N and explicit-selection rules live
 * there and are identical for curated and legacy contexts. One policy is
 * applied here on top of the generic resolution:
 *
 * NO SILENT FIRST-OF-SEVERAL. Ambiguity is an explicit API state
 * (`selection_required`), never a guess, and a client-supplied campaign id is
 * always validated rather than dropped. The previous implementation returned
 * `{ kind: "legacy" }` before it ever looked at `requestedCampaignId`, so on a
 * legacy Experience the id was silently ignored.
 *
 * EVERY eligible context is selectable, whatever the curation mix on the
 * Experience is. A curated campaign does not make a curation-disabled sibling
 * unselectable, because authorization is self-contained per context rather
 * than per Experience: a curated context still has to satisfy the full strict
 * chain (`commerceProductCurationEnabled`, an active `CampaignCommerceProduct`,
 * `isCampaignEligible`, `isAvailable`, same-brand pinning), and a legacy
 * context still has to satisfy `assertProductUrlMatchesBrandDomain`. Selecting
 * a legacy sibling therefore grants no access to a curated sibling's catalog or
 * authorization — it only ever operates under its own campaign's own policy,
 * which is a per-campaign choice that campaign's own brand made. Cross-context
 * isolation is enforced downstream by campaign-scoped `CampaignLessonProduct`
 * rows (rendering and scoping are per-campaign, not per-Experience), never by
 * hiding sibling campaigns from the selector.
 *
 * `{ kind: "none" }` means the Experience has no eligible (brand-owning)
 * campaign at all. That is the pre-existing free-form case: there is no brand
 * to authorize against, and callers keep their historical behavior of
 * accepting a link with a null brandId.
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
      curationEnabled: campaign.commerceProductCurationEnabled,
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
      return selection.context.curationEnabled
        ? { kind: "curated", campaign: selection.context }
        : { kind: "legacy", campaign: selection.context };
  }
}

function formatPersistedPrice(product: AuthorizedCatalogProduct): string | null {
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
    const formatter = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
    });
    const divisor = 10 ** priceMinorUnitExponent;
    const min = formatter.format(priceMinMinor / divisor);
    const max = formatter.format(priceMaxMinor / divisor);
    return priceMinMinor === priceMaxMinor ? min : `${min} - ${max}`;
  } catch {
    return null;
  }
}

/** Public-safe, response-compatible product row for the creator picker. */
export function toCreatorCatalogProduct(product: AuthorizedCatalogProduct) {
  return {
    // `id` intentionally becomes the internal catalog id in curated mode.
    // The legacy route keeps its provider id and unchanged contract.
    id: product.id,
    catalogProductId: product.id,
    title: product.title,
    handle: product.handle || "",
    productUrl: product.productUrl,
    images: product.images,
    imageUrl: product.imageUrl,
    priceRange: { min: null, max: null },
    priceText: formatPersistedPrice(product),
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
        commerceProductCurationEnabled: true,
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
        commerceProductCurationEnabled: true,
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
    ...assignment.brandCommerceProduct.connectedProduct,
  };
}

export const defaultCampaignCurationRepository: CampaignCurationRepository = {
  listAuthorizedProducts: defaultListAuthorizedProducts,
  findAuthorizedProduct: defaultFindAuthorizedProduct,
};

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
