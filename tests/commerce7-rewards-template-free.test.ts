import assert from "node:assert/strict";
import { test } from "node:test";
import { claimTagTitle } from "../src/lib/commerce/providers/commerce7-rewards-client";
import { fakeTenant, harness, secureForExclusive, legacyTemplate, offerBody, verifiedContract, verifiedEmail, OPAQUE_CUSTOMER_TAG, OPAQUE_PRODUCT_SCOPE, type Row } from "./commerce7-reward-harness";

const couponPosts = (app: ReturnType<typeof harness>) => app.calls.filter((call) => call.method === "POST" && call.path === "/v1/coupon");
const alice = { id: "alice", email: "alice@example.test" };

// ── Offer save is SQRATCH-only ────────────────────────────────────────────────

test("a Brand saves an anyone-with-code, all-products discount with no template ID and no provider traffic", async () => {
  const app = harness();
  const saved = await app.save({ ...offerBody, templateCouponId: undefined });
  assert.deepEqual(saved.commerce7Config, { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true });
  assert.equal(saved.isActive, true); assert.equal(saved.appliesTo, "ALL_PRODUCTS");
  assert.equal(app.calls.length, 0, "no coupon/customer/tag call"); assert.equal(app.clientsCreated(), 0, "no provider client is even constructed");
  assert.equal(app.logs.length, 0, "no template/setup stage can be logged");
});

