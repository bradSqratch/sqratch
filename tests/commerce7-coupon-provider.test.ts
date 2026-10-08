import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Commerce7RewardError, Commerce7RewardsClient, buildCommerce7RewardCoupon, couponMatches, parseNativeCoupon, rewardCouponTitle, type NativeCoupon } from "../src/lib/commerce/providers/commerce7-rewards-client";
import { COMMERCE7_COUPON_CONTRACT, resolveCouponScope, type CouponScope } from "../src/lib/commerce7-coupon-contract";

const evidence = JSON.parse(readFileSync(new URL("./fixtures/commerce7-rewards/operator-sandbox-evidence.json", import.meta.url), "utf8"));
const code = `SQRA${"A".repeat(32)}`;
const store: CouponScope = { appliesTo: "Store", appliesToObjectIds: null, availableTo: "Everyone", availableToObjectIds: null };
const terms = { title: "Wine reward", discountType: "FIXED_AMOUNT" as const, discountAmountCents: 1000, discountPercentageBasisPoints: null, minimumSubtotalCents: 5000 };
const startsAt = new Date("2026-10-10T00:00:37.123Z"); const endsAt = new Date("2026-11-09T00:00:37.123Z");
const build = (overrides: Partial<Parameters<typeof buildCommerce7RewardCoupon>[0]> = {}) => buildCommerce7RewardCoupon({ terms, scope: store, code, claimId: "claim", startsAt, endsAt, ...overrides });
function client(responses: unknown[], seen: { url: string; init?: RequestInit }[] = []) {
  process.env.COMMERCE7_APP_ID = "synthetic-test-app"; process.env.COMMERCE7_APP_SECRET = "synthetic-test-secret";
  return new Commerce7RewardsClient("test-tenant", async (url, init) => { seen.push({ url: String(url), init }); const response = responses.shift(); if (response instanceof Error) throw response; return response instanceof Response ? response : Response.json(response); });
}
/** What a provider that echoes our request the way a real tenant reads back would return. */
function nativeEcho(request: Record<string, unknown>): NativeCoupon {
  return { id: "native-coupon", appliesToObjectIds: "", availableToObjectIds: "", usageLimit: null, ...request } as unknown as NativeCoupon; // synthetic: the 201 response body was not supplied
}

test("the real sandbox Coupon GET parses: empty object-ID strings and null discounts normalize to null", () => {
  const coupon = parseNativeCoupon(evidence.coupon);
  assert.equal(coupon.appliesToObjectIds, null); assert.equal(coupon.availableToObjectIds, null);
  assert.equal(coupon.productDiscountType, null); assert.equal(coupon.productDiscount, null); assert.equal(coupon.shippingDiscountType, null);
  assert.equal(coupon.appliesTo, "Store"); assert.equal(coupon.availableTo, "Everyone"); assert.equal(coupon.endDate, "2026-11-01T06:59:00.000Z");
  // A populated list is still a closed array of IDs; a non-empty string is an unknown representation.
  assert.deepEqual(parseNativeCoupon({ ...evidence.coupon, appliesToObjectIds: ["a"] }).appliesToObjectIds, ["a"]);
  assert.equal(parseNativeCoupon({ ...evidence.coupon, appliesToObjectIds: [] }).appliesToObjectIds, null);
  assert.throws(() => parseNativeCoupon({ ...evidence.coupon, appliesToObjectIds: "a,b" }), { code: "INVALID_PROVIDER_RESPONSE" });
  assert.throws(() => parseNativeCoupon({ ...evidence.coupon, productDiscount: "10" }), { code: "INVALID_PROVIDER_RESPONSE" });
});

