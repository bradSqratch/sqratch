import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { COMMERCE7_COUPON_CONTRACT, commerce7CouponSupport, commerce7NativePercentage, commerce7PercentageBasisPoints, type CouponContract } from "../src/lib/commerce7-coupon-contract";
import { buildCommerce7RewardCoupon, couponMatches, parseNativeCoupon } from "../src/lib/commerce/providers/commerce7-rewards-client";
import { harness, offerBody, type Row } from "./commerce7-reward-harness";

/**
 * Live QA proved that a native Percentage Off `discount` of 15 is 0.15% (Admin showed 0.15%; CAD 18.97 got 0.03 off), so the
 * native unit is 1/100 of a percent and 15% must be written as 1500. Issuance stays gated until a live 1500 = 15% is observed.
 */
const observation = JSON.parse(readFileSync(new URL("./fixtures/commerce7-rewards/live-coupon-percentage-observation.json", import.meta.url), "utf8"));
const verifiedPercent: CouponContract = { ...COMMERCE7_COUPON_CONTRACT, percentage: { ...COMMERCE7_COUPON_CONTRACT.percentage, verified: true } };
// The gate mechanism stays testable with an explicitly unverified contract; production is verified (see the evidence test).
const unverifiedPercent: CouponContract = { ...COMMERCE7_COUPON_CONTRACT, percentage: { ...COMMERCE7_COUPON_CONTRACT.percentage, verified: false } };
const percentOffer = { discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1500 };
const code = `SQRA${"A".repeat(32)}`;
const start = new Date("2026-10-08T08:16:00.000Z"); const end = new Date("2026-10-15T08:16:00.000Z");
const scope = { appliesTo: "Store", appliesToObjectIds: null, availableTo: "Everyone", availableToObjectIds: null };
const terms = (basis: number) => ({ title: "Fifteen Percent", discountType: "PERCENTAGE" as const, discountAmountCents: null, discountPercentageBasisPoints: basis, minimumSubtotalCents: null });

test("the live observation is recorded as supplied: native 15 was 0.15% in Admin and at checkout", () => {
  assert.equal(observation.status, 201); assert.deepEqual(observation.request, { discountType: "Percentage Off", discount: 15 });
  assert.equal(observation.observed.commerce7AdminCouponEditorDiscount, "0.15%");
  const { approximateProductPriceMinor, discountMinor } = observation.observed.checkout;
  assert.equal(Math.round((approximateProductPriceMinor * 15) / 10000), discountMinor, "0.15% of CAD 18.97 rounds to CAD 0.03");
  assert.notEqual(Math.round((approximateProductPriceMinor * 15) / 100), discountMinor, "15% would have been about CAD 2.85");
});

test("native percentage units are hundredths of a percent: 0.15%, 15% and 100% are distinct", () => {
  assert.equal(COMMERCE7_COUPON_CONTRACT.percentage.nativeUnitsPerPercent, 100);
  assert.equal(commerce7NativePercentage(1500), 1500, "15% (1,500 basis points) is written as 1500");
  assert.equal(commerce7NativePercentage(10000), 10000, "100% is 10000");
  assert.equal(commerce7PercentageBasisPoints(observation.request.discount), 15, "the live native 15 is 15 basis points = 0.15%");
  assert.equal(commerce7PercentageBasisPoints(1500), 1500); assert.equal(commerce7PercentageBasisPoints(10000), 10000);
  for (const invalid of [0, -1, 1.5, 10001, NaN]) assert.equal(commerce7NativePercentage(invalid), null, String(invalid));
});

test("the writer sends 15% as discount 1500 (never 15), keeps fixed amounts in minor units, and refuses out-of-range values", () => {
  const build = (basis: number) => buildCommerce7RewardCoupon({ terms: terms(basis), scope, code, claimId: "claim", startsAt: start, endsAt: end });
  assert.equal(build(1500).discount, 1500); assert.equal(build(10000).discount, 10000); assert.equal(build(100).discount, 100);
  assert.notEqual(build(1500).discount, 15, "the value that produced 0.15% is never sent for 15%");
  const fixed = buildCommerce7RewardCoupon({ terms: { ...terms(1500), discountType: "FIXED_AMOUNT", discountAmountCents: 1999, discountPercentageBasisPoints: null }, scope, code, claimId: "claim", startsAt: start, endsAt: end });
  assert.equal(fixed.discount, 1999);
  for (const basis of [0, 99, 1550, 10001]) assert.throws(() => build(basis), { code: "SETUP_INCOMPLETE" });
});

test("readback recovery never adopts a coupon created with the old 0.15% value for a 15% claim", () => {
  const expected = buildCommerce7RewardCoupon({ terms: terms(1500), scope, code, claimId: "claim", startsAt: start, endsAt: end });
  const echo = (discount: number) => parseNativeCoupon({ id: "coupon-1", appliesToObjectIds: "", availableToObjectIds: "", ...expected, discount, dollarOffDiscountApplies: "Once Per Order" });
  assert.equal(couponMatches(echo(1500), expected), true);
  assert.equal(couponMatches(echo(15), expected), false, "0.15% is not 15%");
  assert.equal(couponMatches(echo(10000), expected), false, "100% is not 15%");
});

