import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { BrandRewardOffer, CommerceOrder, CommerceRewardRedemption } from "@prisma/client";
import { Commerce7RewardsClient, Commerce7RewardError, buildCommerce7RewardCoupon, claimTagTitle, couponMatches, parseNativeCoupon, type CouponWriteRequest, type NativeCoupon } from "../src/lib/commerce/providers/commerce7-rewards-client";
import { parseCommerce7Offer, parseRewardSnapshot, rewardIdempotencyKey, serializeCommerce7Claim, validateLegacyNativeTemplate, commerce7OfferAvailable, COMMERCE7_REWARD_CAPABILITIES } from "../src/lib/commerce7-reward-domain";
import { exactCommerce7RewardOrderMatch } from "../src/lib/commerce/providers/commerce7-reward-orders";
import { nativeReadDefaults } from "./commerce7-reward-harness";

// Pre-refinement offers embedded the merchant's native template. Its eligibility/scope literals are deliberately
// opaque native-read fixtures, not claimed to be Commerce7 REST enums. New offers never read or require a template.
export const template: NativeCoupon = { ...nativeReadDefaults, id: "template", title: "Template", code: "native-template", usageLimitType: "Per Store", usageLimit: 1, appliesTo: "Store", appliesToObjectIds: null, productDiscountType: "Dollar Off", productDiscount: 1000, shippingDiscountType: "No Discount", shippingDiscount: null, startDate: "2026-01-01T00:00:00.000Z", endDate: null, status: "Enabled", minimumCartAmount: null, availableTo: "native-tag-eligibility", availableToObjectIds: ["template-tag"] };
export const offerBody = { title: "Wine reward", description: "A discount", isActive: true, rewardMode: "DISCOUNT", pointsCost: 100, discountType: "FIXED_AMOUNT", discountAmountCents: 1000, discountPercentageBasisPoints: null, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, codeValidDays: 30, minimumSubtotalCents: 5000, productIds: [] };
const start = new Date("2026-10-01T00:00:00.000Z"); const end = new Date("2026-10-31T00:00:00.000Z"); const code = `SQRA${"A".repeat(32)}`;
const bearerScope = { appliesTo: "Store", appliesToObjectIds: null, availableTo: "Everyone", availableToObjectIds: null };
const boundScope = { ...bearerScope, availableTo: "native-tag-eligibility", availableToObjectIds: ["claim-tag"] };
const fixedTerms = { title: "Wine reward", discountType: "FIXED_AMOUNT" as const, discountAmountCents: 1000, discountPercentageBasisPoints: null, minimumSubtotalCents: 5000 };
function payload(scope = boundScope) { return buildCommerce7RewardCoupon({ terms: fixedTerms, scope, code, claimId: "claim", startsAt: start, endsAt: end }); }
/** The provider's read-back of a request, as a native coupon. */
const native = (request: CouponWriteRequest): NativeCoupon => parseNativeCoupon({ id: "created", appliesToObjectIds: null, availableToObjectIds: null, ...request }); // synthetic echo

