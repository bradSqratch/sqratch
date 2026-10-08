import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import * as domain from "../src/lib/commerce7-reward-domain";
import { Commerce7RewardsClient, customerTagCount } from "../src/lib/commerce/providers/commerce7-rewards-client";
import { fakeTenant, harness, offerBody, verifiedEmail, type FakeTag, type Harness, type Row } from "./commerce7-reward-harness";

/**
 * Exclusive Wine Access, end to end through the actual saga, against a stateful fake tenant whose membership behavior follows
 * the live sandbox evidence (201 grant that is NOT idempotent, duplicate memberships, a 204 DELETE that clears every copy).
 * IDs are the synthetic stand-ins used by the sanitized fixtures; no response here is presented as a live provider body
 * unless it is read from tests/fixtures/commerce7-rewards.
 */
const membershipEvidence = JSON.parse(readFileSync(new URL("./fixtures/commerce7-rewards/live-customer-tag-membership.json", import.meta.url), "utf8"));
const TAG: string = membershipEvidence.grant.request.body.tagId;
const CUSTOMER: string = membershipEvidence.grant.request.body.objectId;
const OTHER_TAG = "00000000-0000-4000-8000-0000000000b2"; const THIRD_TAG = "00000000-0000-4000-8000-0000000000b3";
const PRODUCT = "wine-a";
const security = (ids: string[], availableTo = "Tag") => ({ availableTo, displayOption: "Display Product / Show Login", availableToObjectIds: ids });
const tenantTags: FakeTag[] = [
  { id: TAG, title: "SQRATCH Rare Wine Test", type: "Manual", objectType: "Customer" },
  { id: OTHER_TAG, title: "Library Wine Members", type: "Manual", objectType: "Customer" },
  { id: THIRD_TAG, title: "Winemaker Dinner Guests", type: "Manual", objectType: "Customer" },
];
type Options = { discount?: boolean; tags?: string[]; customerTags?: string[]; customers?: { id: string; email: string; tagIds?: string[] }[]; multiTag?: boolean; tags_?: FakeTag[]; liveProduct?: Row; user?: Row; offer?: Row };
function exclusiveApp(options: Options = {}) {
  const securityTags = options.tags ?? [TAG];
  const tenant = fakeTenant({
    customers: options.customers ?? [{ id: CUSTOMER, email: "alice@example.test", tagIds: options.customerTags ?? [] }],
    tags: options.tags_ ?? tenantTags,
    products: [{ id: PRODUCT, security: security(securityTags), ...options.liveProduct }],
  });
  const discount = options.discount ?? false;
  const app = harness({
    tenant, appliesTo: "SPECIFIC_PRODUCTS", productIds: [PRODUCT], user: options.user ?? verifiedEmail, multiTagAccessVerified: options.multiTag,
    offer: {
      rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", maxTotalRedemptions: 25, maxRedemptionsPerUser: 2, discountType: "FIXED_AMOUNT", discountAmountCents: discount ? 1500 : null, minimumSubtotalCents: null,
      commerce7Config: { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: discount, exclusiveAccess: { productId: PRODUCT, securityAvailableTo: "Tag", securityTagId: TAG, tagTitle: "SQRATCH Rare Wine Test" } },
      ...options.offer,
    },
  });
  app.tables.connectedCommerceProduct.find((p) => p.externalId === PRODUCT)!.providerMetadata = { security: security(securityTags) };
  return app;
}
const grants = (app: Harness) => app.calls.filter((call) => call.method === "POST" && call.path === "/v1/tag-x-object/customer");
const writes = (app: Harness) => app.calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);
const view = (row: Row) => domain.serializeCommerce7Claim(row as never);
/** Objects built inside the VM-run saga have another realm's prototype; compare their JSON. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
/** What the Brand "Check provider result" action does: clear the review flag (never the attempt markers) and provision. */
async function brandCheck(app: Harness, claim: Row) { Object.assign(app.claims().find((row) => row.id === claim.id)!, { needsManualReview: false, providerLastCheckedAt: null }); return app.provision(String(claim.id)); }
const failGrant = (app: Harness, respond: (call: { body: Row | null }) => Response | Promise<Response>) => app.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/tag-x-object/customer", respond });

// ── The live evidence, reproduced by the fake tenant ─────────────────────────────

test("the fake tenant reproduces the live membership evidence: 201 grant, duplicate on a second POST, and a 204 DELETE clearing every copy", async () => {
  const tenant = fakeTenant({ customers: [{ id: CUSTOMER, email: "alice@example.test", tagIds: [TAG] }], tags: tenantTags });
  const post = () => tenant.fetcher("https://api.commerce7.com/v1/tag-x-object/customer", { method: "POST", body: JSON.stringify(membershipEvidence.grant.request.body) });
  const response = await post(); assert.equal(response.status, membershipEvidence.grant.status);
  const body = await response.json(); assert.deepEqual(Object.keys(body).sort(), Object.keys(membershipEvidence.grant.response).sort(), "same 201 field set as the live response");
  process.env.COMMERCE7_APP_ID = "synthetic-test-app"; process.env.COMMERCE7_APP_SECRET = "synthetic-test-secret";
  const client = new Commerce7RewardsClient("synthetic-tenant", tenant.fetcher);
  assert.equal(customerTagCount(await client.customerById(CUSTOMER), TAG), membershipEvidence.customerGetAfterGrant.tags.length, "the pre-existing tag is now listed twice");
  const removed = await tenant.fetcher(`https://api.commerce7.com/v1${membershipEvidence.removal.request.path.replace("/v1", "")}`, { method: "DELETE" });
  assert.equal(removed.status, membershipEvidence.removal.status);
  assert.equal(customerTagCount(await client.customerById(CUSTOMER), TAG), membershipEvidence.customerGetAfterRemoval.tags.length, "DELETE removed both memberships");
});

