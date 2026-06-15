import crypto from "crypto";
import type {
  BrandRewardOffer,
  BrandRewardOfferProduct,
  RewardAppliesTo,
} from "@prisma/client";

export { CLAIM_COUNTED_REDEMPTION_STATUSES } from "./reward-redemption-state";

export type RewardOfferAvailabilityStatus =
  | "CLAIMABLE"
  | "INACTIVE"
  | "NOT_STARTED"
  | "CLAIM_WINDOW_ENDED"
  | "LIMIT_REACHED"
  | "USER_LIMIT_REACHED"
  | "SHOPIFY_DISCONNECTED";

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

export function getRewardOfferAvailability(input: {
  offer: Pick<
    BrandRewardOffer,
    | "isActive"
    | "claimStartsAt"
    | "claimEndsAt"
    | "maxTotalRedemptions"
    | "maxRedemptionsPerUser"
  >;
  shopifyConnected: boolean;
  totalRedemptions?: number;
  userRedemptions?: number;
  now?: Date;
}): {
  status: RewardOfferAvailabilityStatus;
  label: string;
  claimable: boolean;
} {
  const now = input.now || new Date();
  const totalRedemptions = input.totalRedemptions || 0;
  const userRedemptions = input.userRedemptions || 0;

  if (!input.offer.isActive) {
    return {
      status: "INACTIVE",
      label: "Inactive",
      claimable: false,
    };
  }

  if (!input.shopifyConnected) {
    return {
      status: "SHOPIFY_DISCONNECTED",
      label: "Unavailable - Shopify disconnected",
      claimable: false,
    };
  }

  if (input.offer.claimStartsAt && input.offer.claimStartsAt > now) {
    return {
      status: "NOT_STARTED",
      label: "Not started",
      claimable: false,
    };
  }

  if (input.offer.claimEndsAt && input.offer.claimEndsAt < now) {
    return {
      status: "CLAIM_WINDOW_ENDED",
      label: "Claim window ended",
      claimable: false,
    };
  }

  if (
    input.offer.maxTotalRedemptions &&
    totalRedemptions >= input.offer.maxTotalRedemptions
  ) {
    return {
      status: "LIMIT_REACHED",
      label: "Limit reached",
      claimable: false,
    };
  }

  if (
    input.offer.maxRedemptionsPerUser &&
    userRedemptions >= input.offer.maxRedemptionsPerUser
  ) {
    return {
      status: "USER_LIMIT_REACHED",
      label: "User limit reached",
      claimable: false,
    };
  }

  return {
    status: "CLAIMABLE",
    label: "Claimable",
    claimable: true,
  };
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

export function parseRewardOfferPayload(body: unknown, shopCurrency: string | null) {
  const payload = (body || {}) as Record<string, unknown>;
  const title = String(payload.title || "").trim();
  const pointsCost = Number(payload.pointsCost);
  const discountType = payload.discountType ? String(payload.discountType).trim().toUpperCase() : "FIXED_AMOUNT";

  const discountAmountCents = payload.discountAmountCents !== undefined && payload.discountAmountCents !== null && payload.discountAmountCents !== ""
    ? Number(payload.discountAmountCents)
    : null;
  const discountPercentageBasisPoints = payload.discountPercentageBasisPoints !== undefined && payload.discountPercentageBasisPoints !== null && payload.discountPercentageBasisPoints !== ""
    ? Number(payload.discountPercentageBasisPoints)
    : null;

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

  if (!["FIXED_AMOUNT", "PERCENTAGE"].includes(discountType)) {
    return { ok: false as const, error: "Invalid discount type." };
  }

  if (!shopCurrency) {
    return {
      ok: false as const,
      error: "Shopify store currency is unknown. Reconnect Shopify or sync store status first.",
    };
  }

  const cleanCurrency = shopCurrency.trim().toUpperCase();

  if (discountType === "FIXED_AMOUNT") {
    if (discountAmountCents === null || !Number.isInteger(discountAmountCents) || discountAmountCents <= 0) {
      return {
        ok: false as const,
        error: "Discount amount must be a positive integer.",
      };
    }
    if (discountPercentageBasisPoints !== null) {
      return {
        ok: false as const,
        error: "Percentage value must be absent for fixed discounts.",
      };
    }
    if (!["CAD", "USD"].includes(cleanCurrency)) {
      return {
        ok: false as const,
        error: `Fixed discounts support CAD and USD stores only. Store currency is ${cleanCurrency}.`,
      };
    }
  } else {
    // PERCENTAGE
    if (
      discountPercentageBasisPoints === null ||
      !Number.isInteger(discountPercentageBasisPoints) ||
      discountPercentageBasisPoints < 1 ||
      discountPercentageBasisPoints > 10000
    ) {
      return {
        ok: false as const,
        error: "Discount percentage must be an integer between 1 and 10000 basis points.",
      };
    }
    if (discountAmountCents !== null) {
      return {
        ok: false as const,
        error: "Fixed discount amount must be absent for percentage discounts.",
      };
    }
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
      discountType: discountType as "FIXED_AMOUNT" | "PERCENTAGE",
      discountAmountCents,
      discountPercentageBasisPoints,
      currencyCode: cleanCurrency,
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
    discountType: offer.discountType,
    discountAmountCents: offer.discountAmountCents,
    discountPercentageBasisPoints: offer.discountPercentageBasisPoints,
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

export function validateCurrencyMatch(offerCurrency: string | null, storeCurrency: string | null) {
  if (offerCurrency && storeCurrency && offerCurrency !== storeCurrency) {
    throw new Error("CURRENCY_MISMATCH");
  }
}

