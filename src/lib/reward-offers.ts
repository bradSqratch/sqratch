import crypto from "crypto";
import type {
  BrandRewardOffer,
  BrandRewardOfferProduct,
  RewardAppliesTo,
} from "@prisma/client";
import { fetchNormalizedShopifyProducts } from "@/lib/shopify-products";
import { normalizeShopDomain } from "@/lib/shopify";
import {
  computeShopifyRewardCompatibility,
  isCurrencyDependentOffer,
  normalizeCurrency,
} from "@/lib/shopify-reward-compatibility";

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
  discountType: "FIXED_AMOUNT" | "PERCENTAGE";
  discountAmountCents: number | null;
  discountPercentageBasisPoints: number | null;
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
    sourceShopDomain: offer.sourceShopDomain,
    createdAt: offer.createdAt,
    updatedAt: offer.updatedAt,
    products: offer.products || [],
  };
}

/**
 * Authoritatively confirms every submitted product GID actually belongs to
 * the currently connected Shopify store, by cross-checking against a live
 * product fetch. Used when saving a SPECIFIC_PRODUCTS offer so a client
 * can't claim stale/spoofed product GIDs from a different store.
 */
export async function validateProductsBelongToConnectedStore(input: {
  shopDomain: string;
  brandId: string;
  products: Array<{ shopifyProductGid: string }>;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await fetchNormalizedShopifyProducts({
    shopDomain: input.shopDomain,
    brandId: input.brandId,
    limit: 250,
  });

  if (!result.ok) {
    return {
      ok: false,
      error: `Could not verify selected products against the connected Shopify store: ${result.error}`,
    };
  }

  const validGids = new Set(result.items.map((item) => item.shopifyProductGid));
  const invalid = input.products.filter(
    (product) => !validGids.has(product.shopifyProductGid),
  );

  if (invalid.length > 0) {
    return {
      ok: false,
      error: "One or more selected products are not available in the connected Shopify store.",
    };
  }

  return { ok: true };
}

export type RewardOfferUpdateResolution =
  | {
      ok: true;
      data: OfferPayload;
      sourceShopDomain: string | null;
    }
  | {
      ok: false;
      status: number;
      error: string;
      code: string;
      details?: Record<string, unknown>;
    };

/**
 * Resolves a Brand Admin PUT request against an existing reward offer into
 * either a stable error (currency review required, product reselection
 * required, incompatible activation, etc.) or the final field set to
 * persist. Pure aside from the injected `validateProducts` I/O callback —
 * independently testable without a database or Shopify API.
 *
 * Currency/product-source gates are evaluated against the EXISTING stored
 * offer, not the proposed request body: a currency-dependent offer whose
 * currency has drifted from the current store — or a SPECIFIC_PRODUCTS offer
 * whose source store no longer matches — must be explicitly reviewed before
 * any further save, never silently rewritten.
 */
export async function resolveRewardOfferUpdate(input: {
  existing: {
    discountType: "FIXED_AMOUNT" | "PERCENTAGE";
    minimumSubtotalCents: number | null;
    currencyCode: string;
    appliesTo: RewardAppliesTo;
    sourceShopDomain: string | null;
  };
  body: unknown;
  isConnected: boolean;
  currentShopDomain: string | null;
  currentStoreCurrency: string | null;
  validateProducts?: (
    products: OfferPayload["products"],
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
}): Promise<RewardOfferUpdateResolution> {
  const bodyRecord = (input.body || {}) as Record<string, unknown>;
  const currencyReviewAcknowledged =
    bodyRecord.currencyReviewAcknowledged === true;

  const existingCurrencyDependent = isCurrencyDependentOffer(input.existing);
  const existingCurrencyMismatch = Boolean(
    existingCurrencyDependent &&
      input.currentStoreCurrency &&
      normalizeCurrency(input.existing.currencyCode) !==
        input.currentStoreCurrency,
  );

  let resolvedCurrencyCode: string | null = input.existing.currencyCode;

  if (existingCurrencyMismatch) {
    if (!currencyReviewAcknowledged) {
      return {
        ok: false,
        status: 409,
        error: `This reward was configured for ${input.existing.currencyCode}, but the connected Shopify store uses ${input.currentStoreCurrency}. Review the currency before saving.`,
        code: "CURRENCY_REVIEW_REQUIRED",
        details: {
          offerCurrency: input.existing.currencyCode,
          currentStoreCurrency: input.currentStoreCurrency,
        },
      };
    }

    // Server-trusted currency, never the client-submitted value. The
    // monetary amount is never converted — only the currency label moves.
    resolvedCurrencyCode = input.currentStoreCurrency;
  }

  // --- Product reselection gate (checked on the raw proposed appliesTo,
  // BEFORE full structural parsing) ---------------------------------------
  // parseRewardOfferPayload's own "at least one product required" check
  // would otherwise shadow this with a generic INVALID_PAYLOAD error instead
  // of the specific, actionable PRODUCT_RESELECTION_REQUIRED code.
  const existingSourceDomain = normalizeShopDomain(
    input.existing.sourceShopDomain,
  );
  const priorSourceMatchesCurrent =
    input.existing.appliesTo === "SPECIFIC_PRODUCTS" &&
    Boolean(existingSourceDomain) &&
    Boolean(input.currentShopDomain) &&
    existingSourceDomain === input.currentShopDomain;

  const rawAppliesTo = String(bodyRecord.appliesTo || "ALL_PRODUCTS");
  const rawIsActive = Boolean(bodyRecord.isActive);
  const rawProductsLength = Array.isArray(bodyRecord.products)
    ? bodyRecord.products.length
    : 0;

  if (rawAppliesTo === "SPECIFIC_PRODUCTS" && !priorSourceMatchesCurrent) {
    // Either newly becoming SPECIFIC_PRODUCTS, or the existing source is
    // missing/stale (belongs to a different or unknown store) — a genuine
    // reselection from the current store is required.
    if (!input.isConnected || !input.currentShopDomain) {
      return {
        ok: false,
        status: 409,
        error: "Reconnect Shopify to select products from the current store.",
        code: "PRODUCT_RESELECTION_REQUIRED",
      };
    }

    if (rawProductsLength === 0) {
      return {
        ok: false,
        status: 409,
        error:
          "Select at least one product from the currently connected Shopify store.",
        code: "PRODUCT_RESELECTION_REQUIRED",
      };
    }

    if (rawIsActive) {
      return {
        ok: false,
        status: 400,
        error:
          "Save the reselected products first, then activate the offer in a separate request.",
        code: "PRODUCT_RESELECTION_REQUIRES_INACTIVE",
      };
    }
  }

  const parsed = parseRewardOfferPayload(input.body, resolvedCurrencyCode);

  if (!parsed.ok) {
    return { ok: false, status: 400, error: parsed.error, code: "INVALID_PAYLOAD" };
  }

  const data = parsed.data;

  if (existingCurrencyMismatch && data.isActive) {
    return {
      ok: false,
      status: 400,
      error:
        "Save the corrected currency first, then activate the offer in a separate request.",
      code: "CURRENCY_ACK_REQUIRES_INACTIVE",
    };
  }

  let sourceShopDomain: string | null;

  if (data.appliesTo === "SPECIFIC_PRODUCTS") {
    sourceShopDomain = input.isConnected
      ? input.currentShopDomain
      : existingSourceDomain;

    if (input.isConnected && data.products.length > 0 && input.validateProducts) {
      const validation = await input.validateProducts(data.products);

      if (!validation.ok) {
        return {
          ok: false,
          status: 400,
          error: validation.error,
          code: "PRODUCT_VALIDATION_FAILED",
        };
      }
    }
  } else {
    sourceShopDomain = input.isConnected
      ? input.currentShopDomain
      : normalizeShopDomain(input.existing.sourceShopDomain);
  }

  if (data.isActive) {
    const compatibility = computeShopifyRewardCompatibility({
      offer: {
        discountType: data.discountType,
        minimumSubtotalCents: data.minimumSubtotalCents,
        currencyCode: resolvedCurrencyCode ?? data.currencyCode,
        appliesTo: data.appliesTo,
        sourceShopDomain,
      },
      shopifyConnected: input.isConnected,
      currentShopDomain: input.currentShopDomain,
      currentStoreCurrency: input.currentStoreCurrency,
    });

    if (!compatibility.compatible) {
      return {
        ok: false,
        status: 409,
        error: compatibility.reasons.includes("SHOPIFY_DISCONNECTED")
          ? "Reconnect Shopify before creating or enabling reward offers."
          : "This offer is not compatible with the connected Shopify store.",
        code: "INCOMPATIBLE_OFFER",
        details: { reasons: compatibility.reasons },
      };
    }
  }

  return { ok: true, data, sourceShopDomain };
}