test("every discount save path (create, edit, drafts, selected products) performs zero provider calls; an exclusive save only reads its tag", async () => {
  const app = harness({ appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a"], tenant: fakeTenant({ tags: [{ id: "synthetic-customer-tag-id", title: "Rare Wine Members" }] }) }); secureForExclusive(app, "wine-a");
  await app.save({ ...offerBody, appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a", "wine-b"], isActive: false });
  await app.save({ ...offerBody, appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a", "wine-b"], isActive: true });
  await app.save({ ...offerBody, isActive: false, eligibilityMode: "CLAIMANT_ONLY" }, "offer");
  await app.save({ ...offerBody, isActive: true, eligibilityMode: "ANYONE_WITH_CODE" }, "offer");
  assert.equal(app.calls.length, 0); assert.equal(app.clientsCreated(), 0);
  await app.save({ ...offerBody, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", isActive: false, discountEnabled: false, productIds: ["wine-a"], maxTotalRedemptions: 25 }, "offer");
  assert.deepEqual(app.calls.map((call) => `${call.method} ${call.path}`), ["GET /v1/tag/customer/synthetic-customer-tag-id"], "one read-only Tag lookup, never a write");
});

test("save validates selected products against this connection's catalog and never trusts client identity", async () => {
  const app = harness();
  await assert.rejects(app.save({ ...offerBody, appliesTo: "SPECIFIC_PRODUCTS", productIds: ["foreign-wine"], isActive: false }), { code: "INVALID_OFFER" });
  await assert.rejects(app.save({ ...offerBody, appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a", "foreign-wine"], isActive: false }), { code: "INVALID_OFFER" });
  const saved = await app.save({ ...offerBody, brandId: "forged-brand", connectionId: "forged", currencyCode: "USD", sourceExternalAccountId: "forged" });
  assert.equal(saved.brandId, "brand"); assert.equal(saved.connectionId, "connection"); assert.equal(saved.currencyCode, "CAD"); assert.equal(saved.sourceExternalAccountId, "synthetic-tenant");
  assert.equal(app.calls.length, 0);
});

test("the still-unproven claimant-only branch saves as a draft but cannot be activated; selected products now go live; nothing is written on rejection", async () => {
  const app = harness();
  await assert.rejects(app.save({ ...offerBody, eligibilityMode: "CLAIMANT_ONLY", isActive: true }), { code: "COUPON_CONTRACT_UNVERIFIED" });
  assert.equal((await app.save({ ...offerBody, eligibilityMode: "CLAIMANT_ONLY", isActive: false })).isActive, false);
  assert.equal((await app.save({ ...offerBody, appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a"], isActive: true })).isActive, true, "the live 201 proved the Product scope");
  await assert.rejects(app.save({ ...offerBody, eligibilityMode: "CLAIMANT_ONLY", appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a"], isActive: true }), { code: "COUPON_CONTRACT_UNVERIFIED" });
  const before = JSON.stringify(app.offer());
  await assert.rejects(app.save({ ...offerBody, eligibilityMode: "CLAIMANT_ONLY", isActive: true }, "offer"), { code: "COUPON_CONTRACT_UNVERIFIED" });
  assert.equal(JSON.stringify(app.offer()), before); assert.equal(app.calls.length, 0);
});

test("once a Coupon enum is proven in the contract, the same branch activates without any template", async () => {
  const app = harness({ contract: verifiedContract });
  const claimant = await app.save({ ...offerBody, eligibilityMode: "CLAIMANT_ONLY", isActive: true });
  assert.equal(claimant.isActive, true); assert.deepEqual(claimant.commerce7Config, { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: true });
  assert.equal((await app.save({ ...offerBody, appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a"], isActive: true })).appliesTo, "SPECIFIC_PRODUCTS");
  assert.equal(app.calls.length, 0);
});

test("editing keeps a legacy offer's binding and native evidence when still valid, and drops it when the edit changes the scope", async () => {
  const app = harness({ mode: "CLAIMANT_ONLY", config: "LEGACY_TEMPLATE" });
  const kept = await app.save({ ...offerBody, title: "Renamed" }, "offer");   // no eligibilityMode: the stored binding is retained
  const config = kept.commerce7Config as Row;
  assert.equal(config.eligibilityMode, "CLAIMANT_ONLY"); assert.equal((config.template as Row).availableTo, "legacy-customer-tag"); assert.equal(kept.isActive, true);
  const moved = await app.save({ ...offerBody, appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-b"], isActive: false, eligibilityMode: "CLAIMANT_ONLY" }, "offer");
  assert.ok(!("template" in (moved.commerce7Config as Row)));
  await assert.rejects(app.save({ ...offerBody, appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-b"], isActive: true, eligibilityMode: "CLAIMANT_ONLY" }, "offer"), { code: "COUPON_CONTRACT_UNVERIFIED" });
  // A bearer edit of a legacy bearer offer is verified by the contract, so the stored template is dropped, not required.
  const bearer = harness({ config: "LEGACY_TEMPLATE" });
  const saved = await bearer.save({ ...offerBody }, "offer");
  assert.deepEqual(saved.commerce7Config, { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true }); assert.equal(bearer.calls.length, 0);
});

// ── One native coupon per claim, built from the frozen snapshot ───────────────

test("a claim creates exactly one direct coupon: recovery read, then one POST, with the frozen terms and no template read", async () => {
  const app = harness({ offer: { minimumSubtotalCents: 5000 } });
  const claim = await app.reserve();
  assert.equal(claim.verifiedEmailAt, null); assert.equal(claim.provisioningState, "PROVISIONING");
  assert.deepEqual(claim.rewardConfigSnapshot, { snapshotVersion: 2, eligibilityMode: "ANYONE_WITH_CODE", title: "Test reward", minimumSubtotalCents: 5000, appliesTo: "ALL_PRODUCTS", productIds: [], discount: { type: "FIXED_AMOUNT", amountCents: 1000, percentageBasisPoints: null } });
  assert.equal(app.calls.length, 0, "reserving a claim never touches the provider");
  const issued = await app.provision(claim.id);
  assert.equal(issued?.status, "ISSUED"); assert.equal(issued?.provisioningState, "READY"); assert.equal(issued?.entitlementEverGranted, true); assert.equal(issued?.externalDiscountId, "coupon-1");
  assert.deepEqual(app.calls.map((call) => `${call.method} ${new URL(`https://x${call.path}`).pathname}`), ["GET /v1/coupon", "POST /v1/coupon"]);
  const [body] = app.postBodies();
  assert.deepEqual(body, { code: claim.code, title: body.title, type: "Product", status: "Enabled", usageLimitType: "Per Store", usageLimit: 1, appliesTo: "Store", availableTo: "Everyone", discountType: "Dollar Off", discount: 1000, dollarOffDiscountApplies: "Once Per Order", cartRequirementType: "Minimum Purchase Amount", cartRequirement: 5000, cartRequirementCountType: "All Items", startDate: "2026-10-10T00:00:00.000Z", endDate: "2026-11-09T00:00:00.000Z" });
  assert.match(String(body.code), /^SQRA[A-F0-9]{32}$/); assert.doesNotMatch(String(body.title), /SQRA[A-F0-9]{32}/);
  assert.ok(app.calls.every((call) => !/coupon\/|customer|tag/.test(call.path)), "no template, customer or tag operation for a bearer coupon");
});

test("the payload is Per Store / one use, Everyone and whole-store, with no object-ID or shipping fields", async () => {
  const app = harness(); const claim = await app.reserve(); await app.provision(claim.id);
  const [body] = app.postBodies();
  assert.equal(body.usageLimitType, "Per Store"); assert.equal(body.usageLimit, 1); assert.equal(body.availableTo, "Everyone"); assert.equal(body.appliesTo, "Store");
  assert.equal(body.cartRequirementType, "None");
  for (const key of ["availableToObjectIds", "appliesToObjectIds", "shippingDiscount", "shippingDiscountType", "productDiscount", "productDiscountType", "minimumCartAmount", "cartRequirement", "cartRequirementCountType", "cartRequirementMaximum"]) assert.equal(key in body, false, key);
});

test("fixed amounts map to exact integer cents and whole percentages map exactly; minimums and validity never use float math", async () => {
  for (const [offer, type, value] of [[{ discountAmountCents: 1999 }, "Dollar Off", 1999], [{ discountAmountCents: 1 }, "Dollar Off", 1], [{ discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1500 }, "Percentage Off", 1500], [{ discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 10000 }, "Percentage Off", 10000]] as const) {
    // Native percentages are hundredths of a percent (live: 15 was 0.15%); percentage issuance requires the verified unit.
    const app = harness({ offer: { ...offer, minimumSubtotalCents: 4999 }, ...("discountType" in offer ? { contract: { ...verifiedContract, percentage: { ...verifiedContract.percentage, verified: true } } } : {}) }); const claim = await app.reserve(); await app.provision(claim.id);
    const [body] = app.postBodies(); assert.equal(body.discountType, type); assert.equal(body.discount, value); assert.equal(body.cartRequirement, 4999); assert.equal(body.cartRequirementType, "Minimum Purchase Amount"); assert.equal(body.cartRequirementCountType, "All Items");
  }
});

test("effective dates are the claim's stable, minute-aligned UTC window and are identical on every attempt", async () => {
  // Reserved at 00:00:37.123 with 30 days of validity: the window is aligned to the minute and never shifts with retries.
  const app = harness({ startAt: new Date("2026-10-10T00:00:37.123Z") });
  const claim = await app.reserve();
  assert.equal(new Date(claim.expiresAt as Date).toISOString(), "2026-11-09T00:00:00.000Z");
  app.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/coupon", respond: () => new Response("{}", { status: 429 }) });
  assert.equal((await app.provision(claim.id))?.provisioningState, "FAILED_RETRYABLE");
  app.tenant.failures.length = 0; app.advance(3600000);
  assert.equal((await app.provision(claim.id))?.status, "ISSUED");
  const [first, second] = app.postBodies(); assert.equal(app.postBodies().length, 2);
  assert.equal(first.startDate, "2026-10-10T00:00:00.000Z"); assert.equal(first.endDate, "2026-11-09T00:00:00.000Z");
  assert.deepEqual(second, first);
});

test("double click and replayed requests yield one claim, one debit, one capacity slot and one coupon", async () => {
  const app = harness();
  // Replays are sequential here: this in-memory store has no isolation. Concurrent reservations are covered by the opt-in real-Postgres suite.
  const a = await app.reserve(); const b = await app.reserve();
  assert.equal(a.id, b.id); assert.equal(app.claims().length, 1); assert.equal(app.balance(), 400); assert.equal(app.ledger.size, 1); assert.equal(app.offer().reservedClaimCount, 1);
  assert.equal((await app.provision(a.id))?.status, "ISSUED"); app.advance();
  assert.equal((await app.provision(a.id))?.status, "ISSUED"); assert.equal((await app.reserve()).id, a.id);
  assert.equal(couponPosts(app).length, 1); assert.equal(app.tenant.coupons.length, 1); assert.equal(app.balance(), 400);
  await assert.rejects(app.cancel(a.id), { code: "MANUAL_REVIEW_REQUIRED" });
});

// ── Ambiguity, rejection and refunds ──────────────────────────────────────────

test("an ambiguous POST never produces a second POST, a refund or a duplicate coupon, whether or not the coupon is visible", async () => {
  for (const visible of [true, false]) {
    const app = harness();
    app.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/coupon", respond: (call) => { if (visible) app.tenant.coupons.push({ id: "native", ...call.body, appliesToObjectIds: "", availableToObjectIds: "", shippingDiscount: null, minimumCartAmount: null }); throw new Error("socket hang up secret@example.test"); } });
    const claim = await app.reserve(); const pending = await app.provision(claim.id);
    assert.equal(pending?.provisioningState, "MANUAL_REVIEW"); assert.equal(pending?.needsManualReview, true); assert.equal(pending?.couponCreateAttempted, true);
    await assert.rejects(app.cancel(claim.id), { code: "MANUAL_REVIEW_REQUIRED" });
    app.claims()[0].needsManualReview = false; app.claims()[0].providerLastCheckedAt = null;
    const recovered = await app.provision(claim.id);
    assert.equal(recovered?.status, visible ? "ISSUED" : "POINTS_DEBITED"); assert.equal(recovered?.provisioningState, visible ? "READY" : "MANUAL_REVIEW");
    assert.equal(couponPosts(app).length, 1, "never a second POST"); assert.equal(app.balance(), 400); assert.equal(app.ledger.size, 1);
    assert.doesNotMatch(JSON.stringify([recovered?.errorMessage, app.logs]), /secret@example|socket hang up/);
  }
});

test("a server error or timeout on POST is uncertain and keeps points reserved", async () => {
  for (const respond of [() => new Response("boom", { status: 502 }), () => new Response("", { status: 408 }), () => new Response("", { status: 409 })]) {
    const app = harness(); app.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/coupon", respond });
    const claim = await app.reserve(); const result = await app.provision(claim.id);
    assert.equal(result?.provisioningState, "MANUAL_REVIEW"); assert.equal(result?.status, "POINTS_DEBITED"); assert.equal(result?.couponCreateAttempted, true); assert.equal(app.balance(), 400);
    app.advance(); app.claims()[0].needsManualReview = false; await app.provision(claim.id); assert.equal(couponPosts(app).length, 1);
  }
});

test("a definitive provider rejection of the coupon refunds points exactly once and releases capacity", async () => {
  for (const status of [400, 422, 403]) {
    const app = harness(); app.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/coupon", respond: () => new Response("secret@example.test raw body", { status }) });
    const claim = await app.reserve(); const result = await app.provision(claim.id);
    assert.equal(result?.status, "REFUNDED"); assert.equal(result?.provisioningState, "FAILED_FINAL"); assert.equal(result?.slotReleased, true); assert.equal(result?.couponCreateAttempted, false);
    assert.equal(app.balance(), 500); assert.equal(app.offer().reservedClaimCount, 0); assert.deepEqual([...app.ledger.values()], ["SPEND", "REFUND"]);
    await app.provision(claim.id); await app.cancel(claim.id); assert.equal(app.balance(), 500); assert.equal(couponPosts(app).length, 1);
    assert.doesNotMatch(JSON.stringify([result?.errorMessage, app.logs]), /secret@example|raw body/);
  }
});

test("a rate limit on POST was refused before processing: the marker is cleared, points stay reserved and a retry posts once more", async () => {
  const app = harness(); let limited = true;
  app.tenant.failures.push({ when: (path, method) => limited && method === "POST" && path === "/v1/coupon", respond: () => new Response("", { status: 429 }) });
  const claim = await app.reserve(); const first = await app.provision(claim.id);
  assert.equal(first?.provisioningState, "FAILED_RETRYABLE"); assert.equal(first?.couponCreateAttempted, false); assert.equal(first?.needsManualReview, false); assert.equal(app.balance(), 400);
  assert.equal(first?.status, "POINTS_DEBITED"); assert.equal(app.tenant.coupons.length, 0);
  limited = false; app.advance();
  assert.equal((await app.provision(claim.id))?.status, "ISSUED"); assert.equal(couponPosts(app).length, 2); assert.equal(app.tenant.coupons.length, 1);
});

test("safe pre-POST cancellation refunds exactly once and a refunded claim is never issued", async () => {
  const app = harness(); const claim = await app.reserve();
  await app.cancel(claim.id); await app.cancel(claim.id);
  assert.equal(app.balance(), 500); assert.deepEqual([...app.ledger.values()], ["SPEND", "REFUND"]); assert.equal(app.offer().reservedClaimCount, 0);
  assert.equal((await app.provision(claim.id))?.status, "REFUNDED"); assert.equal(app.calls.length, 0);
});

test("an expired unissued claim is refunded without any provider call; an expired attempted claim goes to review", async () => {
  const app = harness(); const claim = await app.reserve(); app.advance(31 * 86400000);
  assert.equal((await app.provision(claim.id))?.status, "REFUNDED"); assert.equal(app.calls.length, 0); assert.equal(app.balance(), 500);
  const attempted = harness(); const second = await attempted.reserve(); attempted.claims()[0].couponCreateAttempted = true; attempted.advance(31 * 86400000);
  assert.equal((await attempted.provision(second.id))?.provisioningState, "MANUAL_REVIEW"); assert.equal(attempted.balance(), 400); assert.equal(attempted.calls.length, 0);
});

// ── Selected products ─────────────────────────────────────────────────────────

test("selected-product coupons issue under the production contract with the live-proven Product scope; a claimant-only selected offer stays unissuable", async () => {
  const app = harness({ appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-b", "wine-a"] });
  const claim = await app.reserve(); assert.equal((await app.provision(claim.id))?.status, "ISSUED");
  const [body] = app.postBodies(); assert.equal(body.appliesTo, "Product"); assert.deepEqual(body.appliesToObjectIds, ["wine-a", "wine-b"]); assert.equal(body.availableTo, "Everyone");
  const claimant = harness({ appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a"], mode: "CLAIMANT_ONLY", user: verifiedEmail });
  await assert.rejects(claimant.reserve(), { code: "COUPON_CONTRACT_UNVERIFIED" });
  assert.equal(claimant.claims().length, 0); assert.equal(claimant.balance(), 500); assert.equal(claimant.ledger.size, 0); assert.equal(claimant.offer().reservedClaimCount, 0); assert.equal(claimant.calls.length, 0);
});

test("with a proven product-scope enum the mapping is exact and ID-sorted, validated against the catalog at reservation", async () => {
  const app = harness({ appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-b", "wine-a"], contract: verifiedContract });
  const claim = await app.reserve(); assert.deepEqual((claim.rewardConfigSnapshot as Row).productIds, ["wine-a", "wine-b"]);
  assert.equal((await app.provision(claim.id))?.status, "ISSUED");
  const [body] = app.postBodies(); assert.equal(body.appliesTo, OPAQUE_PRODUCT_SCOPE); assert.deepEqual(body.appliesToObjectIds, ["wine-a", "wine-b"]); assert.equal(body.availableTo, "Everyone");
  const retired = harness({ appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a"], contract: verifiedContract }); retired.tables.connectedCommerceProduct.find((p) => p.externalId === "wine-a")!.isAvailable = false;
  await assert.rejects(retired.reserve(), { code: "PRODUCT_UNAVAILABLE" }); assert.equal(retired.balance(), 500);
});

// ── Claimant-only without a template ──────────────────────────────────────────

test("claimant-only needs no template: verified email, pinned customer, a unique claim tag and a tag-restricted single-use coupon", async () => {
  const tenant = fakeTenant({ customers: [alice, { id: "bob", email: "bob@example.test" }] });
  const app = harness({ mode: "CLAIMANT_ONLY", contract: verifiedContract, tenant, user: { email: null, isEmailVerified: false, emailVerifiedAt: null } });
  await assert.rejects(app.reserve(), { code: "EMAIL_VERIFICATION_REQUIRED" }); assert.equal(app.balance(), 500);
  Object.assign(app.tables.user[0], verifiedEmail);
  const claim = await app.reserve(); assert.equal(claim.provisioningState, "AWAITING_CUSTOMER"); assert.deepEqual((claim.rewardConfigSnapshot as Row).eligibilityMode, "CLAIMANT_ONLY");
  const waiting = await app.provision(claim.id);
  assert.equal(waiting?.provisioningState, "AWAITING_ELIGIBILITY"); assert.equal(waiting?.providerCustomerId, "alice"); assert.equal(waiting?.providerTagId, "tag-1");
  assert.equal(tenant.tags[0].title, claimTagTitle(claim.id)); assert.equal(couponPosts(app).length, 0);
  assert.ok(app.calls.every((call) => call.method === "GET" || call.path === "/v1/tag/customer"), "SQRATCH never writes customer membership");
  tenant.assignTag("alice", "tag-1"); app.advance();
  const issued = await app.provision(claim.id); assert.equal(issued?.status, "ISSUED");
  const [body] = app.postBodies();
  assert.equal(body.availableTo, OPAQUE_CUSTOMER_TAG); assert.deepEqual(body.availableToObjectIds, ["tag-1"]); assert.equal(body.usageLimit, 1); assert.equal(body.usageLimitType, "Per Store");
  assert.ok(app.calls.every((call) => !/\/coupon\/[^?]/.test(call.path)), "no template read");
});

test("claimant-only leaked-code protections: a shared tag blocks issuance and every claim gets its own tag", async () => {
  const tenant = fakeTenant({ customers: [alice, { id: "bob", email: "bob@example.test" }] });
  const app = harness({ mode: "CLAIMANT_ONLY", contract: verifiedContract, tenant, user: verifiedEmail });
  const claim = await app.reserve(); await app.provision(claim.id);
  tenant.assignTag("alice", "tag-1"); tenant.assignTag("bob", "tag-1"); app.advance();
  const blocked = await app.provision(claim.id);
  assert.equal(blocked?.status, "POINTS_DEBITED"); assert.equal(blocked?.provisioningState, "FAILED_RETRYABLE"); assert.equal(couponPosts(app).length, 0, "a tag shared with another customer never gets a coupon");
  const second = await app.reserve("another-request-key-0002"); await app.provision(second.id);
  assert.notEqual(second.id, claim.id); assert.equal(tenant.tags.length, 2); assert.notEqual(tenant.tags[0].title, tenant.tags[1].title); assert.notEqual(tenant.tags[0].id, tenant.tags[1].id);
});

test("claimant-only fails closed when the verified email changed or the native customer identity changed", async () => {
  const tenant = fakeTenant({ customers: [alice] });
  const app = harness({ mode: "CLAIMANT_ONLY", contract: verifiedContract, tenant, user: verifiedEmail });
  const claim = await app.reserve(); app.tables.user[0].emailVerifiedAt = new Date("2026-10-02");
  assert.match(String((await app.provision(claim.id))?.errorMessage), /verified email changed/); assert.equal(tenant.calls.length, 0);
});

test("without a proven customer-tag enum a template-free claimant claim is refused before any debit or provider call", async () => {
  const app = harness({ mode: "CLAIMANT_ONLY", user: verifiedEmail });
  await assert.rejects(app.reserve(), { code: "COUPON_CONTRACT_UNVERIFIED" }); assert.equal(app.balance(), 500); assert.equal(app.claims().length, 0); assert.equal(app.calls.length, 0);
});

// ── Legacy compatibility ──────────────────────────────────────────────────────

test("a legacy bearer offer issues from the contract and ignores its stored template entirely", async () => {
  const app = harness({ config: "LEGACY_TEMPLATE" }); app.offer().commerce7Config = { ...(app.offer().commerce7Config as Row), template: { not: "even valid" } };
  const claim = await app.reserve(); assert.ok(!("legacyTemplate" in (claim.rewardConfigSnapshot as Row)));
  assert.equal((await app.provision(claim.id))?.status, "ISSUED"); assert.ok(app.calls.every((call) => !call.path.includes("legacy-template")));
  assert.deepEqual([app.postBodies()[0].appliesTo, app.postBodies()[0].availableTo], ["Store", "Everyone"]);
});

test("a legacy claimant-only offer still issues with the merchant template's observed native enum, with the same security flow", async () => {
  const tenant = fakeTenant({ customers: [alice] });
  const app = harness({ mode: "CLAIMANT_ONLY", config: "LEGACY_TEMPLATE", tenant, user: verifiedEmail });
  const claim = await app.reserve(); assert.equal((claim.rewardConfigSnapshot as Row & { legacyTemplate: Row }).legacyTemplate.availableTo, "legacy-customer-tag");
  await app.provision(claim.id); tenant.assignTag("alice", "tag-1"); app.advance();
  assert.equal((await app.provision(claim.id))?.status, "ISSUED");
  const [body] = app.postBodies(); assert.equal(body.availableTo, "legacy-customer-tag"); assert.deepEqual(body.availableToObjectIds, ["tag-1"]);
  assert.ok(app.calls.every((call) => !call.path.includes("legacy-template")), "the template is never read");
});

test("a pending claim whose coupon already exists is recovered by exact code instead of posting again, from either read representation only when proven", async () => {
  const code = `SQRA${"B".repeat(32)}`; const created = new Date("2026-10-10T00:00:12.345Z");
  const historicClaim = { id: "historic", userId: "user", brandId: "brand", offerId: "offer", provider: "COMMERCE7", connectionId: "connection", externalAccountId: "synthetic-tenant", rewardMode: "DISCOUNT", status: "POINTS_DEBITED", provisioningState: "FAILED_RETRYABLE", code, createdAt: created, expiresAt: new Date("2026-11-09T00:00:12.345Z"), pointsCost: 100, discountType: "FIXED_AMOUNT", discountAmountCents: 1000, discountPercentageBasisPoints: null, currencyCode: "CAD", couponCreateAttempted: true, tagCreateAttempted: false, entitlementEverGranted: false, needsManualReview: false, provisioningOwner: null, providerLastCheckedAt: null, providerCustomerId: null, providerTagId: null, slotReleased: false, reconcileAttempts: 1, externalDiscountId: null, canonicalOrderId: null, usedAt: null,
    rewardConfigSnapshot: { templateCouponId: "legacy-template", template: legacyTemplate("ANYONE_WITH_CODE"), eligibilityMode: "ANYONE_WITH_CODE", title: "Old title", minimumSubtotalCents: null } };
  const common = { code, title: "Old title", type: "Product", usageLimitType: "Per Store", usageLimit: 1, appliesTo: "Store", appliesToObjectIds: "", status: "Enabled", availableTo: "Everyone", availableToObjectIds: "", startDate: created.toISOString(), endDate: "2026-11-09T00:00:12.345Z" };
  // Current read representation (as the create echo reports it): proven, so the existing coupon is adopted with no POST.
  const current = harness(); current.tables.commerceRewardRedemption.push(structuredClone(historicClaim));
  current.tenant.coupons.push({ id: "native-existing", ...common, discountType: "Dollar Off", discount: 1000, dollarOffDiscountApplies: "Once Per Order", cartRequirementType: "None" });
  const recovered = await current.provision("historic");
  assert.equal(recovered?.status, "ISSUED"); assert.equal(recovered?.externalDiscountId, "native-existing"); assert.equal(couponPosts(current).length, 0);
  // Historical read fields with no once-per-order report cannot prove a dollar-off coupon's terms: review, never re-post or refund.
  const historical = harness(); historical.tables.commerceRewardRedemption.push(structuredClone(historicClaim));
  historical.tenant.coupons.push({ id: "native-existing", ...common, type: undefined, productDiscountType: "Dollar Off", productDiscount: 1000, shippingDiscountType: "No Discount", shippingDiscount: null, minimumCartAmount: null });
  const reviewed = await historical.provision("historic");
  assert.equal(reviewed?.provisioningState, "MANUAL_REVIEW"); assert.equal(reviewed?.status, "POINTS_DEBITED"); assert.equal(couponPosts(historical).length, 0); assert.equal(historical.balance(), 500);
});

test("a historical claim whose frozen terms disagree with its columns goes to review instead of issuing", async () => {
  const app = harness(); const claim = await app.reserve();
  app.claims()[0].discountAmountCents = 5000;
  const result = await app.provision(claim.id);
  assert.equal(result?.provisioningState, "MANUAL_REVIEW"); assert.equal(result?.needsManualReview, true); assert.equal(app.calls.length, 0); assert.equal(app.balance(), 400);
});

// ── Tenant and Brand isolation ────────────────────────────────────────────────

test("claims are bound to their Brand, user and original connection; foreign callers cannot reach the provider", async () => {
  const app = harness();
  await assert.rejects(app.reserve("synthetic-request-key", "user", ["other-brand"]), { code: "NOT_FOUND" });
  const claim = await app.reserve(); assert.equal(await app.provision(claim.id, "other-user"), null); assert.equal(app.calls.length, 0);
  app.tables.commerceConnection[0].externalAccountId = "different-tenant";
  const moved = await app.provision(claim.id); assert.equal(moved?.provisioningState, "FAILED_RETRYABLE"); assert.equal(app.calls.length, 0);
  app.tables.commerceConnection[0].externalAccountId = "synthetic-tenant"; app.tables.commerceConnection[0].status = "DISCONNECTED"; app.advance();
  await app.provision(claim.id); assert.equal(app.calls.length, 0);
});

test("exclusive access activates only after live Tag and Product reads; an unconfigured exclusive offer is refused before any debit", async () => {
  const tenant = fakeTenant({ tags: [{ id: "synthetic-customer-tag-id", title: "Rare Wine Members" }], products: [{ id: "wine-a", security: { availableTo: "Tag", availableToObjectIds: ["synthetic-customer-tag-id"] } }] });
  const app = harness({ tenant }); secureForExclusive(app, "wine-a");
  const exclusive = { ...offerBody, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", discountEnabled: false, productIds: ["wine-a"], maxTotalRedemptions: 25 };
  assert.equal((await app.save({ ...exclusive, isActive: false })).rewardMode, "EXCLUSIVE_PRODUCT_ACCESS");
  assert.equal((await app.save({ ...exclusive, isActive: true })).isActive, true);
  assert.ok(app.calls.every((call) => call.method === "GET"), "saving never writes");
  Object.assign(app.offer(), { rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", isActive: true }); // no frozen exclusive configuration
  await assert.rejects(app.reserve(), { code: "INVALID_OFFER" }); assert.equal(app.balance(), 500); assert.equal(app.claims().length, 0);
});

// ── Diagnostics ───────────────────────────────────────────────────────────────

test("failure diagnostics are a closed vocabulary with no coupon code, email, body, header or tenant credential", async () => {
  const allowed = new Set(["event", "stage", "code", "uncertain", "provider", "connectionId", "claimId"]);
  const cases: [string, (app: ReturnType<typeof harness>) => void][] = [
    ["COUPON_CREATE", (app) => app.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/coupon", respond: () => new Response("secret@example.test Authorization: Basic abc", { status: 422 }) })],
    ["COUPON_RECOVERY", (app) => app.tenant.failures.push({ when: (path, method) => method === "GET" && path.startsWith("/v1/coupon"), respond: () => new Response("secret@example.test", { status: 503 }) })],
  ];
  for (const [stage, arm] of cases) {
    const app = harness(); arm(app); const claim = await app.reserve(); const result = await app.provision(claim.id);
    assert.equal(app.logs.length, 1); const log = app.logs[0] as Row;
    assert.ok(Object.keys(log).every((key) => allowed.has(key)), JSON.stringify(Object.keys(log))); assert.equal(log.event, "commerce7_reward_provisioning_failed"); assert.equal(log.stage, stage); assert.equal(log.provider, "COMMERCE7");
    assert.match(String(app.claims()[0].lastReconcileReason ?? result?.lastReconcileReason), new RegExp(`^${stage}:[A-Z_]+$`));
    assert.doesNotMatch(JSON.stringify([log, result?.errorMessage, result?.lastReconcileReason]), new RegExp(`secret@example|Authorization|Basic|synthetic-test-secret|${claim.code}|alice@`));
  }
});

test("the removed template stages and messages can no longer be produced by any offer save", async () => {
  for (const status of [404, 403, 429, 503]) {
    const app = harness({ transport: async () => new Response("secret@example.test raw body", { status }) });
    const saved = await app.save(); assert.ok(saved); assert.equal(app.calls.length, 0); assert.equal(app.logs.length, 0);
  }
});