test("the client parses the live customer tag entry, the tag definition, the 201 relation, and refuses a mismatched echo as ambiguous", async () => {
  process.env.COMMERCE7_APP_ID = "synthetic-test-app"; process.env.COMMERCE7_APP_SECRET = "synthetic-test-secret";
  const live = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
  const customer = await new Commerce7RewardsClient("synthetic-tenant", live({ id: CUSTOMER, emails: [{ email: "alice@example.test" }], tags: membershipEvidence.customerGetAfterGrant.tags })).customerById(CUSTOMER);
  assert.equal(customerTagCount(customer, TAG), 2);
  assert.deepEqual(await new Commerce7RewardsClient("synthetic-tenant", live({ ...tenantTags[0], appliesToCondition: null })).customerTag(TAG), { id: TAG, title: "SQRATCH Rare Wine Test", type: "Manual", objectType: "Customer" });
  assert.equal(await new Commerce7RewardsClient("synthetic-tenant", (async () => new Response(null, { status: 404 })) as unknown as typeof fetch).customerTag(TAG), null, "a deleted tag reads as absent");
  assert.deepEqual(await new Commerce7RewardsClient("synthetic-tenant", live(membershipEvidence.grant.response, 201)).assignCustomerTag(CUSTOMER, TAG), { id: membershipEvidence.grant.response.id });
  for (const echo of [{ ...membershipEvidence.grant.response, tagId: OTHER_TAG }, { ...membershipEvidence.grant.response, objectId: "someone-else" }, { ...membershipEvidence.grant.response, id: "" }, null]) {
    await assert.rejects(new Commerce7RewardsClient("synthetic-tenant", live(echo, 201)).assignCustomerTag(CUSTOMER, TAG), (error: { code: string; uncertain: boolean }) => error.code === "INVALID_PROVIDER_RESPONSE" && error.uncertain === true);
  }
  const product = await new Commerce7RewardsClient("synthetic-tenant", live({ id: PRODUCT, webStatus: "Available", adminStatus: "Available", security: security([TAG, OTHER_TAG]) })).productAccess(PRODUCT);
  assert.deepEqual(product, { id: PRODUCT, available: true, security: security([TAG, OTHER_TAG]) });
});

// ── Successful claims ───────────────────────────────────────────────────────────

test("access-only: verified absence, exactly one membership POST, a fresh GET confirms it, then READY with no coupon or code", async () => {
  const app = exclusiveApp();
  const result = await app.claim();
  assert.equal(result.alreadyEligible, false);
  const claim = app.claims()[0];
  assert.equal(claim.status, "ISSUED"); assert.equal(claim.provisioningState, "READY");
  assert.equal(claim.membershipOwnership, "SQRATCH_GRANTED"); assert.equal(claim.providerMembershipId, "membership-1"); assert.equal(claim.entitlementEverGranted, true);
  assert.equal(claim.externalDiscountId, null); assert.equal(claim.providerCustomerId, CUSTOMER); assert.equal(claim.providerTagId, TAG);
  assert.deepEqual(grants(app).map((call) => call.body), [{ objectId: CUSTOMER, tagId: TAG }]);
  assert.deepEqual(writes(app), ["POST /v1/tag-x-object/customer"], "no coupon, no product write, no deletion");
  const last = app.calls.at(-1)!; assert.equal(`${last.method} ${last.path}`, `GET /v1/customer/${CUSTOMER}`, "the grant is confirmed by a fresh customer read");
  assert.deepEqual(app.tenant.customers[0].tagIds, [TAG]);
  assert.equal(app.balance(), 400); assert.equal(app.ledger.size, 1); assert.equal(app.offer().reservedClaimCount, 1);
  const dto = view(claim);
  assert.equal(dto.code, null, "an access-only claim never reveals its internal code"); assert.equal(dto.expiresAt, null); assert.equal(dto.accessState, "ACCESS_GRANTED"); assert.equal(dto.accessGranted, true); assert.equal(dto.canCancel, false);
  assert.ok(app.clientTenants.every((tenant) => tenant === "synthetic-tenant"), "every provider client is bound to the offer's original tenant");
});

test("with an optional discount: the tag is granted first, then one single-use coupon scoped to the exclusive product", async () => {
  const app = exclusiveApp({ discount: true });
  await app.claim();
  assert.deepEqual(writes(app), ["POST /v1/tag-x-object/customer", "POST /v1/coupon"]);
  const [coupon] = app.postBodies();
  assert.equal(coupon.appliesTo, "Product"); assert.deepEqual(coupon.appliesToObjectIds, [PRODUCT]);
  assert.equal(coupon.availableTo, "Everyone"); assert.equal(coupon.availableToObjectIds, undefined, "the unverified customer-tag coupon value is never sent");
  assert.equal(coupon.discountType, "Dollar Off"); assert.equal(coupon.discount, 1500); assert.equal(coupon.usageLimitType, "Per Store"); assert.equal(coupon.usageLimit, 1);
  const claim = app.claims()[0];
  assert.equal(claim.status, "ISSUED"); assert.equal(claim.membershipOwnership, "SQRATCH_GRANTED"); assert.equal(claim.externalDiscountId, "coupon-1");
  assert.equal(view(claim).code, claim.code); assert.equal(app.balance(), 400);
});

