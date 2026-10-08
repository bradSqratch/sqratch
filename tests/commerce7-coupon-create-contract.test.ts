import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { Commerce7RewardsClient } from "../src/lib/commerce/providers/commerce7-rewards-client";
import { COMMERCE7_COUPON_CONTRACT } from "../src/lib/commerce7-coupon-contract";
import { harness, type Row } from "./commerce7-reward-harness";

const live = JSON.parse(readFileSync(new URL("./fixtures/commerce7-rewards/live-coupon-create-422.json", import.meta.url), "utf8")) as { evidence: { sentButNotFlagged: string[] }; status: number; body: { errors: { field: string; message: string }[] } };
const required = live.body.errors.filter((error) => error.message === "required").map((error) => error.field);
const rejected = live.body.errors.filter((error) => error.message === "invalid additional property").map((error) => error.field);
const respond = () => new Response(JSON.stringify(live.body), { status: live.status, headers: { "Content-Type": "application/json" } });
const isCouponPost = (path: string, method: string) => method === "POST" && path === "/v1/coupon";

test("the live 422 evidence is recorded exactly as supplied", () => {
  assert.equal(live.status, 422); assert.deepEqual(required, ["type", "discountType", "discount"]); assert.deepEqual(rejected, ["productDiscountType", "productDiscount", "shippingDiscountType"]);
});

test("the live 422 is a deterministic rejection: points refunded once, capacity released once, no coupon, and the body never reaches the claim, logs or Brand", async () => {
  const app = harness(); app.tenant.failures.push({ when: isCouponPost, respond });
  const claim = await app.reserve(); const result = await app.provision(claim.id);
  assert.equal(result?.status, "REFUNDED"); assert.equal(result?.provisioningState, "FAILED_FINAL"); assert.equal(result?.slotReleased, true); assert.equal(result?.couponCreateAttempted, false); assert.equal(result?.entitlementEverGranted, false);
  assert.equal(app.balance(), 500); assert.deepEqual([...app.ledger.values()], ["SPEND", "REFUND"]); assert.equal(app.offer().reservedClaimCount, 0); assert.equal(app.tenant.coupons.length, 0);
  assert.equal(app.postBodies().length, 1, "exactly one write was attempted");
  assert.equal(app.claims()[0].lastReconcileReason, "COUPON_CREATE:WRITE_REJECTED");
  const leaked = JSON.stringify([result?.errorMessage, result?.lastReconcileReason, app.logs]);
  for (const word of [...required, ...rejected, "validationError", "One or more elements"]) assert.ok(!leaked.includes(word), `provider body text "${word}" must not be stored or logged`);
  const log = app.logs[0] as Row; assert.deepEqual(Object.keys(log).sort(), ["claimId", "code", "connectionId", "event", "provider", "stage", "uncertain"]); assert.equal(log.stage, "COUPON_CREATE"); assert.equal(log.uncertain, false);
});

test("replays and double-clicks after the live 422 neither re-post nor refund twice", async () => {
  const app = harness(); app.tenant.failures.push({ when: isCouponPost, respond });
  const claim = await app.reserve(); await app.provision(claim.id);
  const replay = await app.reserve(); assert.equal(replay.id, claim.id, "the same request key returns the same, now-refunded claim");
  app.advance(); await app.provision(claim.id); await app.provision(claim.id); await app.cancel(claim.id); await app.cancel(claim.id);
  assert.equal(app.postBodies().length, 1); assert.equal(app.balance(), 500); assert.deepEqual([...app.ledger.values()], ["SPEND", "REFUND"]); assert.equal(app.offer().reservedClaimCount, 0); assert.equal(app.claims().length, 1);
});

test("an ambiguous write after the same request stays non-refundable and is never re-posted", async () => {
  for (const failure of [() => { throw new Error("socket hang up"); }, () => new Response("upstream", { status: 504 }), () => new Response("upstream", { status: 502 })]) {
    const app = harness(); app.tenant.failures.push({ when: isCouponPost, respond: failure });
    const claim = await app.reserve(); const result = await app.provision(claim.id);
    assert.equal(result?.provisioningState, "MANUAL_REVIEW"); assert.equal(result?.status, "POINTS_DEBITED"); assert.equal(result?.couponCreateAttempted, true); assert.equal(app.balance(), 400);
    app.advance(); app.claims()[0].needsManualReview = false; await app.provision(claim.id); assert.equal(app.postBodies().length, 1);
  }
});

