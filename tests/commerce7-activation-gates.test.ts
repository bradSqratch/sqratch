import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMERCE7_COUPON_CONTRACT, commerce7CouponSupport, type CouponContract } from "../src/lib/commerce7-coupon-contract";
import { COMMERCE7_ACTIVATION_BLOCKER_TEXT, commerce7CouponBlockers } from "../src/lib/commerce7-activation";
import { buildRewardSnapshot, commerce7OfferEligibility, commerce7SnapshotIssuable } from "../src/lib/commerce7-reward-domain";
import { fakeTenant, harness, offerBody, verifiedContract, verifiedEmail, type Harness, type Row } from "./commerce7-reward-harness";

/**
 * Activation gates are provable, not just present: each unverified capability (percentage units, a customer-bound native
 * coupon, one-tag access to a multi-tag product) has a distinct reason, is enforced by every server path an API caller can
 * reach, and switches on through the contract alone once evidence sets it. Stored Active/Inactive is never rewritten by a
 * gate; current claim eligibility is reported beside it.
 */
const percentVerified: CouponContract = { ...COMMERCE7_COUPON_CONTRACT, percentage: { ...COMMERCE7_COUPON_CONTRACT.percentage, verified: true } };
const percentOffer = { discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1500 };
const rejectsWith = (code: string, pattern: RegExp) => (error: { code: string; message: string }) => error.code === code && pattern.test(error.message);

