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
 *    Enabled come from the documented Coupon create example, the operator's
 *    real sandbox Coupon GET, and live POST /v1/coupon 201s.
 *  - Selected products: `appliesTo: "Product"` with the exact product IDs in
 *    `appliesToObjectIds` returned HTTP 201 from the live public API
 *    (tests/fixtures/commerce7-rewards/live-coupon-create-product-201.json).
 *  - The Customer-tag `availableTo` value has no Coupon evidence at all, so
 *    claimant-only coupons stay unverified. Commerce7's public enums have
 *    drifted from live tenants (Product security reads "Tag" where the docs
 *    say "Group"), so no analogy is trusted.
 * To enable a branch, add a redacted sandbox Coupon response to
 * tests/fixtures/commerce7-rewards and set its value here.
 */
export type CouponContract = {
  /** WRITE (POST /v1/coupon), proven by live 201s: tests/fixtures/commerce7-rewards/live-coupon-create-201.json. */
  type: string; usageLimitType: string; usageLimit: number; status: string;
  discountType: { FIXED_AMOUNT: string; PERCENTAGE: string };
  /**
   * Native "Percentage Off" `discount` units per whole percent: 1/100 of a percent, the same scale as SQRATCH basis points.
   * Live evidence: a native 15 was 0.15% (live-coupon-percentage-observation.json), and a native 1500 is 15%: HTTP 201,
   * Admin "15.00% Off", checkout CA$29.00 → CA$4.35 off and CA$39.00 → CA$5.85 off
   * (tests/fixtures/commerce7-rewards/live-coupon-percentage-1500-observation.json). `verified` therefore lets percentage
   * rewards be activated, claimed and issued; it never activates an offer by itself and never rewrites an issued coupon.
   */
  percentage: { nativeUnitsPerPercent: number; verified: boolean };
  dollarOffDiscountApplies: string;
  cartRequirement: { none: string; minimum: string; countType: string };
  /** READ only: how a coupon GET reports "no shipping discount". Never written. */
  readNoShippingDiscount: string;
  availableTo: Record<Commerce7RewardEligibility, string | null>;
  appliesTo: Record<Commerce7CouponAppliesTo, string | null>;
};
export const COMMERCE7_COUPON_CONTRACT: CouponContract = {
  type: "Product", usageLimitType: "Per Store", usageLimit: 1, status: "Enabled",
  discountType: { FIXED_AMOUNT: "Dollar Off", PERCENTAGE: "Percentage Off" },
  percentage: { nativeUnitsPerPercent: 100, verified: true },
  dollarOffDiscountApplies: "Once Per Order",
  cartRequirement: { none: "None", minimum: "Minimum Purchase Amount", countType: "All Items" },
  readNoShippingDiscount: "No Discount",
  availableTo: { ANYONE_WITH_CODE: "Everyone", CLAIMANT_ONLY: null },
  appliesTo: { ALL_PRODUCTS: "Store", SPECIFIC_PRODUCTS: "Product" },
};

export type CouponScope = { appliesTo: string; appliesToObjectIds: string[] | null; availableTo: string; availableToObjectIds: string[] | null };
export type CouponScopeInput = { eligibilityMode: Commerce7RewardEligibility; appliesTo: Commerce7CouponAppliesTo; productIds: readonly string[]; customerTagId: string | null };
export type CouponScopeResult = { ok: true; scope: CouponScope } | { ok: false; unsupported: "SELECTED_PRODUCTS" | "CUSTOMER_TAG_RESTRICTION" | "INVALID_INPUT" };

export function commerce7CouponSupport(contract: CouponContract = COMMERCE7_COUPON_CONTRACT) {
  return {
    eligibility: { ANYONE_WITH_CODE: contract.availableTo.ANYONE_WITH_CODE !== null, CLAIMANT_ONLY: contract.availableTo.CLAIMANT_ONLY !== null },
    scope: { ALL_PRODUCTS: contract.appliesTo.ALL_PRODUCTS !== null, SPECIFIC_PRODUCTS: contract.appliesTo.SPECIFIC_PRODUCTS !== null },
    discount: { FIXED_AMOUNT: true, PERCENTAGE: contract.percentage.verified },
  };
}
export type Commerce7DiscountKind = "FIXED_AMOUNT" | "PERCENTAGE";
/** Whether a coupon of this discount kind may be issued under the contract. Fixed amounts are proven; see `percentage`. */
export function isDiscountTypeSupported(type: Commerce7DiscountKind, contract: CouponContract = COMMERCE7_COUPON_CONTRACT) {
  return type === "FIXED_AMOUNT" || contract.percentage.verified;
}
/** SQRATCH basis points (1500 = 15%) to the native Percentage Off `discount`. Null for anything outside 0.01%–100%. */
export function commerce7NativePercentage(basisPoints: number, contract: CouponContract = COMMERCE7_COUPON_CONTRACT): number | null {
  if (!Number.isSafeInteger(basisPoints) || basisPoints < 1 || basisPoints > 10000) return null;
  const native = (basisPoints * contract.percentage.nativeUnitsPerPercent) / 100;
  return Number.isSafeInteger(native) && native >= 1 ? native : null;
}
/** The native Percentage Off `discount` back to basis points, for readback and diagnostics (native 15 = 15 bp = 0.15%). */
export function commerce7PercentageBasisPoints(native: number, contract: CouponContract = COMMERCE7_COUPON_CONTRACT): number | null {
  if (!Number.isFinite(native) || native < 0) return null;
  const basisPoints = (native * 100) / contract.percentage.nativeUnitsPerPercent;
  return Number.isSafeInteger(basisPoints) ? basisPoints : null;
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