test("direct payload: the live-proven write shape, Per Store single use, whole-store, Everyone, exact minor units", () => {
  const body = build();
  assert.deepEqual(body, {
    code, title: body.title, type: "Product", status: "Enabled", usageLimitType: "Per Store", usageLimit: 1, appliesTo: "Store", availableTo: "Everyone",
    discountType: "Dollar Off", discount: 1000, dollarOffDiscountApplies: "Once Per Order",
    cartRequirementType: "Minimum Purchase Amount", cartRequirement: 5000, cartRequirementCountType: "All Items",
    startDate: "2026-10-10T00:00:00.000Z", endDate: "2026-11-09T00:00:00.000Z",
  });
  for (const key of ["appliesToObjectIds", "availableToObjectIds", "productDiscountType", "productDiscount", "shippingDiscountType", "shippingDiscount", "minimumCartAmount", "cartRequirementMaximum"]) assert.equal(key in body, false, key);
  const none = build({ terms: { ...terms, minimumSubtotalCents: null } });
  assert.equal(none.cartRequirementType, "None"); assert.equal("cartRequirement" in none, false); assert.equal("cartRequirementCountType" in none, false);
});

test("fixed amounts stay integers with no float math; percentages convert whole basis points exactly", () => {
  for (const cents of [1, 99, 1999, 2147483647]) assert.equal(build({ terms: { ...terms, discountAmountCents: cents } }).discount, cents);
  for (const bad of [0, -1, 1.5, NaN, Infinity, null]) assert.throws(() => build({ terms: { ...terms, discountAmountCents: bad as number } }), { code: "SETUP_INCOMPLETE" });
  const percent = { ...terms, discountType: "PERCENTAGE" as const, discountAmountCents: null };
  const body = build({ terms: { ...percent, discountPercentageBasisPoints: 1500 } });
  assert.equal(body.discount, 15); assert.equal(body.discountType, "Percentage Off"); assert.equal("dollarOffDiscountApplies" in body, false);
  for (const basis of [0, 1, 99, 1550, 10001, NaN, Infinity, null]) assert.throws(() => build({ terms: { ...percent, discountPercentageBasisPoints: basis as number } }), { code: "SETUP_INCOMPLETE" });
});

test("effective dates are minute-aligned UTC, deterministic for retries, and must leave a positive window", () => {
  assert.deepEqual(build(), build());
  assert.equal(build({ startsAt: new Date("2026-10-10T00:00:00.000Z") }).startDate, "2026-10-10T00:00:00.000Z");
  assert.throws(() => build({ endsAt: new Date("2026-10-10T00:00:59.000Z") }), { code: "SETUP_INCOMPLETE" });
  assert.throws(() => build({ startsAt: new Date(NaN) }), { code: "SETUP_INCOMPLETE" });
});

test("claim code, title and scope are validated; the title never carries the code, an email or the claim ID", () => {
  for (const bad of ["", "short", `SQRA${"a".repeat(32)}`, `SQRA${"A".repeat(31)}`, `X${"A".repeat(36)}`]) assert.throws(() => build({ code: bad }), { code: "SETUP_INCOMPLETE" });
  const title = rewardCouponTitle("  A   very\nlong title ".repeat(10), "claim-secret-id");
  assert.match(title, /^SQRATCH \S/); assert.ok(title.length <= 90); assert.doesNotMatch(title, /claim-secret-id|\n|SQRA[A-F0-9]{32}/);
  assert.equal(rewardCouponTitle("Wine", "claim-1"), rewardCouponTitle("Wine", "claim-1")); assert.notEqual(rewardCouponTitle("Wine", "claim-1"), rewardCouponTitle("Wine", "claim-2"));
  const tagged = resolveCouponScope({ eligibilityMode: "CLAIMANT_ONLY", appliesTo: "SPECIFIC_PRODUCTS", productIds: ["b", "a"], customerTagId: "tag" }, { ...COMMERCE7_COUPON_CONTRACT, availableTo: { ...COMMERCE7_COUPON_CONTRACT.availableTo, CLAIMANT_ONLY: "opaque-tag" }, appliesTo: { ...COMMERCE7_COUPON_CONTRACT.appliesTo, SPECIFIC_PRODUCTS: "opaque-product" } });
  assert.ok(tagged.ok);
  const body = build({ scope: tagged.ok ? tagged.scope : store });
  assert.deepEqual([body.appliesTo, body.appliesToObjectIds, body.availableTo, body.availableToObjectIds], ["opaque-product", ["a", "b"], "opaque-tag", ["tag"]]);
});

