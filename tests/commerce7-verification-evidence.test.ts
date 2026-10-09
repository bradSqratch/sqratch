import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { COMMERCE7_COUPON_CONTRACT, commerce7CouponSupport } from "../src/lib/commerce7-coupon-contract";
import { COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT } from "../src/lib/commerce7-reward-domain";

/**
 * The draft gates are provable: each verification flag may be switched on ONLY together with a sanitized live-evidence
 * fixture showing the observed behavior, never to make tests pass. Flipping a flag without its evidence fails here; adding
 * evidence without flipping the flag is allowed (the gate simply stays closed until a reviewed change opens it).
 *
 * Expected evidence files (tests/fixtures/commerce7-rewards):
 *  - live-coupon-percentage-1500-observation.json: a manually created native coupon (discountType "Percentage Off",
 *    discount 1500) with Admin showing 15% and checkout taking 15% of the item price (CA$29.00 → CA$4.35).
 *  - live-coupon-customer-tag-restriction.json: an Admin-created coupon restricted to one Manual Customer Tag, read through the
 *    public API (code removed), plus the tagged customer redeeming it and an untagged customer refused with the same code.
 *  - live-multi-tag-storefront-observation.json: a customer holding ONLY the granted tag of a multi-tag product can buy it,
 *    and a customer holding none of its tags cannot.
 */
const fixture = (name: string) => new URL(`./fixtures/commerce7-rewards/${name}`, import.meta.url);
const read = (name: string) => JSON.parse(readFileSync(fixture(name), "utf8"));

test("percentage issuance is enabled only with live evidence that 1500 is 15% in Admin and at checkout", () => {
  const file = "live-coupon-percentage-1500-observation.json";
  if (!COMMERCE7_COUPON_CONTRACT.percentage.verified) { assert.equal(commerce7CouponSupport().discount.PERCENTAGE, false); return; }
  assert.ok(existsSync(fixture(file)), `percentage.verified requires ${file}`);
  const evidence = read(file);
  assert.equal(evidence.request.discountType, "Percentage Off"); assert.equal(evidence.request.discount, 1500); assert.ok([200, 201].includes(evidence.status));
  assert.equal(String(evidence.observed.commerce7AdminCouponEditorDiscount).replace(/\s/g, ""), "15%");
  const { productPriceMinor, discountMinor } = evidence.observed.checkout;
  assert.ok(Number.isSafeInteger(productPriceMinor) && Number.isSafeInteger(discountMinor));
  assert.ok(Math.abs(discountMinor - Math.round((productPriceMinor * 15) / 100)) <= 1, "checkout took 15% of the item price");
  assert.equal(COMMERCE7_COUPON_CONTRACT.percentage.nativeUnitsPerPercent * 15, evidence.request.discount, "the unit the evidence proves is the unit the writer uses");
});

test("claimant-only coupons are enabled only with live evidence of a customer-tag restricted native coupon", () => {
  const file = "live-coupon-customer-tag-restriction.json";
  const value = COMMERCE7_COUPON_CONTRACT.availableTo.CLAIMANT_ONLY;
  if (value === null) { assert.equal(commerce7CouponSupport().eligibility.CLAIMANT_ONLY, false); return; }
  assert.ok(existsSync(fixture(file)), `availableTo.CLAIMANT_ONLY requires ${file}`);
  const evidence = read(file);
  assert.equal(evidence.coupon.availableTo, value, "the contract value is the observed native value");
  assert.ok(Array.isArray(evidence.coupon.availableToObjectIds) && evidence.coupon.availableToObjectIds.length === 1, "restricted to exactly one tag");
  assert.equal(evidence.observed.taggedCustomerRedeemed, true); assert.equal(evidence.observed.untaggedCustomerRejected, true); assert.equal(evidence.observed.sharedCodeRejectedForUntagged, true);
  assert.notEqual(evidence.source?.kind, "EXCLUSIVE_ACCESS_GRANT", "a Customer Tag grant is not evidence of a customer-bound coupon");
});

test("multi-tag exclusive access is enabled only with storefront evidence that one matching tag is sufficient", () => {
  const file = "live-multi-tag-storefront-observation.json";
  if (!COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT.multiTagAccessVerified) return;
  assert.ok(existsSync(fixture(file)), `multiTagAccessVerified requires ${file}`);
  const evidence = read(file);
  assert.ok(evidence.product.securityTagCount >= 2); assert.equal(evidence.observed.oneTagCustomerCanPurchase, true); assert.equal(evidence.observed.noTagCustomerBlocked, true);
});

test("today: multi-tag OR access is verified with evidence; percentage units and claimant-bound coupons are still gated", () => {
  assert.equal(COMMERCE7_COUPON_CONTRACT.percentage.verified, false);
  assert.equal(COMMERCE7_COUPON_CONTRACT.availableTo.CLAIMANT_ONLY, null);
  assert.equal(COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT.multiTagAccessVerified, true);
  assert.equal(read("live-coupon-percentage-observation.json").request.discount, 15);
});