// ── Already eligible: never charged for access, never owned ─────────────────────

test("a customer who already holds the tag is not charged for an access-only reward and no claim is created", async () => {
  const app = exclusiveApp({ customerTags: [TAG] });
  assert.deepEqual(plain(await app.claim()), { alreadyEligible: true, claim: null });
  assert.equal(app.claims().length, 0); assert.equal(app.ledger.size, 0); assert.equal(app.balance(), 500); assert.equal(app.offer().reservedClaimCount, 0);
  assert.deepEqual(writes(app), []);
});

test("duplicate native memberships still count as already eligible, and SQRATCH never adds another", async () => {
  const app = exclusiveApp({ customerTags: [TAG, TAG] });
  assert.equal((await app.claim()).alreadyEligible, true); assert.deepEqual(writes(app), []); assert.deepEqual(app.tenant.customers[0].tagIds, [TAG, TAG]);
});

test("if the tag appears natively between the pre-check and the grant, the points are returned and the membership is recorded as pre-existing", async () => {
  const app = exclusiveApp(); const reserved = await app.reserve(); assert.equal(app.balance(), 400);
  app.tenant.assignTag(CUSTOMER, TAG); // the merchant grants it in Commerce7 meanwhile
  await app.provision(String(reserved.id));
  const claim = app.claims()[0];
  assert.equal(claim.status, "REFUNDED"); assert.equal(claim.membershipOwnership, "PRE_EXISTING"); assert.equal(claim.membershipWriteAttempted, false); assert.equal(claim.slotReleased, true);
  assert.equal(app.balance(), 500); assert.equal(app.ledger.get(`c7-reward-refund:${claim.id}`), "REFUND"); assert.equal(grants(app).length, 0); assert.equal(app.offer().reservedClaimCount, 0);
  assert.equal(view(claim).accessState, "ALREADY_ELIGIBLE"); assert.match(String(claim.errorMessage), /already had this access/);
  assert.ok(domain.commerce7ClaimAllowsOfferEdit(claim), "an already-eligible refund is provably dead");
});

test("with a discount, an already-eligible customer pays for the coupon only; the membership stays the merchant's", async () => {
  const app = exclusiveApp({ discount: true, customerTags: [TAG] });
  assert.equal((await app.claim()).alreadyEligible, false);
  const claim = app.claims()[0];
  assert.equal(claim.status, "ISSUED"); assert.equal(claim.membershipOwnership, "PRE_EXISTING"); assert.equal(claim.membershipWriteAttempted, false); assert.equal(grants(app).length, 0);
  assert.deepEqual(writes(app), ["POST /v1/coupon"]); assert.equal(app.balance(), 400);
  assert.equal(domain.commerce7MembershipGuidance(String(claim.membershipOwnership), 0), "NOT_SQRATCH_OWNED");
});

// ── Partial failures: coupon vs. tag ────────────────────────────────────────────

test("tag granted, coupon definitively refused: access stays granted, points are never refunded, and the store reviews", async () => {
  const app = exclusiveApp({ discount: true });
  app.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/coupon", respond: () => Response.json({ message: "synthetic validation error" }, { status: 422 }) });
  await app.claim();
  const claim = app.claims()[0];
  assert.equal(claim.status, "POINTS_DEBITED"); assert.equal(claim.provisioningState, "MANUAL_REVIEW"); assert.equal(claim.needsManualReview, true);
  assert.equal(claim.entitlementEverGranted, true); assert.equal(claim.membershipOwnership, "SQRATCH_GRANTED"); assert.equal(claim.couponCreateAttempted, false);
  assert.match(String(claim.errorMessage), /access was granted, but the discount could not be issued/); assert.equal(claim.lastReconcileReason, "COUPON_CREATE:WRITE_REJECTED");
  assert.equal(app.balance(), 400); const dto = view(claim); assert.equal(dto.canCancel, false); assert.equal(dto.accessGranted, true); assert.equal(dto.accessState, "MANUAL_REVIEW");
  await assert.rejects(app.cancel(String(claim.id)), { code: "MANUAL_REVIEW_REQUIRED" }); assert.equal(app.balance(), 400);
});

test("tag granted, coupon response lost: no refund, no second coupon POST, and Check provider result recovers the coupon by code", async () => {
  const app = exclusiveApp({ discount: true });
  app.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/coupon", respond: (call) => { app.tenant.coupons.push({ id: "coupon-lost", appliesToObjectIds: "", availableToObjectIds: "", dollarOffDiscountApplies: "Once Per Order", ...call.body }); throw new TypeError("synthetic socket hang up"); } });
  await app.claim(); let claim = app.claims()[0];
  assert.equal(claim.provisioningState, "MANUAL_REVIEW"); assert.equal(claim.couponCreateAttempted, true); assert.equal(claim.entitlementEverGranted, true);
  app.tenant.failures.length = 0; app.advance(); await brandCheck(app, claim); claim = app.claims()[0];
  assert.equal(claim.status, "ISSUED"); assert.equal(claim.externalDiscountId, "coupon-lost");
  assert.equal(app.postBodies().length, 1); assert.equal(grants(app).length, 1); assert.equal(app.balance(), 400);
});

