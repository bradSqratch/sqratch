import prisma from "@/lib/prisma";

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
  commerceProductCurationEnabled: boolean;
};

export type CampaignSelectorOption = {
  id: string;
  name: string;
  brandId: string;
};

export type AuthorizedCatalogProduct = {
  id: string;
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

type ApplicableCampaign = LessonCampaignContext & { brandId: string };

export type CampaignCurationResolution =
  | { kind: "legacy" }
  | { kind: "selection_required"; campaigns: CampaignSelectorOption[] }
  | { kind: "curated"; campaign: ApplicableCampaign };

/**
 * Resolves the policy from campaigns actually linked to the lesson's
 * Experience. We never select "the first" curated campaign: ambiguity is an
 * explicit UI/API state. Legacy-only experiences retain their exact picker
 * behavior, including their existing primary-brand selection.
 */
export function resolveCampaignCuration(
  campaigns: LessonCampaignContext[],
  requestedCampaignId: string | null | undefined,
): CampaignCurationResolution | { kind: "invalid_campaign" } {
  const applicable = campaigns.filter(
    (campaign): campaign is ApplicableCampaign => Boolean(campaign.brandId),
  );

  const curated = applicable.filter((campaign) => campaign.commerceProductCurationEnabled);
  if (curated.length === 0) {
    return { kind: "legacy" };
  }

  if (requestedCampaignId) {
    // A disabled sibling campaign must never be a curation bypass when this
    // Experience also has an enabled curated campaign. Only a currently
    // curated, actually linked campaign is a valid explicit selection.
    const selected = curated.find((campaign) => campaign.id === requestedCampaignId);
    return selected ? { kind: "curated", campaign: selected } : { kind: "invalid_campaign" };
  }

  if (curated.length === 1) {
    return { kind: "curated", campaign: curated[0] };
  }

  return {
    kind: "selection_required",
    campaigns: curated.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      brandId: campaign.brandId,
    })),
  };
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

  return assignment?.brandCommerceProduct.connectedProduct ?? null;
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
