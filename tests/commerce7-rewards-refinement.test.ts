import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { CommerceOrder, CommerceRewardRedemption } from "@prisma/client";
import * as domain from "../src/lib/commerce7-reward-domain";
import * as provider from "../src/lib/commerce/providers/commerce7-rewards-client";
import { storedCommerce7Eligibility } from "../src/lib/commerce7-reward-eligibility";
import { exactCommerce7RewardOrderMatch } from "../src/lib/commerce/providers/commerce7-reward-orders";
import { fakeTenant, harness, offerBody, verifiedEmail, type Row } from "./commerce7-reward-harness";

const documented = JSON.parse(readFileSync("tests/fixtures/commerce7-rewards/documented-responses.json", "utf8")).coupon as provider.NativeCoupon;
const publicTemplate = { ...documented, id: "template", usageLimitType: "Per Store", usageLimit: 1 } as provider.NativeCoupon;
const taggedTemplate = { ...publicTemplate, availableTo: "opaque-native-tag-mode", availableToObjectIds: ["template-tag"] };

test("explicit product scopes clear IDs or require selection; new/default, stored and exclusive eligibility differ safely", () => {
  assert.deepEqual(domain.parseCommerce7Offer({ ...offerBody, productIds: ["stale"] }, "CAD").productIds, []);
  assert.throws(() => domain.parseCommerce7Offer({ ...offerBody, appliesTo: "SPECIFIC_PRODUCTS", productIds: [] }, "CAD"), /Select at least one/);
  assert.equal(domain.parseCommerce7Offer(offerBody, "CAD").eligibilityMode, "ANYONE_WITH_CODE");
  assert.equal(storedCommerce7Eligibility({}), "CLAIMANT_ONLY");
  assert.equal(storedCommerce7Eligibility({ eligibilityMode: "invented" }), null);
  assert.throws(() => domain.parseCommerce7Offer({ ...offerBody, eligibilityMode: "invented" }, "CAD"));
  const exclusive = { ...offerBody, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", isActive: false, eligibilityMode: "ANYONE_WITH_CODE", productIds: ["wine"] };
  assert.equal(domain.parseCommerce7Offer(exclusive, "CAD").eligibilityMode, "CLAIMANT_ONLY");
  assert.equal(domain.parseCommerce7Offer({ ...exclusive, isActive: true }, "CAD").eligibilityMode, "CLAIMANT_ONLY", "activation is gated by the verified access saga, and eligibility stays bound");
});

test("legacy template matrix retains independent eligibility, store/product and one-use/no-shipping checks", () => {
  for (const products of [[], ["wine"]]) {
    const scope = products.length ? { appliesTo: "opaque-native-product-mode", appliesToObjectIds: products } : {};
    domain.validateLegacyNativeTemplate({ ...publicTemplate, ...scope }, products, null, "ANYONE_WITH_CODE");
    domain.validateLegacyNativeTemplate({ ...taggedTemplate, ...scope }, products, "template-tag", "CLAIMANT_ONLY");
    assert.throws(() => domain.validateLegacyNativeTemplate({ ...taggedTemplate, ...scope }, products, "template-tag", "ANYONE_WITH_CODE"));
    assert.throws(() => domain.validateLegacyNativeTemplate({ ...publicTemplate, ...scope }, products, null, "CLAIMANT_ONLY"));
    assert.throws(() => domain.validateLegacyNativeTemplate({ ...publicTemplate, ...scope, usageLimit: 2 }, products, null, "ANYONE_WITH_CODE"));
    assert.throws(() => domain.validateLegacyNativeTemplate({ ...publicTemplate, ...scope, shippingDiscount: 10 }, products, null, "ANYONE_WITH_CODE"));
  }
  assert.throws(() => domain.validateLegacyNativeTemplate({ ...publicTemplate, availableToObjectIds: ["unexpected"] }, [], null, "ANYONE_WITH_CODE"));
});

test("capacity, insufficient points and Brand/user isolation remain enforced without a template", async () => {
  const denied = harness(); await assert.rejects(denied.reserve("synthetic-request-key", "user", ["other-brand"]), { code: "NOT_FOUND" });
  denied.offer().reservedClaimCount = 25; await assert.rejects(denied.reserve(), { code: "SOLD_OUT" }); assert.equal(denied.ledger.size, 0);
  const insufficient = harness({ offer: { pointsCost: 501 } });
  await assert.rejects(insufficient.reserve(), { code: "INSUFFICIENT_POINTS" }); assert.equal(insufficient.offer().reservedClaimCount, 0); assert.equal(insufficient.claims().length, 0); assert.equal(insufficient.balance(), 500);
  const limited = harness({ offer: { maxRedemptionsPerUser: 1 } }); await limited.reserve();
  await assert.rejects(limited.reserve("a-different-request-key"), { code: "USER_LIMIT" }); assert.equal(limited.balance(), 400);
  const inactive = harness({ offer: { isActive: false } }); await assert.rejects(inactive.reserve(), { code: "INACTIVE" });
});

test("a pre-refinement claimant offer without a stored mode stays customer-bound: verified email, pinned native customer and manual tag checks", async () => {
  const tenant = fakeTenant({ customers: [{ id: "alice", email: "alice@example.test" }] });
  const app = harness({ mode: "CLAIMANT_ONLY", config: "LEGACY_TEMPLATE", tenant });
  delete (app.offer().commerce7Config as Row).eligibilityMode;
  await assert.rejects(app.reserve(), { code: "EMAIL_VERIFICATION_REQUIRED" });
  Object.assign(app.tables.user[0], verifiedEmail);
  const claim = await app.reserve(); assert.equal((claim.rewardConfigSnapshot as Row).eligibilityMode, "CLAIMANT_ONLY");
  app.tables.user[0].emailVerifiedAt = new Date("2026-10-02"); await app.provision(claim.id); assert.equal(app.calls.length, 0);
  assert.match(String(app.claims()[0].errorMessage), /verified email changed/);
  const manual = harness({ mode: "CLAIMANT_ONLY", config: "LEGACY_TEMPLATE", tenant: fakeTenant({ customers: [{ id: "alice", email: "alice@example.test" }] }), user: verifiedEmail });
  const waiting = await manual.reserve(); assert.equal((await manual.provision(waiting.id))?.provisioningState, "AWAITING_ELIGIBILITY");
  assert.equal(manual.claims()[0].providerCustomerId, "alice"); assert.ok(manual.calls.every((call) => call.method === "GET" || call.path === "/v1/tag/customer"));
  assert.equal(manual.calls.filter((call) => call.method === "POST" && call.path === "/v1/coupon").length, 0);
});

test("bearer purchase matching requires exact coupon/paid order/connection, without attributing the purchaser to the claimant", () => {
  const at = new Date("2026-10-10"); const code = `SQRA${"A".repeat(32)}`;
  const order = { provider: "COMMERCE7", brandId: "brand", connectionId: "connection", externalOrderId: "order", financialStatus: "PAID", cancelledAt: null, totalMinor: BigInt(1000), providerUpdatedAt: at } as CommerceOrder;
  const claim = { provider: "COMMERCE7", brandId: "brand", connectionId: "connection", status: "ISSUED", code, externalDiscountId: "coupon", providerCustomerId: null, rewardConfigSnapshot: { eligibilityMode: "ANYONE_WITH_CODE" } } as unknown as CommerceRewardRedemption;
  const raw = { id: "order", customerId: "another-customer", updatedAt: at.toISOString(), coupons: [{ couponId: "coupon", id: "applied-entry", code }] };
  assert.equal(exactCommerce7RewardOrderMatch(raw, order, claim), true);
  for (const change of [{ connectionId: "other" }, { brandId: "other" }, { financialStatus: "PENDING" }, { financialStatus: "PARTIALLY_REFUNDED" }]) assert.equal(exactCommerce7RewardOrderMatch(raw, { ...order, ...change } as CommerceOrder, claim), false);
  assert.equal(exactCommerce7RewardOrderMatch(raw, order, { ...claim, rewardConfigSnapshot: {} }), false);
  assert.equal(exactCommerce7RewardOrderMatch(raw, order, { ...claim, rewardConfigSnapshot: { eligibilityMode: "unknown" } }), false);
  // The new snapshot carries its eligibility in the same field the reader already trusts.
  assert.equal(exactCommerce7RewardOrderMatch(raw, order, { ...claim, rewardConfigSnapshot: { snapshotVersion: 2, eligibilityMode: "ANYONE_WITH_CODE" } }), true);
});

test("a template-free claim is matched to its purchase by the same exact coupon identity", async () => {
  const app = harness(); const claim = await app.reserve(); const issued = await app.provision(claim.id);
  const at = new Date("2026-10-10"); const order = { provider: "COMMERCE7", brandId: "brand", connectionId: "connection", externalOrderId: "order", financialStatus: "PAID", cancelledAt: null, totalMinor: BigInt(1000), providerUpdatedAt: at } as CommerceOrder;
  const raw = { id: "order", customerId: "any-customer", updatedAt: at.toISOString(), coupons: [{ couponId: issued?.externalDiscountId, id: "applied-entry", code: issued?.code }] };
  assert.equal(exactCommerce7RewardOrderMatch(raw, order, issued as CommerceRewardRedemption), true);
  assert.equal(exactCommerce7RewardOrderMatch({ ...raw, coupons: [{ couponId: "someone-elses", id: "applied-entry", code: issued?.code }] }, order, issued as CommerceRewardRedemption), false);
});

test("edits without an eligibility field retain the persisted/legacy binding instead of defaulting public, with no provider traffic", async () => {
  const bearer = harness({ mode: "ANYONE_WITH_CODE", config: "LEGACY_TEMPLATE" });
  assert.equal(((await bearer.save(offerBody, "offer")).commerce7Config as Row).eligibilityMode, "ANYONE_WITH_CODE");
  assert.equal(bearer.calls.length, 0); assert.equal(bearer.clientsCreated(), 0);
  // A claimant offer (legacy with no stored mode, or template-free) edited without the field keeps its binding, so the edit is
  // refused instead of defaulting public; the stored record is untouched.
  for (const app of [harness({ mode: "CLAIMANT_ONLY", config: "LEGACY_TEMPLATE" }), harness({ mode: "CLAIMANT_ONLY" })]) {
    delete (app.offer().commerce7Config as Row).eligibilityMode; const before = JSON.stringify(app.offer());
    for (const isActive of [true, false]) await assert.rejects(app.save({ ...offerBody, isActive }, "offer"), { code: "CLAIMANT_DISCOUNT_RETIRED" });
    assert.equal(JSON.stringify(app.offer()), before); assert.equal(app.calls.length, 0);
  }
});