test("a definitively refused grant (4xx) clears its marker and returns the points once; nothing else is attempted", async () => {
  for (const [status, diagnostic, message] of [[422, "TAG_ASSIGN:WRITE_REJECTED", /could not grant this access; points returned/], [404, "TAG_ASSIGN:NOT_FOUND", /could not grant this access; points returned/], [403, "TAG_ASSIGN:SETUP_INCOMPLETE", /rejected reward authorization; points returned/]] as const) {
    const app = exclusiveApp({ discount: true }); failGrant(app, () => Response.json({}, { status }));
    await app.claim(); const claim = app.claims()[0];
    assert.equal(claim.status, "REFUNDED", String(status)); assert.equal(claim.membershipWriteAttempted, false); assert.equal(claim.slotReleased, true); assert.equal(claim.lastReconcileReason, diagnostic);
    assert.match(String(claim.errorMessage), message); assert.equal(app.balance(), 500); assert.equal(app.offer().reservedClaimCount, 0);
    assert.deepEqual(writes(app), ["POST /v1/tag-x-object/customer"], "no coupon after a refused grant");
    assert.ok(domain.commerce7ClaimAllowsOfferEdit(claim));
  }
});

test("a rate-limited grant (429) was refused before processing: the marker clears, points stay reserved, and a retry grants once", async () => {
  const app = exclusiveApp(); failGrant(app, () => new Response("", { status: 429 }));
  await app.claim(); let claim = app.claims()[0];
  assert.equal(claim.provisioningState, "FAILED_RETRYABLE"); assert.equal(claim.membershipWriteAttempted, false); assert.equal(app.balance(), 400);
  app.tenant.failures.length = 0; app.advance(); await app.provision(String(claim.id)); claim = app.claims()[0];
  assert.equal(claim.status, "ISSUED"); assert.equal(grants(app).length, 2, "the 429 attempt plus exactly one accepted grant"); assert.deepEqual(app.tenant.customers[0].tagIds, [TAG]);
});

// ── Ambiguity, lost responses and crashes: never a blind second POST ─────────────

test("an ambiguous grant (5xx) holds points for review; absence never authorizes a second POST; a later native confirmation finalizes as UNVERIFIED", async () => {
  const app = exclusiveApp(); failGrant(app, () => new Response("", { status: 503 }));
  await app.claim(); let claim = app.claims()[0];
  assert.equal(claim.provisioningState, "MANUAL_REVIEW"); assert.equal(claim.membershipWriteAttempted, true); assert.equal(claim.providerMembershipId, null); assert.equal(app.balance(), 400);
  assert.equal(view(claim).canCancel, false); await assert.rejects(app.cancel(String(claim.id)), { code: "MANUAL_REVIEW_REQUIRED" });
  app.tenant.failures.length = 0; app.advance(); await brandCheck(app, claim); claim = app.claims()[0];
  assert.equal(claim.provisioningState, "MANUAL_REVIEW"); assert.equal(claim.lastReconcileReason, "MEMBERSHIP_VERIFY:MEMBERSHIP_RESULT_UNKNOWN"); assert.equal(grants(app).length, 1, "never a second POST");
  app.tenant.assignTag(CUSTOMER, TAG); // the store verifies in Commerce7 and assigns the tag itself
  app.advance(); await brandCheck(app, claim); claim = app.claims()[0];
  assert.equal(claim.status, "ISSUED"); assert.equal(claim.membershipOwnership, "UNVERIFIED", "without SQRATCH's own 201, ownership is not claimed"); assert.equal(grants(app).length, 1);
  assert.equal(domain.commerce7MembershipGuidance("UNVERIFIED", 0), "OWNERSHIP_UNVERIFIED");
});

test("a lost 201 (the grant applied but the response vanished) finalizes from the fresh read without a duplicate membership", async () => {
  const app = exclusiveApp();
  failGrant(app, (call) => { app.tenant.assignTag(String(call.body?.objectId), String(call.body?.tagId)); throw new TypeError("synthetic connection reset"); });
  await app.claim(); let claim = app.claims()[0]; assert.equal(claim.provisioningState, "MANUAL_REVIEW");
  app.tenant.failures.length = 0; app.advance(); await brandCheck(app, claim); claim = app.claims()[0];
  assert.equal(claim.status, "ISSUED"); assert.equal(claim.membershipOwnership, "UNVERIFIED"); assert.deepEqual(app.tenant.customers[0].tagIds, [TAG], "exactly one membership");
});

test("201 accepted but not yet visible: confirmation pending (retryable, never re-posted), then confirmed as SQRATCH-granted", async () => {
  const app = exclusiveApp(); let hide = true;
  app.tenant.failures.push({ when: (path, method) => hide && method === "GET" && path === `/v1/customer/${CUSTOMER}` && grants(app).length === 1, respond: () => Response.json({ id: CUSTOMER, emails: [{ email: "alice@example.test" }], tags: [] }) });
  await app.claim(); let claim = app.claims()[0];
  assert.equal(claim.provisioningState, "FAILED_RETRYABLE"); assert.equal(claim.needsManualReview, false); assert.equal(claim.providerMembershipId, "membership-1");
  assert.equal(view(claim).accessState, "CONFIRMATION_PENDING"); assert.equal(view(claim).canCancel, false);
  hide = false; app.advance(); await app.provision(String(claim.id)); claim = app.claims()[0];
  assert.equal(claim.status, "ISSUED"); assert.equal(claim.membershipOwnership, "SQRATCH_GRANTED"); assert.equal(grants(app).length, 1);
});