test("discount blockers: a legacy claimant-only discount is retired; an unverified percentage is a separate reason; exclusive is unaffected", () => {
  const gated = commerce7CouponSupport();
  const options = (overrides: object = {}) => ({ rewardMode: "DISCOUNT" as const, eligibilityMode: "ANYONE_WITH_CODE" as const, appliesTo: "ALL_PRODUCTS" as const, discountEnabled: true, discountType: "FIXED_AMOUNT" as const, ...overrides });
  assert.deepEqual(commerce7CouponBlockers(options(), gated), []);
  assert.deepEqual(commerce7CouponBlockers(options({ discountType: "PERCENTAGE" }), gated), ["PERCENTAGE_UNVERIFIED"]);
  assert.deepEqual(commerce7CouponBlockers(options({ eligibilityMode: "CLAIMANT_ONLY" }), gated), ["CLAIMANT_DISCOUNT_RETIRED"]);
  assert.deepEqual(commerce7CouponBlockers(options({ eligibilityMode: "CLAIMANT_ONLY" }), commerce7CouponSupport(verifiedContract)), ["CLAIMANT_DISCOUNT_RETIRED"], "even a proven customer-tag enum");
  // Exclusive access binds the customer through the tag grant, never through a coupon restriction.
  assert.deepEqual(commerce7CouponBlockers(options({ rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", eligibilityMode: "CLAIMANT_ONLY", appliesTo: "SPECIFIC_PRODUCTS", discountEnabled: false }), gated), []);
  assert.deepEqual(commerce7CouponBlockers(options({ rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", eligibilityMode: "CLAIMANT_ONLY", appliesTo: "SPECIFIC_PRODUCTS", discountType: "PERCENTAGE" }), gated), ["PERCENTAGE_UNVERIFIED"]);
  assert.deepEqual(commerce7CouponBlockers(options({ discountType: "PERCENTAGE" }), commerce7CouponSupport(percentVerified)), [], "verified percentage goes live");
  // A server payload without the discount matrix (older deployment) fails closed.
  assert.deepEqual(commerce7CouponBlockers(options({ discountType: "PERCENTAGE" }), { eligibility: gated.eligibility, scope: gated.scope }), ["PERCENTAGE_UNVERIFIED"]);
  assert.match(COMMERCE7_ACTIVATION_BLOCKER_TEXT.CLAIMANT_DISCOUNT_RETIRED, /no longer offered for discounts/);
  assert.match(COMMERCE7_ACTIVATION_BLOCKER_TEXT.PERCENTAGE_UNVERIFIED, /1500 shows as 15%/);
  for (const text of Object.values(COMMERCE7_ACTIVATION_BLOCKER_TEXT)) assert.doesNotMatch(text, /availableTo|appliesTo|discountType|enum/, "plain words only");
});
test("the offer badge and the server agree: no blockers exactly when the claim snapshot is issuable, for every combination", () => {
  const contracts = [COMMERCE7_COUPON_CONTRACT, percentVerified, verifiedContract, { ...verifiedContract, percentage: { ...verifiedContract.percentage, verified: true } }];
  for (const contract of contracts) for (const eligibilityMode of ["ANYONE_WITH_CODE"]) for (const appliesTo of ["ALL_PRODUCTS", "SPECIFIC_PRODUCTS"]) for (const discountType of ["FIXED_AMOUNT", "PERCENTAGE"]) {
    const offer = { ...offerBody, isActive: true, reservedClaimCount: 0, claimStartsAt: null, claimEndsAt: null, rewardMode: "DISCOUNT", appliesTo, discountType, discountAmountCents: discountType === "FIXED_AMOUNT" ? 1000 : null, discountPercentageBasisPoints: discountType === "PERCENTAGE" ? 1500 : null, commerce7Config: { eligibilityMode, discountEnabled: true } } as never;
    const productIds = appliesTo === "SPECIFIC_PRODUCTS" ? ["wine-a"] : [];
    const issuable = commerce7SnapshotIssuable(buildRewardSnapshot(offer, { eligibilityMode, discountEnabled: true }, productIds, contract), contract);
    const eligibility = commerce7OfferEligibility(offer, { productIds, exclusiveProduct: null, contract });
    assert.equal(eligibility.blockers.length === 0, issuable, `${eligibilityMode}/${appliesTo}/${discountType}/${contract.percentage.verified}`);
    assert.equal(eligibility.state, issuable ? "READY" : "BLOCKED");
    const claimant = commerce7OfferEligibility({ ...(offer as object), commerce7Config: { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: true } } as never, { productIds, exclusiveProduct: null, contract });
    assert.equal(claimant.state, "BLOCKED"); assert.ok(claimant.blockers.includes("CLAIMANT_DISCOUNT_RETIRED"), "a legacy claimant discount is never shown as open");
  }
});

test("Percentage + Anyone with the code: refused on save and Enable while unverified, live immediately once verified", async () => {
  const gated = harness();
  await assert.rejects(gated.save({ ...offerBody, ...percentOffer, eligibilityMode: "ANYONE_WITH_CODE", isActive: true }), rejectsWith("COUPON_CONTRACT_UNVERIFIED", /percentage units are verified/));
  const verified = harness({ contract: percentVerified });
  // Edit the harness's claimable offer in place, so the claim below uses exactly the saved terms.
  const saved = await verified.save({ ...offerBody, ...percentOffer, eligibilityMode: "ANYONE_WITH_CODE", isActive: true }, "offer");
  assert.equal(saved.isActive, true); assert.equal(saved.discountPercentageBasisPoints, 1500);
  const claim = await verified.reserve(); await verified.provision(String(claim.id));
  assert.equal(verified.claims()[0].status, "ISSUED"); assert.equal(verified.postBodies()[0].discount, 1500, "15% is written as the native 1500");
});

test("a saved percentage draft, and a formerly active offer paused by the gate, enable only once percentage units are verified", async () => {
  for (const contract of [undefined, percentVerified]) {
    const draft = harness({ offer: { ...percentOffer, isActive: false }, ...(contract ? { contract } : {}) });
    if (!contract) { await assert.rejects(draft.setActive("ENABLE"), rejectsWith("COUPON_CONTRACT_UNVERIFIED", /percentage/i)); assert.equal(draft.offer().isActive, false); }
    else assert.equal((await draft.setActive("ENABLE")).isActive, true);
    // Created active before the gate existed: stays Active (never silently disabled), refuses claims, and after Disable can be
    // re-enabled only when verified.
    const paused = harness({ offer: percentOffer, ...(contract ? { contract } : {}) });
    assert.equal(paused.offer().isActive, true); assert.deepEqual(paused.offerWrites, []);
    assert.equal((await paused.setActive("DISABLE")).isActive, false);
    if (!contract) { await assert.rejects(paused.setActive("ENABLE"), { code: "COUPON_CONTRACT_UNVERIFIED" }); assert.equal(paused.offer().isActive, false); }
    else assert.equal((await paused.setActive("ENABLE")).isActive, true);
    assert.deepEqual([...draft.calls, ...paused.calls].filter((call) => call.method !== "GET"), [], "enabling never writes to Commerce7");
  }
});

test("API bypass: a direct claimant-only discount save or Enable is refused server-side with no write; an unverified percentage too", async () => {
  const both = harness();
  await assert.rejects(both.save({ ...offerBody, ...percentOffer, eligibilityMode: "CLAIMANT_ONLY", isActive: true }), { code: "CLAIMANT_DISCOUNT_RETIRED" });
  await assert.rejects(both.save({ ...offerBody, ...percentOffer, isActive: true }), rejectsWith("COUPON_CONTRACT_UNVERIFIED", /percentage/i));
  assert.equal(both.offerWrites.length, 0);
  // A stored claimant-only row cannot be enabled, even under a contract with a proven customer-tag value.
  for (const contract of [undefined, verifiedContract]) {
    const stored = harness({ mode: "CLAIMANT_ONLY", user: verifiedEmail, offer: { isActive: false }, ...(contract ? { contract } : {}) });
    await assert.rejects(stored.setActive("ENABLE"), rejectsWith("CLAIMANT_DISCOUNT_RETIRED", /confirm Anyone with the code/)); assert.equal(stored.offer().isActive, false); assert.deepEqual(stored.calls, []);
  }
  // Under the production contract an (already active) claimant-only row still refuses claims before any debit.
  const active = harness({ mode: "CLAIMANT_ONLY", user: verifiedEmail });
  await assert.rejects(active.reserve(), { code: "COUPON_CONTRACT_UNVERIFIED" });
  assert.equal(active.claims().length, 0); assert.equal(active.ledger.size, 0); assert.deepEqual(active.calls, []);
});
// ── Multi-tag drift on an already-active exclusive offer ──────────────────────────
const TAG = "00000000-0000-4000-8000-0000000000a1"; const EMPLOYEE = "00000000-0000-4000-8000-0000000000a2"; const INVESTOR = "00000000-0000-4000-8000-0000000000a3";
const PRODUCT = "wine-a"; // the harness's synchronized catalog row standing in for Rare - 2015 Chardonnay
const security = (ids: string[]) => ({ availableTo: "Tag", displayOption: "Display Product / Show Login", availableToObjectIds: ids });
function exclusiveApp(options: { customersFirst?: { id: string; email: string; tagIds?: string[] }[] } = {}): Harness {
  const tenant = fakeTenant({
    customers: options.customersFirst ?? [{ id: "c7-alice", email: "alice@example.test" }, { id: "c7-bob", email: "bob@example.test" }],
    tags: [{ id: TAG, title: "SQRATCH Rare Wine Test" }, { id: EMPLOYEE, title: "Employee" }, { id: INVESTOR, title: "Investor" }],
    products: [{ id: PRODUCT, security: security([TAG]) }],
  });
  const app = harness({ tenant, appliesTo: "SPECIFIC_PRODUCTS", productIds: [PRODUCT], user: verifiedEmail, offer: {
    rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", maxTotalRedemptions: 25, maxRedemptionsPerUser: 2, discountType: "FIXED_AMOUNT", discountAmountCents: null, minimumSubtotalCents: null,
    commerce7Config: { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: false, exclusiveAccess: { productId: PRODUCT, securityAvailableTo: "Tag", securityTagId: TAG, tagTitle: "SQRATCH Rare Wine Test" } },
  } });
  app.tables.connectedCommerceProduct.find((row) => row.externalId === PRODUCT)!.providerMetadata = { security: security([TAG]) };
  return app;
}
const eligibilityOf = (app: Harness) => commerce7OfferEligibility(app.offer() as never, { productIds: [PRODUCT], exclusiveProduct: app.tables.connectedCommerceProduct.find((row) => row.externalId === PRODUCT) as never });

test("multi-tag OR access (verified): an Active offer whose product gains two more tags stays claimable; existing access is untouched", async () => {
  const app = exclusiveApp();
  const granted = await app.claim(); assert.equal(granted.alreadyEligible, false); assert.equal(app.claims()[0].status, "ISSUED");
  const issued = structuredClone(app.claims()[0]);
  // The winery later secures the same product to two more Manual Customer Tags; product sync records all three.
  app.tenant.products[0].security = security([TAG, EMPLOYEE, INVESTOR]);
  app.tables.connectedCommerceProduct.find((row) => row.externalId === PRODUCT)!.providerMetadata = { security: security([TAG, EMPLOYEE, INVESTOR]) };
  assert.deepEqual(eligibilityOf(app), { state: "READY", blockers: [] }, "no longer paused");
  await app.reconcile();
  assert.deepEqual(JSON.parse(JSON.stringify(app.claims()[0])), JSON.parse(JSON.stringify(issued)), "the granted claim is untouched");
  assert.deepEqual(app.calls.filter((call) => call.method === "DELETE"), [], "SQRATCH never revokes a membership");
  assert.deepEqual(app.tenant.products[0].security, security([TAG, EMPLOYEE, INVESTOR]), "product security is never written");
  // The same customer already holds the granted tag: an access-only re-claim charges nothing.
  const again = await app.claim("second-request-key-0001"); assert.equal(again.alreadyEligible, true); assert.equal(app.claims().length, 1);
});

test("access-only: a customer who can already buy through ANY of the product's security tags is not charged and gets no grant", async () => {
  const app = exclusiveApp(); app.tenant.customers[0].tagIds.push(EMPLOYEE);
  app.tenant.products[0].security = security([TAG, EMPLOYEE, INVESTOR]);
  app.tables.connectedCommerceProduct.find((row) => row.externalId === PRODUCT)!.providerMetadata = { security: security([TAG, EMPLOYEE, INVESTOR]) };
  const result = await app.claim();
  assert.equal(result.alreadyEligible, true); assert.equal(app.claims().length, 0); assert.equal(app.ledger.size, 0, "no points spent");
  assert.deepEqual(app.calls.filter((call) => call.method !== "GET"), [], "no tag granted"); assert.deepEqual(app.tenant.customers[0].tagIds, [EMPLOYEE]);
  // A customer holding an unrelated tag (not on this product) still needs the grant.
  const unrelated = exclusiveApp(); unrelated.tenant.customers[0].tagIds.push(EMPLOYEE);
  const claimed = await unrelated.claim(); assert.equal(claimed.alreadyEligible, false); assert.equal(unrelated.claims()[0].status, "ISSUED");
  assert.deepEqual(unrelated.tenant.customers[0].tagIds, [EMPLOYEE, TAG], "exactly one selected tag granted");
});

test("access-only: if access via another product tag appears before provisioning, the claim is refunded without a grant", async () => {
  const app = exclusiveApp({ customersFirst: [] });
  await app.claim(); assert.equal(app.claims()[0].provisioningState, "AWAITING_CUSTOMER");
  app.tenant.customers.push({ id: "c7-alice", email: "alice@example.test", tagIds: [INVESTOR] });
  app.tenant.products[0].security = security([TAG, INVESTOR]);
  app.tables.connectedCommerceProduct.find((row) => row.externalId === PRODUCT)!.providerMetadata = { security: security([TAG, INVESTOR]) };
  app.advance(10 * 60000); await app.provision(String(app.claims()[0].id));
  assert.equal(app.claims()[0].status, "REFUNDED"); assert.equal(app.claims()[0].membershipOwnership, "PRE_EXISTING"); assert.equal(app.balance(), 500);
  assert.deepEqual(app.calls.filter((call) => call.method !== "GET"), [], "no tag granted");
});

test("stored state and eligibility are separate: schedule and capacity states never hide a blocker", () => {
  const base = { ...offerBody, isActive: true, reservedClaimCount: 0, claimStartsAt: null, claimEndsAt: null, rewardMode: "DISCOUNT", discountPercentageBasisPoints: null, commerce7Config: { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true } };
  const now = new Date("2026-10-08T12:00:00.000Z");
  const state = (overrides: Row) => commerce7OfferEligibility({ ...base, ...overrides } as never, { productIds: [], exclusiveProduct: null, now }).state;
  assert.equal(state({}), "READY");
  assert.equal(state({ claimStartsAt: new Date("2026-10-09T00:00:00.000Z") }), "NOT_STARTED");
  assert.equal(state({ claimEndsAt: new Date("2026-10-08T00:00:00.000Z") }), "ENDED");
  assert.equal(state({ reservedClaimCount: 25 }), "SOLD_OUT");
  assert.equal(state({ isActive: false }), "INACTIVE");
  assert.equal(state({ ...percentOffer, reservedClaimCount: 25 }), "BLOCKED", "a blocker outranks schedule and capacity");
  assert.equal(state({ commerce7Config: { eligibilityMode: "UNKNOWN_MODE" } }), "BLOCKED");
});
