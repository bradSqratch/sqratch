import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMERCE7_COUPON_CONTRACT,
  commerce7CouponSupport,
  isCouponBranchSupported,
  resolveCouponScope,
  type CouponContract,
} from "../src/lib/commerce7-coupon-contract";

// Hypothetical enums used only to prove the mapping plumbing. They are NOT
// Commerce7 values and the production contract must never contain them.
const verified: CouponContract = {
  ...COMMERCE7_COUPON_CONTRACT,
  appliesTo: { ...COMMERCE7_COUPON_CONTRACT.appliesTo, SPECIFIC_PRODUCTS: "opaque-product-scope" },
  availableTo: { ...COMMERCE7_COUPON_CONTRACT.availableTo, CLAIMANT_ONLY: "opaque-customer-tag" },
};

test("production contract holds only operator-observed values and never guesses Product/Tag/Group enums", () => {
  assert.deepEqual(COMMERCE7_COUPON_CONTRACT.appliesTo, { ALL_PRODUCTS: "Store", SPECIFIC_PRODUCTS: null });
  assert.deepEqual(COMMERCE7_COUPON_CONTRACT.availableTo, { ANYONE_WITH_CODE: "Everyone", CLAIMANT_ONLY: null });
  assert.equal(COMMERCE7_COUPON_CONTRACT.usageLimitType, "Per Store");
  assert.equal(COMMERCE7_COUPON_CONTRACT.usageLimit, 1);
  assert.equal(COMMERCE7_COUPON_CONTRACT.shippingDiscountType, "No Discount");
  assert.deepEqual(COMMERCE7_COUPON_CONTRACT.productDiscountType, { FIXED_AMOUNT: "Dollar Off", PERCENTAGE: "Percentage Off" });
  assert.doesNotMatch(JSON.stringify(COMMERCE7_COUPON_CONTRACT), /"(Product|Tag|Group|Collection|Club)"/);
});

test("support matrix reports exactly the verified eligibility and scope branches", () => {
  assert.deepEqual(commerce7CouponSupport(), { eligibility: { ANYONE_WITH_CODE: true, CLAIMANT_ONLY: false }, scope: { ALL_PRODUCTS: true, SPECIFIC_PRODUCTS: false } });
  assert.deepEqual(commerce7CouponSupport(verified), { eligibility: { ANYONE_WITH_CODE: true, CLAIMANT_ONLY: true }, scope: { ALL_PRODUCTS: true, SPECIFIC_PRODUCTS: true } });
  assert.equal(isCouponBranchSupported("ANYONE_WITH_CODE", "ALL_PRODUCTS"), true);
  for (const [eligibility, scope] of [["ANYONE_WITH_CODE", "SPECIFIC_PRODUCTS"], ["CLAIMANT_ONLY", "ALL_PRODUCTS"], ["CLAIMANT_ONLY", "SPECIFIC_PRODUCTS"]] as const) assert.equal(isCouponBranchSupported(eligibility, scope), false);
});

test("whole-store bearer scope is Store/Everyone with no object IDs, regardless of stray inputs", () => {
  const result = resolveCouponScope({ eligibilityMode: "ANYONE_WITH_CODE", appliesTo: "ALL_PRODUCTS", productIds: [], customerTagId: null });
  assert.deepEqual(result, { ok: true, scope: { appliesTo: "Store", appliesToObjectIds: null, availableTo: "Everyone", availableToObjectIds: null } });
  // A bearer coupon must never be tag-restricted and a store coupon never product-listed.
  const stray = resolveCouponScope({ eligibilityMode: "ANYONE_WITH_CODE", appliesTo: "ALL_PRODUCTS", productIds: ["stale"], customerTagId: "stale-tag" });
  assert.deepEqual(stray, result);
});

test("unverified branches fail closed with a named reason and never fall back to a guessed enum", () => {
  assert.deepEqual(resolveCouponScope({ eligibilityMode: "ANYONE_WITH_CODE", appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine"], customerTagId: null }), { ok: false, unsupported: "SELECTED_PRODUCTS" });
  assert.deepEqual(resolveCouponScope({ eligibilityMode: "CLAIMANT_ONLY", appliesTo: "ALL_PRODUCTS", productIds: [], customerTagId: "tag" }), { ok: false, unsupported: "CUSTOMER_TAG_RESTRICTION" });
  assert.deepEqual(resolveCouponScope({ eligibilityMode: "CLAIMANT_ONLY", appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine"], customerTagId: "tag" }), { ok: false, unsupported: "CUSTOMER_TAG_RESTRICTION" });
});

test("once the provider enums are proven, the same function maps them exactly with sorted IDs", () => {
  assert.deepEqual(resolveCouponScope({ eligibilityMode: "ANYONE_WITH_CODE", appliesTo: "SPECIFIC_PRODUCTS", productIds: ["b-wine", "a-wine"], customerTagId: null }, verified), { ok: true, scope: { appliesTo: "opaque-product-scope", appliesToObjectIds: ["a-wine", "b-wine"], availableTo: "Everyone", availableToObjectIds: null } });
  assert.deepEqual(resolveCouponScope({ eligibilityMode: "CLAIMANT_ONLY", appliesTo: "ALL_PRODUCTS", productIds: [], customerTagId: "claim-tag" }, verified), { ok: true, scope: { appliesTo: "Store", appliesToObjectIds: null, availableTo: "opaque-customer-tag", availableToObjectIds: ["claim-tag"] } });
});

test("scope inputs are validated: bound coupons need exactly one claim tag; selected scope needs distinct products", () => {
  for (const customerTagId of [null, ""]) assert.deepEqual(resolveCouponScope({ eligibilityMode: "CLAIMANT_ONLY", appliesTo: "ALL_PRODUCTS", productIds: [], customerTagId }, verified), { ok: false, unsupported: "INVALID_INPUT" });
  for (const productIds of [[], ["dup", "dup"], [""], Array.from({ length: 51 }, (_, i) => `p${i}`)]) assert.deepEqual(resolveCouponScope({ eligibilityMode: "ANYONE_WITH_CODE", appliesTo: "SPECIFIC_PRODUCTS", productIds, customerTagId: null }, verified), { ok: false, unsupported: "INVALID_INPUT" });
});