test("worker crash recovery: a recorded 201 finalizes without a POST; a marker without a result goes to review; a held owner is never stolen", async () => {
  const crashedAfter201 = exclusiveApp(); const a = await crashedAfter201.reserve(); crashedAfter201.tenant.assignTag(CUSTOMER, TAG);
  Object.assign(crashedAfter201.claims()[0], { providerCustomerId: CUSTOMER, membershipWriteAttempted: true, providerMembershipId: "membership-from-201" });
  await crashedAfter201.provision(String(a.id));
  assert.equal(crashedAfter201.claims()[0].status, "ISSUED"); assert.equal(crashedAfter201.claims()[0].membershipOwnership, "SQRATCH_GRANTED"); assert.equal(grants(crashedAfter201).length, 0);
  const crashedBeforePost = exclusiveApp(); const b = await crashedBeforePost.reserve();
  Object.assign(crashedBeforePost.claims()[0], { providerCustomerId: CUSTOMER, membershipWriteAttempted: true });
  await crashedBeforePost.provision(String(b.id));
  assert.equal(crashedBeforePost.claims()[0].provisioningState, "MANUAL_REVIEW"); assert.equal(grants(crashedBeforePost).length, 0); assert.equal(crashedBeforePost.balance(), 400);
  const held = exclusiveApp(); const c = await held.reserve(); held.claims()[0].provisioningOwner = "stopped-worker";
  await held.provision(String(c.id)); assert.deepEqual(held.calls, [], "a held owner blocks all provider work"); assert.equal(held.claims()[0].status, "POINTS_DEBITED");
});

// ── Idempotency, concurrency and capacity ───────────────────────────────────────

test("a double click replays the same claim: one reservation, one debit, one membership POST", async () => {
  const app = exclusiveApp();
  await app.claim("double-click-key-0001"); await app.claim("double-click-key-0001");
  assert.equal(app.claims().length, 1); assert.equal(app.ledger.size, 1); assert.equal(grants(app).length, 1); assert.equal(app.offer().reservedClaimCount, 1);
});

test("a second claim for the same Customer Tag is refused before any debit while the first is still in flight", async () => {
  const app = exclusiveApp({ customers: [] }); // no Commerce7 account yet: the first claim waits
  await app.claim("first-request-key-0001"); assert.equal(app.claims()[0].provisioningState, "AWAITING_CUSTOMER");
  await assert.rejects(app.claim("second-request-key-002"), { code: "CLAIM_IN_PROGRESS" });
  assert.equal(app.claims().length, 1); assert.equal(app.ledger.size, 1); assert.equal(app.offer().reservedClaimCount, 1);
});

test("after a grant completes, a later claim for the same access is already eligible and costs nothing", async () => {
  const app = exclusiveApp();
  await app.claim("first-request-key-0001"); assert.equal(app.claims()[0].status, "ISSUED");
  assert.equal((await app.claim("second-request-key-002")).alreadyEligible, true);
  assert.equal(app.claims().length, 1); assert.equal(app.balance(), 400); assert.equal(grants(app).length, 1);
});

test("capacity: a full offer refuses before any debit or provider write; a returned claim frees its slot", async () => {
  const app = exclusiveApp({ offer: { maxTotalRedemptions: 1, maxRedemptionsPerUser: 1 }, customers: [{ id: CUSTOMER, email: "alice@example.test" }, { id: "customer-bob", email: "bob@example.test" }] });
  app.tables.user.push({ id: "bob", email: "bob@example.test", isActive: true, isEmailVerified: true, emailVerifiedAt: new Date("2026-10-01T00:00:00.000Z") });
  await app.claim("alice-request-key-0001");
  await assert.rejects(app.claim("bob-request-key-000001", "bob"), { code: "SOLD_OUT" });
  assert.equal(grants(app).length, 1); assert.equal(app.ledger.size, 1);
  const refundable = exclusiveApp({ offer: { maxTotalRedemptions: 1 }, customers: [] });
  const waiting = await refundable.reserve(); await refundable.cancel(String(waiting.id)); await refundable.cancel(String(waiting.id));
  assert.equal(refundable.balance(), 500, "cancelling twice refunds once"); assert.equal(refundable.offer().reservedClaimCount, 0);
});

// ── Customer identity ───────────────────────────────────────────────────────────

test("customer identity: exact verified email only; none waits (and can be cancelled), ambiguous never debits", async () => {
  const none = exclusiveApp({ customers: [{ id: "near-miss", email: "alice+wine@example.test" }, { id: "fuzzy", email: "alice@example.test.example" }] });
  await none.claim(); const waiting = none.claims()[0];
  assert.equal(waiting.provisioningState, "AWAITING_CUSTOMER"); assert.equal(view(waiting).accessState, "WAITING_FOR_CUSTOMER"); assert.equal(view(waiting).canCancel, true); assert.equal(grants(none).length, 0);
  none.tenant.customers.push({ id: CUSTOMER, email: "ALICE@Example.TEST", tagIds: [] }); none.advance(); await none.provision(String(waiting.id));
  assert.equal(none.claims()[0].status, "ISSUED", "a normalized exact match is accepted once it exists"); assert.equal(none.claims()[0].providerCustomerId, CUSTOMER);
  const ambiguous = exclusiveApp({ customers: [{ id: CUSTOMER, email: "alice@example.test" }, { id: "duplicate", email: "Alice@Example.test" }] });
  await assert.rejects(ambiguous.claim(), { code: "CUSTOMER_AMBIGUOUS" });
  assert.equal(ambiguous.claims().length, 0); assert.equal(ambiguous.ledger.size, 0); assert.deepEqual(writes(ambiguous), []);
});