test("the 422 classification is the provider client's, independent of the claim flow", async () => {
  process.env.COMMERCE7_APP_ID = "synthetic-test-app"; process.env.COMMERCE7_APP_SECRET = "synthetic-test-secret";
  const client = new Commerce7RewardsClient("synthetic-tenant", async () => respond());
  await assert.rejects(client.createCoupon({} as never), (error: unknown) => (error as { code?: string }).code === "WRITE_REJECTED" && (error as { uncertain?: boolean }).uncertain === false && !/type|discount|validation/i.test((error as Error).message));
});

// ── The proven live write contract (tests/fixtures/commerce7-rewards/live-coupon-create-201.json) ──
const created = JSON.parse(readFileSync(new URL("./fixtures/commerce7-rewards/live-coupon-create-201.json", import.meta.url), "utf8")) as { fixedAmount: { request: Row }; percentage: { request: Row }; minimumSubtotal: { requestFields: Row } };
const obsolete = ["productDiscountType", "productDiscount", "shippingDiscountType", "shippingDiscount", "minimumCartAmount"];
const dynamic = new Set(["code", "title", "startDate", "endDate"]);
// Percentage issuance is gated until a live 1500 = 15% is observed; these writer tests opt in to the verified unit explicitly.
const percentVerified = { ...COMMERCE7_COUPON_CONTRACT, percentage: { ...COMMERCE7_COUPON_CONTRACT.percentage, verified: true } };
async function postedFor(offer: Row = {}) { const app = harness({ offer, ...(offer.discountType === "PERCENTAGE" ? { contract: percentVerified } : {}) }); const claim = await app.reserve(); const result = await app.provision(claim.id); return { app, claim, result, body: app.postBodies()[0] }; }
const withoutDynamic = (body: Row) => Object.fromEntries(Object.entries(body).filter(([key]) => !dynamic.has(key)));

test("the current writer sends every field the live provider requires and none that it rejects", async () => {
  const { body } = await postedFor(); const sent = new Set(Object.keys(body));
  for (const field of rejected) assert.ok(!sent.has(field), `writer must not send "${field}"`);
  for (const field of required) assert.ok(sent.has(field), `writer must send "${field}"`);
  for (const field of live.evidence.sentButNotFlagged) assert.ok(sent.has(field), `accepted field "${field}" is still sent`);
});

test("fixed amount: the outgoing payload is exactly the proven 201 request (plus code, title and the claim window)", async () => {
  const { body, result, claim } = await postedFor({ discountAmountCents: 1000, minimumSubtotalCents: null });
  assert.deepEqual(withoutDynamic(body), created.fixedAmount.request);
  assert.equal(body.code, claim.code); assert.match(String(body.title), /^SQRATCH /); assert.equal(body.startDate, "2026-10-10T00:00:00.000Z"); assert.equal(body.endDate, "2026-11-09T00:00:00.000Z");
  assert.equal(result?.status, "ISSUED");
});

test("percentage: the outgoing payload is the 201-proven shape, but 15% is sent as 1500 because the probe's 15 was applied as 0.15%", async () => {
  const { body, result } = await postedFor({ discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1500 });
  assert.equal(created.percentage.request.discount, 15, "the probe value that HTTP 201 accepted but Commerce7 applied as 0.15%");
  assert.equal(body.discount, 1500); assert.deepEqual({ ...withoutDynamic(body), discount: created.percentage.request.discount }, created.percentage.request); assert.equal("dollarOffDiscountApplies" in body, false);
  assert.equal(result?.status, "ISSUED", "the provider-defaulted dollarOffDiscountApplies echo is accepted");
});

test("minimum subtotal: Minimum Purchase Amount with exact minor units and All Items; no minimum sends None and nothing else", async () => {
  const { body, result } = await postedFor({ minimumSubtotalCents: 5000 });
  assert.equal(body.cartRequirementType, created.minimumSubtotal.requestFields.cartRequirementType); assert.equal(body.cartRequirementCountType, created.minimumSubtotal.requestFields.cartRequirementCountType);
  assert.equal(body.cartRequirement, 5000); assert.equal(Number.isSafeInteger(body.cartRequirement), true); assert.equal("cartRequirementMaximum" in body, false);
  assert.equal(result?.status, "ISSUED");
  const none = (await postedFor({ minimumSubtotalCents: null })).body;
  assert.equal(none.cartRequirementType, "None"); for (const key of ["cartRequirement", "cartRequirementMaximum", "cartRequirementCountType"]) assert.equal(key in none, false, key);
});