test("production: percentage units are verified live (1500 = 15%), so percentage rewards can go live; the unit stays 100 per percent", () => {
  assert.equal(COMMERCE7_COUPON_CONTRACT.percentage.verified, true); assert.equal(COMMERCE7_COUPON_CONTRACT.percentage.nativeUnitsPerPercent, 100);
  assert.deepEqual(commerce7CouponSupport().discount, { FIXED_AMOUNT: true, PERCENTAGE: true });
  assert.deepEqual(commerce7CouponSupport(unverifiedPercent).discount, { FIXED_AMOUNT: true, PERCENTAGE: false });
});

test("gated (unverified contract): an active percentage offer cannot be saved or enabled, and a draft saves with no provider call", async () => {
  const app = harness({ contract: unverifiedPercent });
  await assert.rejects(app.save({ ...offerBody, ...percentOffer, isActive: true }), (error: { code: string; message: string }) => error.code === "COUPON_CONTRACT_UNVERIFIED" && /percentage/i.test(error.message));
  const draft = await app.save({ ...offerBody, ...percentOffer, isActive: false });
  assert.equal(draft.isActive, false); assert.equal(draft.discountPercentageBasisPoints, 1500, "SQRATCH still stores 1,500 basis points");
  const paused = harness({ offer: { ...percentOffer, isActive: false }, contract: unverifiedPercent });
  await assert.rejects(paused.setActive("ENABLE"), (error: { code: string; message: string }) => error.code === "COUPON_CONTRACT_UNVERIFIED" && /percentage/i.test(error.message));
  assert.equal(paused.offer().isActive, false); assert.deepEqual([...app.calls, ...paused.calls], []);
});

test("gated (unverified contract): an already-active percentage offer refuses new claims before any debit or provider call", async () => {
  const app = harness({ offer: percentOffer, contract: unverifiedPercent });
  await assert.rejects(app.reserve(), { code: "COUPON_CONTRACT_UNVERIFIED" });
  assert.equal(app.claims().length, 0); assert.equal(app.ledger.size, 0); assert.equal(app.offer().reservedClaimCount, 0); assert.deepEqual(app.calls, []);
});

test("gated (unverified contract): a pending percentage claim (current or legacy snapshot) is refunded before any coupon request", async () => {
  for (const snapshotDiscount of [{ type: "PERCENTAGE", amountCents: null, percentageBasisPoints: 1500 }, "LEGACY"] as const) {
    const verified = harness({ offer: percentOffer, contract: verifiedPercent }); const claim = await verified.reserve();
    const app = harness({ offer: percentOffer, contract: unverifiedPercent }); app.tables.commerceRewardRedemption.push(structuredClone(verified.claims()[0])); (app.offer() as Row).reservedClaimCount = 1;
    if (snapshotDiscount === "LEGACY") (app.claims()[0] as Row).rewardConfigSnapshot = { eligibilityMode: "ANYONE_WITH_CODE", templateCouponId: "legacy-template", template: { id: "legacy-template", code: "legacy-template", title: "Merchant template", usageLimitType: "Per Store", usageLimit: 1, appliesTo: "Store", appliesToObjectIds: null, productDiscountType: "Percentage Off", productDiscount: 15, shippingDiscountType: "No Discount", shippingDiscount: null, startDate: "2026-01-01T00:00:00.000Z", endDate: null, status: "Enabled", minimumCartAmount: null, availableTo: "Everyone", availableToObjectIds: null }, title: "Old", minimumSubtotalCents: null };
    else assert.deepEqual(JSON.parse(JSON.stringify((app.claims()[0] as Row).rewardConfigSnapshot)).discount, snapshotDiscount);
    await app.provision(String(claim.id));
    const after = app.claims()[0];
    assert.equal(after.status, "REFUNDED", String(snapshotDiscount)); assert.equal(after.couponCreateAttempted, false); assert.deepEqual(app.postBodies(), [], "no coupon request");
    assert.match(String(after.errorMessage), /cannot be issued yet; points returned/);
  }
});

test("existing issued percentage coupons, their snapshots and spent points are never mutated", async () => {
  const app = harness({ offer: percentOffer, contract: verifiedPercent }); const claim = await app.reserve(); await app.provision(String(claim.id));
  const issued = structuredClone(app.claims()[0]);
  const gated = harness({ offer: percentOffer }); gated.tables.commerceRewardRedemption.push(structuredClone(issued));
  await gated.provision(String(claim.id)); await gated.reconcile();
  assert.deepEqual(JSON.parse(JSON.stringify(gated.claims()[0])), JSON.parse(JSON.stringify(issued))); assert.deepEqual(gated.calls, []);
});

test("verified path: 15% is posted as 1500 and issued; a definitive 4xx for that value refunds safely", async () => {
  const app = harness({ offer: percentOffer, contract: verifiedPercent }); const claim = await app.reserve(); const issued = await app.provision(String(claim.id));
  assert.equal(issued?.status, "ISSUED"); const [body] = app.postBodies(); assert.equal(body.discountType, "Percentage Off"); assert.equal(body.discount, 1500);
  const refused = harness({ offer: percentOffer, contract: verifiedPercent });
  refused.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/coupon", respond: () => Response.json({ message: "synthetic validation error" }, { status: 422 }) });
  const pending = await refused.reserve(); const result = await refused.provision(String(pending.id));
  assert.equal(result?.status, "REFUNDED"); assert.equal(refused.balance(), 500); assert.equal(refused.postBodies().length, 1);
});
