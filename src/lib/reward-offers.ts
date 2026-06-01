import crypto from "crypto";
import type {
  BrandRewardOffer,
  BrandRewardOfferProduct,
  RewardAppliesTo,
} from "@prisma/client";

export const CLAIM_COUNTED_REDEMPTION_STATUSES = [
  "PENDING",
  "POINTS_DEBITED",
  "ISSUED",
  "USED",
  "EXPIRED",
] as const;

type OfferPayload = {
  title: string;
  description: string | null;
  isActive: boolean;
  pointsCost: number;
  discountAmountCents: number;
  currencyCode: string;
  claimStartsAt: Date | null;
  claimEndsAt: Date | null;
  codeValidDays: number;
  appliesTo: RewardAppliesTo;
  minimumSubtotalCents: number | null;
  codePrefix: string | null;
  maxTotalRedemptions: number | null;
  maxRedemptionsPerUser: number | null;
  products: Array<{
    shopifyProductGid: string;
    title: string | null;
    imageUrl: string | null;
    productUrl: string | null;
  }>;
};

export function isOfferClaimable(
  offer: Pick<BrandRewardOffer, "isActive" | "claimStartsAt" | "claimEndsAt">,
  now = new Date(),
) {
  if (!offer.isActive) {
    return false;
  }

  if (offer.claimStartsAt && offer.claimStartsAt > now) {
    return false;
  }

  if (offer.claimEndsAt && offer.claimEndsAt < now) {
    return false;
  }

  return true;
}

function parseOptionalDate(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseOptionalPositiveInt(value: unknown) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

function parseProducts(value: unknown): OfferPayload["products"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      const product = item as Record<string, unknown>;
      const shopifyProductGid = String(
        product.shopifyProductGid || product.id || "",
      ).trim();

      if (!shopifyProductGid) {
        return null;
      }

      return {
        shopifyProductGid,
        title: product.title ? String(product.title).trim() : null,
        imageUrl: product.imageUrl ? String(product.imageUrl).trim() : null,
        productUrl: product.productUrl ? String(product.productUrl).trim() : null,
      };
    })
    .filter((product): product is OfferPayload["products"][number] =>
      Boolean(product),
    );
}

export function parseRewardOfferPayload(body: unknown) {
  const payload = (body || {}) as Record<string, unknown>;
  const title = String(payload.title || "").trim();
  const pointsCost = Number(payload.pointsCost);
  const discountAmountCents = Number(payload.discountAmountCents);
  const currencyCode = String(payload.currencyCode || "CAD")
    .trim()
    .toUpperCase();
  const codeValidDays = Number(payload.codeValidDays || 30);
  const appliesTo = String(payload.appliesTo || "ALL_PRODUCTS");
  const claimStartsAt = parseOptionalDate(payload.claimStartsAt);
  const claimEndsAt = parseOptionalDate(payload.claimEndsAt);
  const minimumSubtotalCents = parseOptionalPositiveInt(
    payload.minimumSubtotalCents,
  );
  const maxTotalRedemptions = parseOptionalPositiveInt(
    payload.maxTotalRedemptions,
  );
  const maxRedemptionsPerUser = parseOptionalPositiveInt(
    payload.maxRedemptionsPerUser,
  );
  const products = parseProducts(payload.products);

  if (!title) {
    return { ok: false as const, error: "Offer title is required." };
  }

  if (!Number.isInteger(pointsCost) || pointsCost <= 0) {
    return { ok: false as const, error: "pointsCost must be a positive integer." };
  }

  if (!Number.isInteger(discountAmountCents) || discountAmountCents <= 0) {
    return {
      ok: false as const,
      error: "discountAmountCents must be a positive integer.",
    };
  }

  if (!/^[A-Z]{3}$/.test(currencyCode)) {
    return { ok: false as const, error: "currencyCode must be a 3-letter code." };
  }

  if (!Number.isInteger(codeValidDays) || codeValidDays < 1 || codeValidDays > 365) {
    return {
      ok: false as const,
      error: "codeValidDays must be between 1 and 365.",
    };
  }

  if (!["ALL_PRODUCTS", "SPECIFIC_PRODUCTS"].includes(appliesTo)) {
    return { ok: false as const, error: "Invalid appliesTo value." };
  }

  if (claimStartsAt && claimEndsAt && claimEndsAt <= claimStartsAt) {
    return {
      ok: false as const,
      error: "claimEndsAt must be after claimStartsAt.",
    };
  }

  if (appliesTo === "SPECIFIC_PRODUCTS" && products.length === 0) {
    return {
      ok: false as const,
      error: "At least one Shopify product is required for this offer.",
    };
  }

  return {
    ok: true as const,
    data: {
      title,
      description: payload.description
        ? String(payload.description).trim()
        : null,
      isActive: Boolean(payload.isActive),
      pointsCost,
      discountAmountCents,
      currencyCode,
      claimStartsAt,
      claimEndsAt,
      codeValidDays,
      appliesTo: appliesTo as RewardAppliesTo,
      minimumSubtotalCents,
      codePrefix: payload.codePrefix
        ? String(payload.codePrefix).trim().toUpperCase().slice(0, 16)
        : null,
      maxTotalRedemptions,
      maxRedemptionsPerUser,
      products,
    },
  };
}

export function generateRewardCode(prefix?: string | null) {
  const safePrefix = (prefix || "SQRATCH")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 12);
  const random = crypto.randomBytes(8).toString("hex").toUpperCase();

  return `${safePrefix || "SQRATCH"}-${random}`;
}

export function serializeRewardOffer(
  offer: BrandRewardOffer & { products?: BrandRewardOfferProduct[] },
) {
  return {
    id: offer.id,
    brandId: offer.brandId,
    title: offer.title,
    description: offer.description,
    isActive: offer.isActive,
    pointsCost: offer.pointsCost,
    discountAmountCents: offer.discountAmountCents,
    currencyCode: offer.currencyCode,
    claimStartsAt: offer.claimStartsAt,
    claimEndsAt: offer.claimEndsAt,
    codeValidDays: offer.codeValidDays,
    appliesTo: offer.appliesTo,
    minimumSubtotalCents: offer.minimumSubtotalCents,
    codePrefix: offer.codePrefix,
    maxTotalRedemptions: offer.maxTotalRedemptions,
    maxRedemptionsPerUser: offer.maxRedemptionsPerUser,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
    products: offer.products || [],
  };
}