test("customer identity drift before the grant goes to review without a write; nothing was granted, so the user may still cancel", async () => {
  for (const drift of ["email changed", "account deleted"] as const) {
    const app = exclusiveApp(); const reserved = await app.reserve(); Object.assign(app.claims()[0], { providerCustomerId: CUSTOMER });
    if (drift === "email changed") app.tenant.customers[0].email = "someone-else@example.test"; else app.tenant.customers.length = 0;
    await app.provision(String(reserved.id)); const claim = app.claims()[0];
    assert.equal(claim.provisioningState, "MANUAL_REVIEW", drift); assert.match(String(claim.lastReconcileReason), /CUSTOMER_CHANGED/); assert.equal(grants(app).length, 0, drift);
    assert.equal(view(claim).canCancel, true, drift); await app.cancel(String(claim.id)); assert.equal(app.balance(), 500, drift);
  }
});

test("an unverified SQRATCH email is refused before any provider call", async () => {
  const app = exclusiveApp({ user: { email: "alice@example.test", isEmailVerified: false, emailVerifiedAt: null } });
  await assert.rejects(app.claim(), { code: "EMAIL_VERIFICATION_REQUIRED" });
  assert.deepEqual(app.calls, []); assert.equal(app.ledger.size, 0);
});

// ── Tag and product drift ───────────────────────────────────────────────────────

test("a deleted, Dynamic, non-Customer or other-tenant tag is refused live before any debit", async () => {
  for (const [name, tags] of [["deleted (or only on another tenant)", tenantTags.slice(1)], ["Dynamic tag", [{ ...tenantTags[0], type: "Dynamic" }]], ["not a Customer tag", [{ ...tenantTags[0], objectType: "Order" }]]] as const) {
    const app = exclusiveApp({ tags_: [...tags] });
    await assert.rejects(app.claim(), { code: "TAG_UNAVAILABLE" }, name);
    assert.equal(app.claims().length, 0, name); assert.equal(app.ledger.size, 0, name); assert.deepEqual(writes(app), [], name);
  }
});

test("live product drift (made public, tag removed, unavailable) is refused before any debit", async () => {
  for (const [name, liveProduct] of [["public", { security: security([], "Public") }], ["tag removed", { security: security([OTHER_TAG]) }], ["unavailable", { webStatus: "Not Available" }], ["deleted", { id: "another-product" }]] as const) {
    const app = exclusiveApp({ liveProduct: { ...liveProduct } });
    await assert.rejects(app.claim(), { code: "PRODUCT_SECURITY_CHANGED" }, name);
    assert.equal(app.ledger.size, 0, name); assert.deepEqual(writes(app), [], name);
  }
});

test("drift between reservation and grant returns the points without any write", async () => {
  const app = exclusiveApp(); const reserved = await app.reserve(); app.tenant.tags.splice(0, 1);
  await app.provision(String(reserved.id)); const claim = app.claims()[0];
  assert.equal(claim.status, "REFUNDED"); assert.equal(claim.lastReconcileReason, "ACCESS_VERIFY:TAG_UNAVAILABLE"); assert.match(String(claim.errorMessage), /no longer available in Commerce7; points returned/);
  assert.equal(app.balance(), 500); assert.deepEqual(writes(app), []);
});

test("synchronized drift (security changed, tag removed, product gone) is refused by reservation before any provider call", async () => {
  for (const [name, arrange, code] of [
    ["made public", (app: Harness) => { app.tables.connectedCommerceProduct.find((p) => p.externalId === PRODUCT)!.providerMetadata = { security: security([], "Public") }; }, "EXCLUSIVE_UNAVAILABLE"],
    ["tag removed", (app: Harness) => { app.tables.connectedCommerceProduct.find((p) => p.externalId === PRODUCT)!.providerMetadata = { security: security([OTHER_TAG]) }; }, "EXCLUSIVE_UNAVAILABLE"],
    ["unavailable", (app: Harness) => { app.tables.connectedCommerceProduct.find((p) => p.externalId === PRODUCT)!.isAvailable = false; }, "PRODUCT_UNAVAILABLE"],
  ] as const) {
    const app = exclusiveApp(); arrange(app);
    await assert.rejects(app.claim(), { code }, name); assert.deepEqual(app.calls, [], name); assert.equal(app.ledger.size, 0, name);
  }
});

test("a membership removed natively after it was recorded blocks finalization for review instead of re-granting", async () => {
  const app = exclusiveApp({ discount: true });
  app.tenant.failures.push({ when: (path, method) => method === "POST" && path === "/v1/coupon", respond: () => new Response("", { status: 429 }) });
  await app.claim(); assert.equal(app.claims()[0].membershipOwnership, "SQRATCH_GRANTED");
  app.tenant.failures.length = 0; app.tenant.customers[0].tagIds = []; app.advance(); await app.provision(String(app.claims()[0].id));
  const claim = app.claims()[0]; assert.equal(claim.provisioningState, "MANUAL_REVIEW"); assert.match(String(claim.lastReconcileReason), /MEMBERSHIP_CHANGED/); assert.equal(grants(app).length, 1);
});

// ── Several security tags ───────────────────────────────────────────────────────

test("a product with two or three security tags is refused for claiming until multi-tag access is verified, before any provider call", async () => {
  for (const tags of [[TAG, OTHER_TAG], [OTHER_TAG, TAG, THIRD_TAG]]) {
    const app = exclusiveApp({ tags });
    await assert.rejects(app.claim(), { code: "MULTI_TAG_UNVERIFIED" }); assert.deepEqual(app.calls, []); assert.equal(app.ledger.size, 0);
  }
});