test("fixed Commerce7 contract: cents, UTC dates, one store use, native eligibility and scope retained", () => {
  const body = payload(); assert.equal(body.discount, 1000); assert.equal(body.discountType, "Dollar Off"); assert.equal(body.dollarOffDiscountApplies, "Once Per Order"); assert.equal(body.cartRequirement, 5000); assert.equal(body.cartRequirementType, "Minimum Purchase Amount"); assert.equal(body.startDate, start.toISOString()); assert.equal(body.endDate, end.toISOString()); assert.equal(body.availableTo, "native-tag-eligibility"); assert.deepEqual(body.availableToObjectIds, ["claim-tag"]); assert.equal(body.usageLimit, 1); assert.ok(!JSON.stringify(body).includes("@"));
});
test("percentage conversion writes the native unit (1/100 percent), rejects fractional unsupported values and overflow", () => {
  const percent = { ...fixedTerms, discountType: "PERCENTAGE" as const, discountAmountCents: null };
  const build = (basis: number) => buildCommerce7RewardCoupon({ terms: { ...percent, discountPercentageBasisPoints: basis }, scope: bearerScope, code, claimId: "claim", startsAt: start, endsAt: end });
  assert.equal(build(1500).discount, 1500);
  for (const basis of [0, 1, 1550, 10001, NaN, Infinity]) assert.throws(() => build(basis));
});
test("offer validation rejects malformed limits, dates, unknown modes/currencies, duplicates and irrelevant amounts", () => {
  assert.equal(parseCommerce7Offer(offerBody, "CAD").maxTotalRedemptions, 25);
  for (const change of [{ pointsCost: 0 }, { pointsCost: 1.5 }, { maxTotalRedemptions: null }, { maxTotalRedemptions: 1001 }, { maxRedemptionsPerUser: 26 }, { codeValidDays: 366 }, { claimStartsAt: "bad" }, { claimEndsAt: "bad" }, { claimStartsAt: "2026-11-01", claimEndsAt: "2026-10-01" }, { discountAmountCents: Infinity }, { discountPercentageBasisPoints: 1 }, { rewardMode: "UNKNOWN" }, { isActive: "false" }, { productIds: ["p", "p"] }, { description: "x".repeat(2001) }]) assert.throws(() => parseCommerce7Offer({ ...offerBody, ...change }, "CAD"), JSON.stringify(change));
  for (const currency of [null, "JPY", "usd", "XXX"]) assert.throws(() => parseCommerce7Offer(offerBody, currency));
});
test("exclusive wine domain requires one catalog product and cap <=25; activation is gated by the verified access saga, not the parser", () => {
  const draft = { ...offerBody, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", isActive: false, productIds: ["wine"] };
  assert.equal(parseCommerce7Offer(draft, "CAD").rewardMode, "EXCLUSIVE_PRODUCT_ACCESS");
  const accessOnly = parseCommerce7Offer({ ...draft, discountAmountCents: null, discountEnabled: false }, "CAD");
  assert.equal(accessOnly.discountEnabled, false); assert.equal(accessOnly.discountAmountCents, null);
  for (const change of [{ maxTotalRedemptions: 26 }, { productIds: [] }, { productIds: ["a", "b"] }, { exclusiveTagId: 7 }, { exclusiveTagId: " padded " }, { exclusiveTagId: "x".repeat(101) }]) assert.throws(() => parseCommerce7Offer({ ...draft, ...change }, "CAD"), JSON.stringify(change));
  assert.equal(parseCommerce7Offer({ ...draft, isActive: true }, "CAD").isActive, true);
  assert.equal(parseCommerce7Offer({ ...draft, exclusiveTagId: "tag-uuid" }, "CAD").exclusiveTagId, "tag-uuid");
  assert.equal(parseCommerce7Offer({ ...offerBody, exclusiveTagId: "stray" }, "CAD").exclusiveTagId, null, "a discount offer never carries a tag");
  assert.equal(COMMERCE7_REWARD_CAPABILITIES.automaticCustomerTagAssignment, true); assert.equal(COMMERCE7_REWARD_CAPABILITIES.exclusiveProductAccess, true);
});
test("legacy template validation rejects public/shared/club-like wrong references and mismatched scope", () => {
  validateLegacyNativeTemplate(template, [], "template-tag");
  for (const change of [{ availableTo: "Everyone" }, { availableToObjectIds: [] }, { availableToObjectIds: ["wrong"] }, { usageLimit: 2 }, { usageLimitType: "Unlimited" }, { shippingDiscountType: "Free" }, { appliesToObjectIds: ["wine"] }]) assert.throws(() => validateLegacyNativeTemplate({ ...template, ...change }, [], "template-tag"));
  const productTemplate = { ...template, appliesTo: "native-product-scope", appliesToObjectIds: ["wine"] };
  validateLegacyNativeTemplate(productTemplate, ["wine"], "template-tag"); assert.throws(() => validateLegacyNativeTemplate(productTemplate, ["foreign-wine"], "template-tag"));
  // A real tenant reads "no shipping discount" as null; that is the same fact as "No Discount".
  validateLegacyNativeTemplate({ ...template, shippingDiscountType: null }, [], "template-tag");
});
test("closed native coupon parser ignores PII and rejects malformed response/semantic mismatches", () => {
  const parsed = parseNativeCoupon({ ...template, customer: { email: "do-not-store@example.test" }, extra: "ignore" });
  assert.ok(!JSON.stringify(parsed).includes("example.test"));
  for (const change of [{ id: "" }, { startDate: "bad" }, { endDate: "bad" }, { minimumCartAmount: -1 }, { usageLimit: 1.5 }, { availableToObjectIds: [{}] }]) assert.throws(() => parseNativeCoupon({ ...template, ...change }));
  assert.ok(couponMatches(native(payload()), payload())); assert.equal(couponMatches({ ...native(payload()), usageLimit: 10 }, payload()), false);
  assert.throws(() => parseRewardSnapshot({ template: null }));
});
test("server idempotency namespace binds user and offer without PII; tag titles are stable opaque identifiers", () => {
  const key = "same-logical-claim";
  assert.equal(rewardIdempotencyKey("alice", "offer", key), rewardIdempotencyKey("alice", "offer", key));
  assert.notEqual(rewardIdempotencyKey("alice", "offer", key), rewardIdempotencyKey("bob", "offer", key));
  assert.notEqual(rewardIdempotencyKey("alice", "offer", key), rewardIdempotencyKey("alice", "other", key));
  assert.throws(() => rewardIdempotencyKey("alice", "offer", "short")); assert.match(claimTagTitle("claim"), /^SQRATCH-[a-f0-9]{24}$/);
});
test("claim availability treats end as exclusive and issued capacity as permanently consumed", () => {
  const offer = { ...offerBody, claimStartsAt: start, claimEndsAt: end } as unknown as BrandRewardOffer;
  assert.equal(commerce7OfferAvailable(offer, 24, 0, start), true); assert.equal(commerce7OfferAvailable(offer, 25, 0, start), false); assert.equal(commerce7OfferAvailable(offer, 24, 1, start), false); assert.equal(commerce7OfferAvailable(offer, 0, 0, end), false);
});
function client(responses: unknown[], seen: { url: string; init?: RequestInit }[] = []) {
  process.env.COMMERCE7_APP_ID = "synthetic-test-app"; process.env.COMMERCE7_APP_SECRET = "synthetic-test-secret";
  return new Commerce7RewardsClient("test-tenant", async (url, init) => { seen.push({ url: String(url), init }); const response = responses.shift(); if (response instanceof Error) throw response; return response instanceof Response ? response : Response.json(response); });
}
const customer = (id: string, email: string, tags: string[] = []) => ({ id, emails: [{ email }], tags: tags.map((id) => ({ id })) });
test("official documented response shapes parse, but a public coupon is never a customer-restricted legacy template", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/commerce7-rewards/documented-responses.json", import.meta.url), "utf8"));
  const coupon = parseNativeCoupon(fixture.coupon);
  assert.equal(coupon.productDiscount, 1000); assert.equal(coupon.availableTo, "Everyone");
  assert.throws(() => validateLegacyNativeTemplate(coupon, [], fixture.tag.id));
  assert.equal((await client([{ tags: [{ ...fixture.tag, title: claimTagTitle("claim") }], total: 1 }]).findTag("claim"))?.type, "Manual");
  assert.equal((await client([fixture.customer]).customerById(fixture.customer.id)).emails[0], "synthetic@example.test");
});
test("verified-email lookup normalizes exact emails, exhausts pages, rejects ambiguity and another tag member", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  const match = await client([{ customers: [customer("a", " ALICE@example.test ")], cursor: "next" }, { customers: [customer("b", "bob@example.test")] }], seen).customer("alice@example.test");
  assert.equal(match?.id, "a"); assert.ok(seen.every((r) => !r.url.includes("alice") && r.init?.method === "GET")); assert.ok(seen[1].url.includes("cursor=next")); assert.equal(new Headers(seen[0].init?.headers).get("tenant"), "test-tenant");
  await assert.rejects(client([{ customers: [customer("a", "alice@example.test"), customer("b", "ALICE@example.test")] }]).customer("alice@example.test"), { code: "CUSTOMER_AMBIGUOUS" });
  await assert.rejects(client([{ customers: [customer("a", "alice@example.test", ["tag"]), customer("b", "bob@example.test", ["tag"])] }]).customer("alice@example.test", "tag"), { code: "CUSTOMER_AMBIGUOUS" });
  assert.equal(await client([{ customers: [] }]).customer("missing@example.test"), null);
});
test("bounded/repeated customer cursors and ignored pagination fail closed", async () => {
  await assert.rejects(client([{ customers: [], cursor: "start" }]).customer("a@example.test"), { code: "INVALID_PROVIDER_RESPONSE" });
  await assert.rejects(client([{ customers: [], total: 500 }]).customer("a@example.test"), { code: "SEARCH_LIMIT" });
  await assert.rejects(client(Array.from({ length: 20 }, (_, i) => ({ customers: [], cursor: `cursor-${i}` }))).customer("a@example.test"), { code: "SEARCH_LIMIT" });
  await assert.rejects(client([{ customers: [customer("a", "alice@example.test")], cursor: "next" }, { customers: [customer("a", "bob@example.test")] }]).customer("alice@example.test"), { code: "INVALID_PROVIDER_RESPONSE" });
  assert.equal((await client([{ customers: [customer("a", "alice@example.test")], cursor: "next", total: 2 }, { customers: [customer("b", "bob@example.test")], total: 2 }]).customer("alice@example.test"))?.id, "a");
});
test("provider writes never surface request/PII errors; timeout/5xx uncertainty is explicit", async () => {
  for (const response of [new Error("secret or email@example.test"), new Response("upstream PII", { status: 500 })]) {
    await assert.rejects(client([response]).createCoupon(payload()), (error: unknown) => error instanceof Commerce7RewardError && error.uncertain && !error.message.includes("example.test"));
  }
  await assert.rejects(client([new Response("", { status: 403 })]).createCoupon(payload()), { code: "SETUP_INCOMPLETE", uncertain: false });
  await assert.rejects(client([Response.json({ ...template, ...payload(), usageLimit: 99 })]).createCoupon(payload()), { code: "INVALID_PROVIDER_RESPONSE", uncertain: true });
});
test("native coupon revoke uses documented DELETE and confirms absence; never guesses Disabled enum", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  await client([new Response(null, { status: 204 }), new Response(null, { status: 404 })], seen).revokeCoupon("coupon");
  assert.deepEqual(seen.map((r) => r.init?.method), ["DELETE", "GET"]);
  await assert.rejects(client([new Response(null, { status: 204 }), { ...template, id: "coupon" }]).revokeCoupon("coupon"), { uncertain: true });
});
test("tag and coupon recovery require exact unique results and complete search", async () => {
  const tag = { id: "tag", title: claimTagTitle("claim"), type: "Manual", objectType: "Customer" };
  assert.equal((await client([{ tags: [tag], total: 1 }]).findTag("claim"))?.id, "tag");
  await assert.rejects(client([{ tags: [tag, { ...tag, id: "other" }], total: 2 }]).findTag("claim"), { code: "CUSTOMER_AMBIGUOUS" });
  await assert.rejects(client([{ tags: [tag], total: 2 }, { tags: [tag], total: 2 }]).findTag("claim"), { code: "INVALID_PROVIDER_RESPONSE" });
  await assert.rejects(client([{ coupons: [{ ...template, code }], total: 100 }]).findCoupon(code), { code: "SEARCH_LIMIT" });
  assert.equal((await client([{ coupons: [{ ...template, code: code.toLowerCase() }], total: 1 }]).findCoupon(code))?.id, "template");
});
test("redemption reconciliation requires exact order, coupon, customer, tenant/brand and paid version", () => {
  const order = { id: "canonical", provider: "COMMERCE7", brandId: "brand", connectionId: "connection", externalOrderId: "native-order", financialStatus: "PAID", cancelledAt: null, totalMinor: BigInt(1000), providerUpdatedAt: start } as CommerceOrder;
  const claim = { id: "claim", provider: "COMMERCE7", brandId: "brand", connectionId: "connection", providerCustomerId: "alice", externalDiscountId: "coupon", code, status: "ISSUED" } as CommerceRewardRedemption;
  const raw = { id: "native-order", customerId: "alice", updatedAt: start.toISOString(), coupons: [{ couponId: "coupon", id: "applied-entry", code }] };
  assert.equal(exactCommerce7RewardOrderMatch(raw, order, claim), true);
  for (const change of [{ customerId: "bob" }, { id: "other-order" }, { updatedAt: end.toISOString() }, { coupons: [{ code }] }, { coupons: [{ id: "coupon", code }] }, { coupons: [{ couponId: "coupon", id: "applied-entry", code: "OTHER" }] }, { coupons: [code] }, { coupons: [{ couponId: "coupon", id: "a", code }, { couponId: "coupon", id: "b", code }] }]) assert.equal(exactCommerce7RewardOrderMatch({ ...raw, ...change }, order, claim), false);
  for (const change of [{ brandId: "other-brand" }, { connectionId: "other-store" }, { financialStatus: "PENDING" }, { cancelledAt: start }, { totalMinor: BigInt(0) }]) assert.equal(exactCommerce7RewardOrderMatch(raw, { ...order, ...change } as CommerceOrder, claim), false);
});
test("claim DTO hides native customer/tag IDs, provider diagnostics and unready coupon codes", () => {
  const claim = { id: "claim", status: "POINTS_DEBITED", provisioningState: "MANUAL_REVIEW", providerCustomerId: "private", providerTagId: "private", code, couponCreateAttempted: true, entitlementEverGranted: false, needsManualReview: true, provisioningOwner: null } as CommerceRewardRedemption;
  const dto = serializeCommerce7Claim(claim); assert.equal(dto.code, null); assert.equal(dto.canCancel, false); assert.equal(dto.canRetry, false); assert.ok(!JSON.stringify(dto).includes("private"));
});
test("tag-filter verification rejects leaked/shared eligibility and validates pinned customer reads", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  assert.equal(await client([{ customers: [customer("alice", "alice@example.test", ["tag"]) ] }], seen).tagOnlyForCustomer("tag", "alice"), true);
  assert.match(seen[0].url, /tagId=tag&cursor=start/);
  await assert.rejects(client([{ customers: [customer("bob", "bob@example.test", ["tag"])] }]).tagOnlyForCustomer("tag", "alice"), { code: "CUSTOMER_AMBIGUOUS" });
  assert.equal(await client([{ customers: [] }]).tagOnlyForCustomer("tag", "alice"), false);
  await assert.rejects(client([{ customers: [customer("alice", "alice@example.test")] }]).tagOnlyForCustomer("tag", "alice"), { code: "INVALID_PROVIDER_RESPONSE" });
  await assert.rejects(client([customer("bob", "bob@example.test")]).customerById("alice"), { code: "INVALID_PROVIDER_RESPONSE" });
  assert.equal((await client([customer("alice", "alice@example.test")]).customerById("alice")).id, "alice");
});
test("revoked and expired claims can record a prior purchase without inventing eligibility", () => {
  const order = { provider: "COMMERCE7", brandId: "brand", connectionId: "connection", externalOrderId: "order", financialStatus: "PAID", cancelledAt: null, totalMinor: BigInt(1000), providerUpdatedAt: start, providerCreatedAt: start } as CommerceOrder;
  const claim = { provider: "COMMERCE7", brandId: "brand", connectionId: "connection", providerCustomerId: "alice", externalDiscountId: "coupon", code, status: "CANCELLED", entitlementEverGranted: true, expiresAt: end } as CommerceRewardRedemption;
  const raw = { id: "order", customerId: "alice", updatedAt: start.toISOString(), coupons: [{ couponId: "coupon", id: "applied-entry", code }] };
  assert.equal(exactCommerce7RewardOrderMatch(raw, order, claim), true);
  assert.equal(exactCommerce7RewardOrderMatch(raw, order, { ...claim, entitlementEverGranted: false }), false);
  assert.equal(exactCommerce7RewardOrderMatch(raw, { ...order, providerCreatedAt: new Date(end.getTime() + 1) }, claim), false);
  assert.equal(exactCommerce7RewardOrderMatch(raw, order, { ...claim, status: "EXPIRED" }), true);
  assert.equal(exactCommerce7RewardOrderMatch(raw, order, { ...claim, status: "REFUNDED" }), false);
});