test("exact readback tolerates only representation differences: empty-ID forms, null shipping type, ms/second date precision, title and code case", () => {
  const body = build();
  assert.ok(couponMatches(parseNativeCoupon(nativeEcho({ ...body })), body));
  assert.ok(couponMatches(parseNativeCoupon(nativeEcho({ ...body, code: code.toLowerCase(), title: "Renamed by an admin", shippingDiscountType: null, startDate: "2026-10-10T00:00:12.900Z", endDate: "2026-11-09T00:00:59.000Z" })), body));
  for (const change of [{ usageLimit: 2 }, { usageLimit: null }, { usageLimitType: "Unlimited" }, { appliesTo: "Other" }, { appliesToObjectIds: ["x"] }, { discount: 1001 }, { discountType: "Percentage Off" }, { type: "Shipping" }, { dollarOffDiscountApplies: "Once Per Item" }, { dollarOffDiscountApplies: null }, { shippingDiscountType: "Free" }, { shippingDiscount: 5 }, { status: "Disabled" }, { cartRequirement: 4999 }, { cartRequirementType: "None", cartRequirement: null }, { cartRequirementCountType: "Applicable Items" }, { cartRequirementType: "Minimum Quantity" }, { cartRequirementMaximum: 9000 }, { availableTo: "Other" }, { availableToObjectIds: ["tag"] }, { startDate: "2026-10-10T00:01:00.000Z" }, { endDate: "2026-11-09T00:01:00.000Z" }, { code: "OTHER" }]) {
    assert.equal(couponMatches(parseNativeCoupon(nativeEcho({ ...body, ...change })), body), false, JSON.stringify(change));
  }
  const withIds = build({ scope: { ...store, appliesToObjectIds: ["a", "b"] } });
  assert.ok(couponMatches(parseNativeCoupon(nativeEcho({ ...withIds, appliesToObjectIds: ["b", "a"] })), withIds));
  assert.equal(couponMatches(parseNativeCoupon(nativeEcho({ ...withIds, appliesToObjectIds: ["a"] })), withIds), false);
});

test("POST /coupon accepts a realistic echo (empty-ID strings, null shipping type) and rejects a mismatched one as uncertain", async () => {
  const body = build(); const seen: { url: string; init?: RequestInit }[] = [];
  const created = await client([nativeEcho({ ...body, shippingDiscountType: null })], seen).createCoupon(body);
  assert.equal(created.id, "native-coupon"); assert.equal(new URL(seen[0].url).pathname, "/v1/coupon"); assert.equal(seen[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(seen[0].init?.body)), body);
  await assert.rejects(client([nativeEcho({ ...body, productDiscount: 1 })]).createCoupon(body), { code: "INVALID_PROVIDER_RESPONSE", uncertain: true });
});

test("POST classification: definitive rejections are certain, anything that may have been accepted is uncertain", async () => {
  const body = build();
  const outcomes: [Response | Error, string, boolean][] = [
    [new Response("PII body", { status: 400 }), "WRITE_REJECTED", false], [new Response("PII body", { status: 422 }), "WRITE_REJECTED", false],
    [new Response("", { status: 401 }), "SETUP_INCOMPLETE", false], [new Response("", { status: 403 }), "SETUP_INCOMPLETE", false],
    [new Response("", { status: 429 }), "PROVIDER_UNAVAILABLE", false],
    [new Response("", { status: 408 }), "PROVIDER_UNAVAILABLE", true], [new Response("", { status: 409 }), "WRITE_REJECTED", true],
    [new Response("", { status: 500 }), "PROVIDER_UNAVAILABLE", true], [new Response("", { status: 503 }), "PROVIDER_UNAVAILABLE", true],
    [new Error("socket hang up secret@example.test"), "PROVIDER_UNAVAILABLE", true], [new Response("not json", { status: 200 }), "INVALID_PROVIDER_RESPONSE", true],
  ];
  for (const [response, errorCode, uncertain] of outcomes) {
    await assert.rejects(client([response]).createCoupon(body), (error: unknown) => error instanceof Commerce7RewardError && error.code === errorCode && error.uncertain === uncertain && !/PII|secret@example/.test(error.message));
  }
  // The same status on a read is never "uncertain": nothing was written.
  await assert.rejects(client([new Response("", { status: 503 })]).findCoupon(code), { code: "PROVIDER_UNAVAILABLE", uncertain: false });
});