test("once multi-tag access is verified, only the selected tag is granted and the product's other tags are untouched", async () => {
  const app = exclusiveApp({ tags: [OTHER_TAG, TAG, THIRD_TAG], multiTag: true });
  await app.claim();
  assert.equal(app.claims()[0].status, "ISSUED"); assert.deepEqual(grants(app).map((call) => call.body), [{ objectId: CUSTOMER, tagId: TAG }]);
  assert.deepEqual(app.tenant.customers[0].tagIds, [TAG]); assert.deepEqual(app.tenant.products[0].security, security([OTHER_TAG, TAG, THIRD_TAG]), "product security is never written");
});

// ── Expiry ──────────────────────────────────────────────────────────────────────

test("expiry ends coupons, not access: an access-only grant stays granted while an exclusive coupon expires", async () => {
  const accessOnly = exclusiveApp(); await accessOnly.claim();
  const withCoupon = exclusiveApp({ discount: true }); await withCoupon.claim();
  for (const app of [accessOnly, withCoupon]) { app.advance(31 * 86400000); await app.reconcile(); }
  assert.equal(accessOnly.claims()[0].status, "ISSUED"); assert.equal(view(accessOnly.claims()[0]).accessState, "ACCESS_GRANTED");
  assert.equal(withCoupon.claims()[0].status, "EXPIRED"); assert.equal(view(withCoupon.claims()[0]).accessState, "ACCESS_GRANTED", "the Commerce7 access is not revoked by coupon expiry");
  assert.deepEqual(writes(accessOnly).filter((write) => write.startsWith("DELETE")), []);
});

test("an exclusive claim not granted before its window ends is refunded only while nothing was ever written", async () => {
  const unwritten = exclusiveApp({ customers: [] }); await unwritten.claim(); unwritten.advance(31 * 86400000); await unwritten.provision(String(unwritten.claims()[0].id));
  assert.equal(unwritten.claims()[0].status, "REFUNDED"); assert.equal(unwritten.balance(), 500);
  const written = exclusiveApp(); failGrant(written, () => new Response("", { status: 504 })); await written.claim();
  written.tenant.failures.length = 0; written.advance(31 * 86400000); await brandCheck(written, written.claims()[0]);
  assert.equal(written.claims()[0].status, "POINTS_DEBITED"); assert.match(String(written.claims()[0].lastReconcileReason), /EXPIRED_PENDING_REVIEW/); assert.equal(written.balance(), 400);
});

// ── Safety: permissions, deletions, leaks ───────────────────────────────────────

