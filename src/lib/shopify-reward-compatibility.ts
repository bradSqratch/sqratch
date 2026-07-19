import { normalizeShopDomain } from "@/lib/shopify";

export type ShopifyRewardCompatibilityReason =
  | "SHOPIFY_DISCONNECTED"
  | "CURRENCY_REVIEW_REQUIRED"
  | "PRODUCT_RESELECTION_REQUIRED"
  | "UNKNOWN_SOURCE_STORE";

export type ShopifyRewardCompatibility = {
  compatible: boolean;
  reasons: ShopifyRewardCompatibilityReason[];
  currentShopDomain: string | null;
  currentStoreCurrency: string | null;
  sourceShopDomain: string | null;
};

export function normalizeCurrency(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim().toUpperCase();
  return normalized || null;
}

/**
 * A reward is currency-dependent when its discount is a fixed monetary
 * amount, or when it has a minimum-subtotal threshold expressed in the
 * store's currency. A PERCENTAGE offer with no minimum subtotal is not.
 */
export function isCurrencyDependentOffer(offer: {
  discountType: "FIXED_AMOUNT" | "PERCENTAGE";
  minimumSubtotalCents: number | null;
}): boolean {
  return (
    offer.discountType === "FIXED_AMOUNT" ||
    offer.minimumSubtotalCents !== null
  );
}

/**
 * Computes whether a reward offer is compatible with the currently connected
 * Shopify store. Pure and independently testable — never touches the
 * database or the Shopify API. Callers derive `shopifyConnected` from the
 * Brand's current connection status/domain/token completeness, using the
 * same rules as the rest of the app (this helper does not duplicate that).
 *
 * `isActive` is intentionally not part of this helper: compatibility and
 * activation are separate concepts, checked independently by callers.
 */
export function computeShopifyRewardCompatibility(input: {
  offer: {
    discountType: "FIXED_AMOUNT" | "PERCENTAGE";
    minimumSubtotalCents: number | null;
    currencyCode: string;
    appliesTo: "ALL_PRODUCTS" | "SPECIFIC_PRODUCTS";
    sourceShopDomain: string | null;
  };
  shopifyConnected: boolean;
  currentShopDomain: string | null;
  currentStoreCurrency: string | null;
}): ShopifyRewardCompatibility {
  const reasons: ShopifyRewardCompatibilityReason[] = [];

  const currentShopDomain = normalizeShopDomain(input.currentShopDomain);
  const currentStoreCurrency = normalizeCurrency(input.currentStoreCurrency);
  const sourceShopDomain = normalizeShopDomain(input.offer.sourceShopDomain);

  if (!input.shopifyConnected) {
    reasons.push("SHOPIFY_DISCONNECTED");
  }

  const currencyDependent = isCurrencyDependentOffer(input.offer);

  if (currencyDependent) {
    const offerCurrency = normalizeCurrency(input.offer.currencyCode);

    if (!currentStoreCurrency || offerCurrency !== currentStoreCurrency) {
      reasons.push("CURRENCY_REVIEW_REQUIRED");
    }
  }

  if (input.offer.appliesTo === "SPECIFIC_PRODUCTS") {
    if (!sourceShopDomain) {
      reasons.push("UNKNOWN_SOURCE_STORE");
      reasons.push("PRODUCT_RESELECTION_REQUIRED");
    } else if (!currentShopDomain || sourceShopDomain !== currentShopDomain) {
      reasons.push("PRODUCT_RESELECTION_REQUIRED");
    }
  }

  return {
    compatible: reasons.length === 0,
    reasons,
    currentShopDomain,
    currentStoreCurrency,
    sourceShopDomain,
  };
}
