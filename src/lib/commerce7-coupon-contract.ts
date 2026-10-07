import type { Commerce7RewardEligibility } from "./commerce7-reward-eligibility";

export type Commerce7CouponAppliesTo = "ALL_PRODUCTS" | "SPECIFIC_PRODUCTS";

/**
 * Every Commerce7 Coupon enum SQRATCH may send, in one place, so POST /coupon
 * cannot drift. Pure and client-safe: the Brand UI renders readiness from the
 * server's view of this table.
 *
 * A `null` entry means the value has NOT been observed for the Coupon object.
 * Such a branch fails closed; it is never filled with a guess:
 *  - Store / Everyone / Per Store / Dollar Off / Percentage Off / No Discount /
 *    Enabled come from the documented Coupon create example and the operator's
 *    real sandbox Coupon GET (appliesTo "Store", availableTo "Everyone").
 *  - Selected-product `appliesTo` is documented only for the sibling Promotion
 *    object, and Commerce7's public enums have drifted from live tenants (the
 *    live Product security reads "Tag" where the docs say "Group").
 *  - The Customer-tag `availableTo` value has no Coupon evidence at all.
 * To enable a branch, add a redacted sandbox Coupon GET to
 * tests/fixtures/commerce7-rewards and set its value here.
 */
export type CouponContract = {
  usageLimitType: string; usageLimit: number; shippingDiscountType: string; status: string;
  productDiscountType: { FIXED_AMOUNT: string; PERCENTAGE: string };
  availableTo: Record<Commerce7RewardEligibility, string | null>;
  appliesTo: Record<Commerce7CouponAppliesTo, string | null>;
};
export const COMMERCE7_COUPON_CONTRACT: CouponContract = {
  usageLimitType: "Per Store", usageLimit: 1, shippingDiscountType: "No Discount", status: "Enabled",
  productDiscountType: { FIXED_AMOUNT: "Dollar Off", PERCENTAGE: "Percentage Off" },
  availableTo: { ANYONE_WITH_CODE: "Everyone", CLAIMANT_ONLY: null },
  appliesTo: { ALL_PRODUCTS: "Store", SPECIFIC_PRODUCTS: null },
};

export type CouponScope = { appliesTo: string; appliesToObjectIds: string[] | null; availableTo: string; availableToObjectIds: string[] | null };
export type CouponScopeInput = { eligibilityMode: Commerce7RewardEligibility; appliesTo: Commerce7CouponAppliesTo; productIds: readonly string[]; customerTagId: string | null };
export type CouponScopeResult = { ok: true; scope: CouponScope } | { ok: false; unsupported: "SELECTED_PRODUCTS" | "CUSTOMER_TAG_RESTRICTION" | "INVALID_INPUT" };

export function commerce7CouponSupport(contract: CouponContract = COMMERCE7_COUPON_CONTRACT) {
  return {
    eligibility: { ANYONE_WITH_CODE: contract.availableTo.ANYONE_WITH_CODE !== null, CLAIMANT_ONLY: contract.availableTo.CLAIMANT_ONLY !== null },
    scope: { ALL_PRODUCTS: contract.appliesTo.ALL_PRODUCTS !== null, SPECIFIC_PRODUCTS: contract.appliesTo.SPECIFIC_PRODUCTS !== null },
  };
}
export function isCouponBranchSupported(eligibilityMode: Commerce7RewardEligibility, appliesTo: Commerce7CouponAppliesTo, contract: CouponContract = COMMERCE7_COUPON_CONTRACT) {
  const support = commerce7CouponSupport(contract);
  return support.eligibility[eligibilityMode] && support.scope[appliesTo];
}

/** The only place eligibility/scope become native `appliesTo`/`availableTo` fields. */
export function resolveCouponScope(input: CouponScopeInput, contract: CouponContract = COMMERCE7_COUPON_CONTRACT): CouponScopeResult {
  const availableTo = contract.availableTo[input.eligibilityMode];
  if (availableTo === null) return { ok: false, unsupported: "CUSTOMER_TAG_RESTRICTION" };
  const appliesTo = contract.appliesTo[input.appliesTo];
  if (appliesTo === null) return { ok: false, unsupported: "SELECTED_PRODUCTS" };
  let appliesToObjectIds: string[] | null = null;
  if (input.appliesTo === "SPECIFIC_PRODUCTS") {
    const ids = input.productIds;
    if (!ids.length || ids.length > 50 || ids.some((id) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) return { ok: false, unsupported: "INVALID_INPUT" };
    appliesToObjectIds = [...ids].sort();
  }
  let availableToObjectIds: string[] | null = null;
  if (input.eligibilityMode === "CLAIMANT_ONLY") {
    if (!input.customerTagId) return { ok: false, unsupported: "INVALID_INPUT" };
    availableToObjectIds = [input.customerTagId];
  }
  return { ok: true, scope: { appliesTo, appliesToObjectIds, availableTo, availableToObjectIds } };
}
