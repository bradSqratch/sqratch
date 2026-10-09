import type { Commerce7RewardEligibility } from "./commerce7-reward-eligibility";
import type { Commerce7CouponAppliesTo, Commerce7DiscountKind } from "./commerce7-coupon-contract";

/**
 * Why a Commerce7 reward cannot go live, in one closed vocabulary shared by the editor (before save), the offer list (stored
 * offers), the claimant listing and the server. Pure and client-safe. A blocker never changes stored state: an offer stays
 * Active or Inactive exactly as the Brand left it, while its blockers decide whether it may be enabled or claimed right now.
 */
export type Commerce7ActivationBlocker =
  /** A legacy discount saved as Claiming customer only. Discounts are bearer coupons only; it needs an explicit, confirmed edit. */
  | "CLAIMANT_DISCOUNT_RETIRED"
  | "SELECTED_PRODUCTS_UNVERIFIED"
  /** The native percentage unit (1/100 percent, so 15% = 1500) has not been confirmed by a live sandbox coupon. */
  | "PERCENTAGE_UNVERIFIED"
  | "EXCLUSIVE_SELECTION_INCOMPLETE"
  /** The exclusive product is secured to several Customer Tags; one-tag access is unverified on the storefront. */
  | "MULTI_TAG_UNVERIFIED"
  | "TAG_REMOVED"
  | "SECURITY_CHANGED"
  | "PRODUCT_UNAVAILABLE"
  | "CONFIGURATION_REVIEW";

/** Brand-facing reasons. Plain words only: no native enum, field name or identifier. */
export const COMMERCE7_ACTIVATION_BLOCKER_TEXT: Record<Commerce7ActivationBlocker, string> = {
  CLAIMANT_DISCOUNT_RETIRED: "Saved as Claiming customer only, which is no longer offered for discounts. Edit this reward and confirm Anyone with the code to enable it; until then the saved record is unchanged.",
  SELECTED_PRODUCTS_UNVERIFIED: "Selected products: a product-restricted Commerce7 coupon has not been verified for this store. Choose All products to go live.",
  PERCENTAGE_UNVERIFIED: "Percentage discount: SQRATCH writes 15% as Commerce7's native 1500 (a native 15 showed as 0.15% in live QA), but no sandbox coupon has confirmed that 1500 shows as 15% in Commerce7 Admin and at checkout. Save as a draft, or use a fixed amount to go live.",
  EXCLUSIVE_SELECTION_INCOMPLETE: "Choose the exclusive product and the Customer Tag SQRATCH grants.",
  MULTI_TAG_UNVERIFIED: "Several Customer Tags: one-tag access to this product has not been verified for this store.",
  TAG_REMOVED: "The granted Customer Tag no longer secures this product in Commerce7. Sync products and review this reward.",
  SECURITY_CHANGED: "The product is no longer secured to a Customer Tag in Commerce7. Sync products and review this reward.",
  PRODUCT_UNAVAILABLE: "The exclusive product is no longer synchronized and available. Sync products and review this reward.",
  CONFIGURATION_REVIEW: "This reward's stored configuration needs review.",
};

/** The server's view of which coupon options may go live (`commerce7CouponSupport`). A missing key fails closed. */
export type Commerce7ActivationSupport = {
  eligibility: Partial<Record<Commerce7RewardEligibility, boolean>>;
  scope: Partial<Record<Commerce7CouponAppliesTo, boolean>>;
  discount?: Partial<Record<Commerce7DiscountKind, boolean>>;
};
export type Commerce7CouponOptions = {
  rewardMode: "DISCOUNT" | "EXCLUSIVE_PRODUCT_ACCESS";
  eligibilityMode: Commerce7RewardEligibility;
  appliesTo: Commerce7CouponAppliesTo;
  discountEnabled: boolean;
  discountType: Commerce7DiscountKind;
};

/**
 * Blockers the native Coupon contract imposes on these options, in display order. An exclusive reward's optional discount is
 * a bearer coupon scoped to its one product, so only that scope and the discount kind apply to it; its claimant binding is
 * the Customer Tag grant, not a coupon restriction.
 */
export function commerce7CouponBlockers(options: Commerce7CouponOptions, support: Commerce7ActivationSupport): Commerce7ActivationBlocker[] {
  const blockers: Commerce7ActivationBlocker[] = [];
  if (options.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS") {
    if (options.discountEnabled && (support.eligibility.ANYONE_WITH_CODE !== true || support.scope.SPECIFIC_PRODUCTS !== true)) blockers.push("SELECTED_PRODUCTS_UNVERIFIED");
  } else {
    // Discount rewards are Anyone with the code only; a stored claimant-only discount is a legacy record awaiting review.
    if (options.eligibilityMode === "CLAIMANT_ONLY") blockers.push("CLAIMANT_DISCOUNT_RETIRED");
    else if (support.eligibility.ANYONE_WITH_CODE !== true) blockers.push("CONFIGURATION_REVIEW");
    if (support.scope[options.appliesTo] !== true) blockers.push("SELECTED_PRODUCTS_UNVERIFIED");
  }
  if (options.discountEnabled && options.discountType === "PERCENTAGE" && support.discount?.PERCENTAGE !== true) blockers.push("PERCENTAGE_UNVERIFIED");
  return blockers;
}

/**
 * A stored offer's current claim eligibility, separate from its stored Active/Inactive state:
 * READY (open for claims), NOT_STARTED / ENDED (claim window), SOLD_OUT, BLOCKED (see `blockers`) and INACTIVE (stored
 * Inactive; `blockers` then says whether Enable would be refused).
 */
export type Commerce7OfferEligibilityState = "READY" | "NOT_STARTED" | "ENDED" | "SOLD_OUT" | "BLOCKED" | "INACTIVE";
export type Commerce7OfferEligibility = { state: Commerce7OfferEligibilityState; blockers: Commerce7ActivationBlocker[] };