test("no deletion, product write, PUT, Admin /v2 request or credential/PII leak on any path", async () => {
  const apps = [exclusiveApp(), exclusiveApp({ discount: true }), exclusiveApp({ customerTags: [TAG] }), exclusiveApp({ discount: true, customerTags: [TAG] })];
  const ambiguous = exclusiveApp(); failGrant(ambiguous, () => new Response("", { status: 500 })); apps.push(ambiguous);
  for (const app of apps) await app.claim();
  for (const app of apps) {
    assert.ok(app.calls.every((call) => call.method === "GET" || (call.method === "POST" && ["/v1/tag-x-object/customer", "/v1/coupon"].includes(call.path))), JSON.stringify(writes(app)));
    assert.ok(app.calls.every((call) => call.path.startsWith("/v1/")), "public /v1 only");
    const logged = JSON.stringify(app.logs);
    for (const secret of ["alice@example.test", CUSTOMER, TAG, "synthetic-test-secret", ...app.claims().map((claim) => String(claim.code))]) assert.ok(!logged.includes(secret), secret);
  }
  const source = ["src/lib/commerce7-rewards.ts", "src/lib/commerce/providers/commerce7-rewards-client.ts"].map((path) => readFileSync(path, "utf8")).join("\n");
  assert.doesNotMatch(source, /tag-x-object[^\n]*"DELETE"|"DELETE"[^\n]*tag-x-object/, "SQRATCH has no membership deletion");
  assert.doesNotMatch(source, /commerce7\.com\/v2|\/v2\//, "never the Admin /v2 API");
  assert.doesNotMatch(source, /`\/product[^`]*`, "(PUT|POST|PATCH|DELETE)"/, "never a product write");
});

// ── Saving and enabling: one explicit tag ───────────────────────────────────────

const exclusiveBody = { ...offerBody, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", isActive: false, discountEnabled: false, maxTotalRedemptions: 25, appliesTo: "SPECIFIC_PRODUCTS", productIds: [PRODUCT] };
const stored = (app: Harness) => (app.tables.brandRewardOffer.at(-1)!.commerce7Config as Row).exclusiveAccess as Row;

test("save: a single-tag product preselects its tag; the UUID is frozen, the title is display-only, and only a Tag read is made", async () => {
  const app = exclusiveApp(); const saved = await app.save(exclusiveBody);
  assert.deepEqual(plain(stored(app)), { productId: PRODUCT, securityAvailableTo: "Tag", securityTagId: TAG, tagTitle: "SQRATCH Rare Wine Test" });
  assert.deepEqual(app.calls.map((call) => `${call.method} ${call.path}`), [`GET /v1/tag/customer/${TAG}`]);
  const brandView = domain.serializeCommerce7OfferResponse(saved).commerce7Config;
  assert.deepEqual(brandView, { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: false, exclusiveTagTitle: "SQRATCH Rare Wine Test" }); assert.ok(!JSON.stringify(brandView).includes(TAG));
});

test("save: two or three tags require an explicit choice, freeze only the chosen tag, and stay draft-only", async () => {
  const two = exclusiveApp({ tags: [TAG, OTHER_TAG] });
  await assert.rejects(two.save(exclusiveBody), (error: { code: string; message: string }) => error.code === "INVALID_OFFER" && /several Customer Tags/.test(error.message));
  await two.save({ ...exclusiveBody, exclusiveTagId: OTHER_TAG }); assert.equal(stored(two).securityTagId, OTHER_TAG); assert.equal(stored(two).tagTitle, "Library Wine Members");
  await assert.rejects(two.save({ ...exclusiveBody, exclusiveTagId: OTHER_TAG, isActive: true }), { code: "MULTI_TAG_UNVERIFIED" });
  const three = exclusiveApp({ tags: [TAG, OTHER_TAG, THIRD_TAG] }); await three.save({ ...exclusiveBody, exclusiveTagId: THIRD_TAG });
  assert.equal(stored(three).securityTagId, THIRD_TAG);
  assert.deepEqual((three.tables.connectedCommerceProduct.find((p) => p.externalId === PRODUCT)!.providerMetadata as Row).security, security([TAG, OTHER_TAG, THIRD_TAG]), "other tags are preserved");
  assert.deepEqual(writes(two), []); assert.deepEqual(writes(three), []);
});

test("save: a tag not on the product, deleted, Dynamic or non-Customer is refused with no write", async () => {
  const notOnProduct = exclusiveApp(); await assert.rejects(notOnProduct.save({ ...exclusiveBody, exclusiveTagId: OTHER_TAG }), { code: "INVALID_OFFER" }); assert.deepEqual(notOnProduct.calls, []);
  for (const tags of [tenantTags.slice(1), [{ ...tenantTags[0], type: "Dynamic" }], [{ ...tenantTags[0], objectType: "ClubMembership" }]]) {
    const app = exclusiveApp({ tags_: [...tags] }); const before = app.tables.brandRewardOffer.length;
    await assert.rejects(app.save(exclusiveBody), { code: "INVALID_OFFER" }); assert.equal(app.tables.brandRewardOffer.length, before); assert.deepEqual(writes(app), []);
  }
  const noBackend = exclusiveApp(); noBackend.environment.backend = false; await assert.rejects(noBackend.save(exclusiveBody), { code: "SETUP_INCOMPLETE" });
});

test("save active: a single-tag product is activated only after live tag and product reads", async () => {
  const app = exclusiveApp(); const saved = await app.save({ ...exclusiveBody, isActive: true });
  assert.equal(saved.isActive, true); assert.deepEqual(app.calls.map((call) => `${call.method} ${call.path}`), [`GET /v1/tag/customer/${TAG}`, `GET /v1/tag/customer/${TAG}`, `GET /v1/product/${PRODUCT}`]);
  const publicNow = exclusiveApp({ liveProduct: { security: security([], "Public") } }); await assert.rejects(publicNow.save({ ...exclusiveBody, isActive: true }), { code: "PRODUCT_SECURITY_CHANGED" });
});

test("enable: an exclusive draft is enabled after live reads; drift refuses and leaves it inactive", async () => {
  const app = exclusiveApp({ offer: { isActive: false } });
  assert.equal((await app.setActive("ENABLE")).isActive, true); assert.deepEqual(writes(app), []);
  const deleted = exclusiveApp({ offer: { isActive: false }, tags_: tenantTags.slice(1) });
  await assert.rejects(deleted.setActive("ENABLE"), { code: "TAG_UNAVAILABLE" }); assert.equal(deleted.offer().isActive, false);
  const multi = exclusiveApp({ offer: { isActive: false }, tags: [TAG, OTHER_TAG] });
  await assert.rejects(multi.setActive("ENABLE"), { code: "MULTI_TAG_UNVERIFIED" }); assert.deepEqual(multi.calls, []);
  const removed = exclusiveApp({ offer: { isActive: false } }); removed.tables.connectedCommerceProduct.find((p) => p.externalId === PRODUCT)!.providerMetadata = { security: security([OTHER_TAG]) };
  await assert.rejects(removed.setActive("ENABLE"), { code: "EXCLUSIVE_REVIEW_REQUIRED" });
  const racing = exclusiveApp({ offer: { isActive: false } });
  racing.txState.onOpen = () => { racing.tables.connectedCommerceProduct.find((p) => p.externalId === PRODUCT)!.providerMetadata = { security: security([], "Public") }; };
  await assert.rejects(racing.setActive("ENABLE"), { code: "OFFER_CHANGED" }); assert.equal(racing.offer().isActive, false);
});

test("discount offers are unaffected: still no provider call on save, and Selected products can now go live", async () => {
  const app = harness(); const saved = await app.save({ ...offerBody, appliesTo: "SPECIFIC_PRODUCTS", productIds: ["wine-a", "wine-b"] });
  assert.equal(saved.isActive, true); assert.deepEqual(app.calls, []); assert.equal(app.clientsCreated(), 0);
});

test("a closed, sold-out or per-user-exhausted exclusive offer is refused by reservation without any provider read", async () => {
  for (const [name, offer, code] of [["inactive", { isActive: false }, "INACTIVE"], ["sold out", { maxTotalRedemptions: 1, reservedClaimCount: 1 }, "SOLD_OUT"], ["not started", { claimStartsAt: new Date("2030-01-01T00:00:00.000Z") }, "NOT_STARTED"]] as const) {
    const app = exclusiveApp({ offer: { ...offer } });
    await assert.rejects(app.claim(), { code }, name); assert.deepEqual(app.calls, [], name); assert.equal(app.ledger.size, 0, name);
  }
});