test("no obsolete or guessed field can be sent for any supported reward", async () => {
  for (const offer of [{}, { minimumSubtotalCents: 5000 }, { discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 10000 }, { discountAmountCents: 2147483647 }]) {
    const { body } = await postedFor(offer);
    for (const field of obsolete) assert.equal(field in body, false, `${field} for ${JSON.stringify(offer)}`);
    assert.deepEqual(Object.keys(body).filter((key) => !["code", "title", "type", "status", "usageLimitType", "usageLimit", "appliesTo", "availableTo", "discountType", "discount", "dollarOffDiscountApplies", "cartRequirementType", "cartRequirement", "cartRequirementCountType", "startDate", "endDate"].includes(key)), [], "closed field set");
  }
});

test("fractional percentages still fail closed before any write, and fixed amounts stay exact integers", async () => {
  for (const basis of [1550, 99, 10001]) {
    const app = harness({ offer: { discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: basis } });
    // Refused at reservation by the claim snapshot, before any debit or provider call (the builder's own refusal is unit-tested separately).
    await assert.rejects(app.reserve(), { code: "INVALID_OFFER" }); assert.equal(app.postBodies().length, 0);
  }
  assert.equal((await postedFor({ discountAmountCents: 1999 })).body.discount, 1999);
});

test("the writer targets only the public v1 API with Basic app credentials; never v2, a JWT or an admin contract", async () => {
  const seen: { url: string; init?: RequestInit }[] = [];
  process.env.COMMERCE7_APP_ID = "synthetic-test-app"; process.env.COMMERCE7_APP_SECRET = "synthetic-test-secret";
  const client = new Commerce7RewardsClient("synthetic-tenant", async (url, init) => { seen.push({ url: String(url), init }); return Response.json({ statusCode: 422 }, { status: 422 }); });
  const { body } = await postedFor();
  await assert.rejects(client.createCoupon(body as never), { code: "WRITE_REJECTED" });
  assert.equal(seen[0].url, "https://api.commerce7.com/v1/coupon"); assert.equal(seen[0].init?.method, "POST");
  const headers = new Headers(seen[0].init?.headers); assert.match(String(headers.get("Authorization")), /^Basic [A-Za-z0-9+/=]+$/); assert.equal(headers.get("tenant"), "synthetic-tenant");
  assert.doesNotMatch(JSON.stringify(seen), /\/v2\/|Bearer|jwt/i);
});

// ── Live product-scoped coupon (HTTP 201) ─────────────────────────────────────
const productCoupon = JSON.parse(readFileSync(new URL("./fixtures/commerce7-rewards/live-coupon-create-product-201.json", import.meta.url), "utf8")) as { status: number; response: Row };
test("the live product-scoped 201 parses and is semantically matched against the write request it proves", async () => {
  const { parseNativeCoupon, couponMatches } = await import("../src/lib/commerce/providers/commerce7-rewards-client");
  const response = productCoupon.response;
  const coupon = parseNativeCoupon(response);
  assert.equal(coupon.appliesTo, "Product"); assert.deepEqual(coupon.appliesToObjectIds, response.appliesToObjectIds); assert.equal(coupon.availableToObjectIds, null);
  // The write fields the 201 echoes; extra provider fields (channels, clubFrequencies, promotionSets, usageCount) are ignored.
  const request = { code: String(response.code), title: String(response.title), type: "Product", status: "Enabled", usageLimitType: "Per Store", usageLimit: 1, appliesTo: "Product", appliesToObjectIds: response.appliesToObjectIds as string[], availableTo: "Everyone", discountType: "Dollar Off", discount: 1000, dollarOffDiscountApplies: "Once Per Order", cartRequirementType: "None", startDate: String(response.startDate), endDate: String(response.endDate) };
  assert.equal(couponMatches(coupon, request), true);
  for (const drift of [{ appliesToObjectIds: ["another-product"] }, { appliesTo: "Store", appliesToObjectIds: undefined }, { discount: 999 }, { availableTo: "opaque-customer-tag", availableToObjectIds: ["tag"] }]) assert.equal(couponMatches(coupon, { ...request, ...drift } as never), false, JSON.stringify(drift));
});

test("a selected-product discount claim sends exactly the live-proven product scope and is issued once", async () => {
  const app = harness({ appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-b", "wine-a"] });
  const claim = await app.reserve(); const result = await app.provision(claim.id);
  assert.equal(result?.status, "ISSUED"); assert.equal(app.postBodies().length, 1);
  const [body] = app.postBodies();
  assert.equal(body.appliesTo, productCoupon.response.appliesTo); assert.deepEqual(body.appliesToObjectIds, ["wine-a", "wine-b"]);
  assert.equal(body.availableTo, "Everyone"); assert.equal(body.availableToObjectIds, undefined); assert.equal(body.type, productCoupon.response.type); assert.equal(body.usageLimitType, "Per Store"); assert.equal(body.usageLimit, 1);
  assert.equal(app.balance(), 400); assert.equal(app.ledger.size, 1);
});