test("exact-code recovery finds the single matching coupon among partial matches and rejects ambiguity", async () => {
  const body = build();
  const found = await client([{ coupons: [{ ...evidence.coupon, code: "unrelated" }, nativeEcho({ ...body })], total: 2 }]).findCoupon(code);
  assert.equal(found?.id, "native-coupon");
  assert.equal(await client([{ coupons: [{ ...evidence.coupon, code: "unrelated" }], total: 1 }]).findCoupon(code), null);
  await assert.rejects(client([{ coupons: [nativeEcho({ ...body }), nativeEcho({ ...body, id: "other" })], total: 2 }]).findCoupon(code), { code: "CUSTOMER_AMBIGUOUS" });
});

test("readback normalizes the create echo and the historical GET representation into the same terms, and never trusts a conflict", () => {
  const fixed = build(); const percent = build({ terms: { ...terms, discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1500, minimumSubtotalCents: null } });
  const { discountType, discount, dollarOffDiscountApplies, cartRequirementType, cartRequirement, cartRequirementCountType, type, ...common } = fixed;
  void type; void cartRequirementCountType; void cartRequirementType;
  // Historical GET fields only (productDiscount*, minimumCartAmount), with no per-order report: a dollar-off amount cannot be proven once-per-order, so it fails closed.
  const historical = { ...common, productDiscountType: discountType, productDiscount: discount, shippingDiscountType: "No Discount", minimumCartAmount: cartRequirement };
  assert.equal(couponMatches(parseNativeCoupon(nativeEcho(historical)), fixed), false, "a dollar-off coupon without a per-order report is not proven");
  assert.equal(couponMatches(parseNativeCoupon(nativeEcho({ ...historical, dollarOffDiscountApplies })), fixed), true, "historical names plus the per-order report are sufficient");
  // Both representations reported: they must agree.
  assert.equal(couponMatches(parseNativeCoupon(nativeEcho({ ...fixed, productDiscountType: "Dollar Off", productDiscount: 1000, minimumCartAmount: 5000 })), fixed), true);
  for (const conflict of [{ productDiscount: 999 }, { productDiscountType: "Percentage Off" }, { minimumCartAmount: 1 }]) assert.equal(couponMatches(parseNativeCoupon(nativeEcho({ ...fixed, ...conflict })), fixed), false, JSON.stringify(conflict));
  // Nothing reported for the discount is never a match; a percentage tolerates only the provider's default per-order echo.
  const { discountType: _t, discount: _d, ...noDiscount } = fixed; void _t; void _d;
  assert.equal(couponMatches(parseNativeCoupon(nativeEcho(noDiscount)), fixed), false);
  assert.equal(couponMatches(parseNativeCoupon(nativeEcho({ ...percent, dollarOffDiscountApplies: "Once Per Order" })), percent), true);
  assert.equal(couponMatches(parseNativeCoupon(nativeEcho({ ...percent })), percent), true);
  assert.equal(couponMatches(parseNativeCoupon(nativeEcho({ ...percent, dollarOffDiscountApplies: "Once Per Item" })), percent), false);
  // An unexpected minimum on a no-minimum coupon is a mismatch, in either representation.
  assert.equal(couponMatches(parseNativeCoupon(nativeEcho({ ...percent, cartRequirementType: "Minimum Purchase Amount", cartRequirement: 100 })), percent), false);
  assert.equal(couponMatches(parseNativeCoupon(nativeEcho({ ...percent, minimumCartAmount: 100 })), percent), false);
});
