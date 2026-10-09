/** Opt-in only. Requires ALLOW_REAL_DATABASE_TESTS=true,
 * COMMERCE7_REWARDS_REAL_DB=true, a loopback DATABASE_URL ending _test,
 * and this branch's schema already installed in that disposable database.
 * Never uses provider credentials/network. Deletes only its own fixtures. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { NextResponse } from "next/server";
import ts from "typescript";
import { canUseRealDatabaseUnderTest } from "../src/lib/db-safety";
const decision = canUseRealDatabaseUnderTest({ connectionString: process.env.DATABASE_URL ?? "", allowRealDatabaseTestsEnv: process.env.ALLOW_REAL_DATABASE_TESTS });
const enabled = decision.allowed && process.env.COMMERCE7_REWARDS_REAL_DB === "true";

test("real Postgres: cap 25, duplicate request, point overspend, cancellation and rollback are atomic", { skip: !enabled && `Disposable DB opt-in required (${decision.reason})` }, async () => {
  const { default: db } = await import("../src/lib/prisma");
  const { reserveCommerce7Claim, cancelCommerce7Claim, provisionCommerce7Claim, saveCommerce7Offer } = await import("../src/lib/commerce7-rewards");
  const { reconcileCommerce7RewardOrders } = await import("../src/lib/commerce/providers/commerce7-reward-orders");
  const { Commerce7RewardsClient, Commerce7RewardError, claimTagTitle, parseNativeCoupon } = await import("../src/lib/commerce/providers/commerce7-rewards-client");
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const brand = await db.brand.create({ data: { name: "Reward fixture", slug: `c7-reward-${unique}` } });
  const connection = await db.commerceConnection.create({ data: { brandId: brand.id, provider: "COMMERCE7", status: "CONNECTED", externalAccountId: "synthetic-reward-tenant", displayName: "Synthetic store", providerMetadata: { currencyCode: "CAD" } } });
  // Pre-refinement offers embed the merchant's native template; that shape must keep issuing. New offers carry no template.
  const template = { id: "native-template", title: "Template", code: "template", usageLimitType: "Per Store", usageLimit: 1, appliesTo: "Store", appliesToObjectIds: null, productDiscountType: "Dollar Off", productDiscount: 1000, shippingDiscountType: "No Discount", shippingDiscount: null, startDate: "2026-01-01T00:00:00.000Z", endDate: null, status: "Enabled", minimumCartAmount: null, availableTo: "opaque-native-tag-selector", availableToObjectIds: ["native-tag"] };
  const userIds: string[] = []; let userIndex = 0;
  async function user(balance = 1000, verified = true) {
    const index = userIndex++;
    const row = await db.user.create({ data: { email: `reward-${index}-${unique}@example.test`, password: "synthetic-unused", isEmailVerified: verified, emailVerifiedAt: verified ? new Date() : null } }); userIds.push(row.id);
    await db.userPointAccount.create({ data: { userId: row.id, spendablePoints: balance, lifetimeEarnedPoints: balance } }); return row;
  }
  async function offer(cap: number, perUser = 1, config: Record<string, unknown> = { templateCouponId: template.id, template }) {
    return db.brandRewardOffer.create({ data: { brandId: brand.id, provider: "COMMERCE7", connectionId: connection.id, sourceExternalAccountId: connection.externalAccountId, title: "Reward fixture", isActive: true, pointsCost: 100, discountAmountCents: 1000, currencyCode: "CAD", maxTotalRedemptions: cap, maxRedemptionsPerUser: perUser, commerce7Config: config as never } });
  }
  try {
    await db.connectedCommerceProduct.create({ data: { brandId: brand.id, connectionId: connection.id, provider: "COMMERCE7", externalId: "rare-wine", externalKey: "rare-wine", title: "Rare wine", productUrl: "", images: [], externalVariantIds: [], providerMetadata: { security: { availableTo: "Tag", displayOption: "Display Product / Show Login", availableToObjectIds: ["synthetic-customer-tag-id"] } } } });
    const exclusiveDraft = { title: "Rare wine access", isActive: false, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", discountEnabled: false, discountType: "FIXED_AMOUNT", pointsCost: 100, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, codeValidDays: 30, productIds: ["rare-wine"] };
    // Exclusive saves read the tag (and, when activating, the product) through a synthetic read-only provider; never the network.
    const liveReads = { customerTag: async (id: string) => ({ id, title: "Synthetic Rare Members", type: "Manual", objectType: "Customer" }), productAccess: async (id: string) => ({ id, available: true, security: { availableTo: "Tag", displayOption: null, availableToObjectIds: ["synthetic-customer-tag-id"] } }) };
    const exclusiveDeps = { db, client: () => liveReads as never, now: () => new Date(), backendConfigured: () => true };
    const draft = await saveCommerce7Offer(brand.id, exclusiveDraft, undefined, exclusiveDeps);
    assert.equal(draft.rewardMode, "EXCLUSIVE_PRODUCT_ACCESS"); assert.equal(draft.discountAmountCents, null, "Postgres accepts an access-only exclusive offer (relaxed discount CHECK)");
    const activeExclusive = await saveCommerce7Offer(brand.id, { ...exclusiveDraft, isActive: true }, undefined, exclusiveDeps);
    assert.equal(activeExclusive.isActive, true, "Postgres accepts an active exclusive offer (relaxed reward_c7_offer_limits)");
    await db.brandRewardOffer.update({ where: { id: activeExclusive.id }, data: { isActive: false } });
    await assert.rejects(saveCommerce7Offer(brand.id, { ...exclusiveDraft, productIds: ["foreign-wine"] }, undefined, exclusiveDeps), { code: "INVALID_OFFER" });
    // Saving an offer is SQRATCH-only: any provider client use fails the test.
    const offerDeps = { db, client: (): never => { throw new Error("offer save must not use the provider"); }, now: () => new Date() };
    const offerInput = { eligibilityMode: "ANYONE_WITH_CODE", title: "Real offer service", isActive: true, rewardMode: "DISCOUNT", discountType: "FIXED_AMOUNT", discountAmountCents: 1000, pointsCost: 100, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, codeValidDays: 30, productIds: [], brandId: "forged-brand", connectionId: "forged-connection", currencyCode: "USD" };
    const createdOffer = await saveCommerce7Offer(brand.id, offerInput, undefined, offerDeps);
    assert.equal(createdOffer.brandId, brand.id); assert.equal(createdOffer.connectionId, connection.id); assert.equal(createdOffer.currencyCode, "CAD");
    assert.deepEqual(createdOffer.commerce7Config, { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true });
    await assert.rejects(saveCommerce7Offer(brand.id, { ...offerInput, eligibilityMode: "CLAIMANT_ONLY" }, undefined, offerDeps), { code: "COUPON_CONTRACT_UNVERIFIED" });
    const editedOffer = await saveCommerce7Offer(brand.id, { ...offerInput, isActive: false, discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1500 }, createdOffer.id, offerDeps);
    assert.equal(editedOffer.discountPercentageBasisPoints, 1500); assert.equal(editedOffer.isActive, false);
    await assert.rejects(saveCommerce7Offer(brand.id, offerInput, "foreign-offer", offerDeps), { code: "NOT_FOUND" });
    const capped = await offer(25);
    // SQL constraints are independent of the TypeScript parser.
    await assert.rejects(db.brandRewardOffer.update({ where: { id: capped.id }, data: { maxTotalRedemptions: 0 } }));
    // Exclusive offers may now be active (the saga verifies native access), but the database still caps them at 25 claims.
    await assert.rejects(db.brandRewardOffer.update({ where: { id: draft.id }, data: { maxTotalRedemptions: 26 } }), (error: Error) => error.message.includes("reward_c7_offer_limits"));
    const guardedUser = await user(100);
    for (const [code, data] of [["INACTIVE", { isActive: false }], ["NOT_STARTED", { claimStartsAt: new Date(Date.now() + 86400000) }], ["EXPIRED", { claimEndsAt: new Date(0) }]] as const) {
      const guardedOffer = await offer(1);
      await db.brandRewardOffer.update({ where: { id: guardedOffer.id }, data });
      await assert.rejects(reserveCommerce7Claim(guardedUser.id, guardedOffer.id, "unavailable-offer-key", [brand.id]), { code });
    }
    for (const data of [{ status: "DISCONNECTED" as const }, { uninstalledAt: new Date() }]) {
      await db.commerceConnection.update({ where: { id: connection.id }, data });
      await assert.rejects(reserveCommerce7Claim(guardedUser.id, capped.id, "disconnected-offer-key", [brand.id]), { code: "CONNECTION_UNAVAILABLE" });
      await db.commerceConnection.update({ where: { id: connection.id }, data: { status: "CONNECTED", uninstalledAt: null } });
    }
    const foreignConnectionOffer = await offer(1);
    await db.brandRewardOffer.update({ where: { id: foreignConnectionOffer.id }, data: { connectionId: "foreign-connection" } });
    await assert.rejects(reserveCommerce7Claim(guardedUser.id, foreignConnectionOffer.id, "foreign-connection-key", [brand.id]), { code: "CONNECTION_UNAVAILABLE" });
    const retiredOffer = await offer(1);
    await db.brandRewardOffer.update({ where: { id: retiredOffer.id }, data: { appliesTo: "SPECIFIC_PRODUCTS", commerce7Config: { templateCouponId: template.id, template: { ...template, appliesTo: "opaque-product-selector", appliesToObjectIds: ["retired-product"] } }, products: { create: [{ externalProductId: "retired-product", title: "Retired" }] } } });
    await assert.rejects(reserveCommerce7Claim(guardedUser.id, retiredOffer.id, "retired-product-key", [brand.id]), { code: "PRODUCT_UNAVAILABLE" });
    assert.equal(await db.pointTransaction.count({ where: { userId: guardedUser.id } }), 0);
    await assert.rejects(reserveCommerce7Claim(guardedUser.id, draft.id, "exclusive-draft-claim-key", [brand.id]), { code: "INACTIVE" });
    const perUserOffer = await offer(5);
    await reserveCommerce7Claim(guardedUser.id, perUserOffer.id, "first-per-user-claim-key", [brand.id]);
    await assert.rejects(reserveCommerce7Claim(guardedUser.id, perUserOffer.id, "second-per-user-claim-key", [brand.id]), { code: "USER_LIMIT" });
    assert.equal(await db.pointTransaction.count({ where: { userId: guardedUser.id, type: "SPEND" } }), 1);
    // Execute the actual admin route against Postgres, pausing after its
    // predicate read so a claim commits before deletion resumes. SSI must
    // reject deletion rather than cascade away the new reward history.
    const raceUser = await user(100); const raceOffer = await offer(1);
    let deletionChecked: () => void = () => {}; let resumeDeletion: () => void = () => {};
    const checkedDeletion = new Promise<void>((resolve) => { deletionChecked = resolve; });
    const deletionGate = new Promise<void>((resolve) => { resumeDeletion = resolve; });
    const adminExports: { DELETE?: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response> } = {};
    const adminDependencies: Record<string, unknown> = {
      "next/server": { NextResponse }, "next-auth/next": { getServerSession: async () => ({ user: { role: "ADMIN" } }) },
      "@/app/api/auth/[...nextauth]/options": { authOptions: {} }, "@/lib/storage-upload": {}, "@/lib/admin-auth": {},
      "@/lib/prisma": { __esModule: true, default: { user: db.user, campaign: db.campaign, qRCode: db.qRCode,
        $transaction: (work: (tx: unknown) => Promise<unknown>, options: { isolationLevel: "Serializable" }) => db.$transaction(async (tx) => work({ user: tx.user, commerceRewardRedemption: { count: async (args: { where: { userId: string; provider: "COMMERCE7" } }) => { const count = await tx.commerceRewardRedemption.count(args); deletionChecked(); await deletionGate; return count; } } }), options),
      } },
    };
    runInNewContext(ts.transpileModule(readFileSync("src/app/api/admin/user-management/update-or-delete-users/[id]/route.ts", "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, { exports: adminExports, require(name: string) { if (!(name in adminDependencies)) throw new Error("Unexpected admin dependency"); return adminDependencies[name]; } });
    const deletion = adminExports.DELETE!(new Request("https://sqratch.example/api/admin/users/delete"), { params: Promise.resolve({ id: raceUser.id }) });
    await checkedDeletion;
    try { await reserveCommerce7Claim(raceUser.id, raceOffer.id, "claim-racing-user-deletion", [brand.id]); }
    finally { resumeDeletion(); }
    assert.equal((await deletion).status, 409);
    assert.ok(await db.user.findUnique({ where: { id: raceUser.id } }));
    assert.equal(await db.commerceRewardRedemption.count({ where: { userId: raceUser.id } }), 1);
    const users = await Promise.all(Array.from({ length: 26 }, () => user()));
    // Independent transactions/connections exercise Postgres SSI, not an
    // in-memory lock. Pre-fill 24; simultaneous contenders compete for #25.
    for (let i = 0; i < 24; i++) await reserveCommerce7Claim(users[i].id, capped.id, `claim-request-${i.toString().padStart(4, "0")}`, [brand.id]);
    const contenders = await Promise.allSettled([24, 25].map((i) => reserveCommerce7Claim(users[i].id, capped.id, `claim-request-${i.toString().padStart(4, "0")}`, [brand.id])));
    assert.equal(contenders.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(contenders.find((result) => result.status === "rejected")?.reason.code, "SOLD_OUT");
    assert.equal(await db.commerceRewardRedemption.count({ where: { offerId: capped.id } }), 25);
    assert.equal((await db.brandRewardOffer.findUniqueOrThrow({ where: { id: capped.id } })).reservedClaimCount, 25);
    const lost = contenders.findIndex((r) => r.status === "rejected");
    assert.equal((await db.userPointAccount.findUniqueOrThrow({ where: { userId: users[24 + lost].id } })).spendablePoints, 1000);
    assert.equal(await db.pointTransaction.count({ where: { userId: users[24 + lost].id } }), 0);

    const repeatOffer = await offer(5, 5); const repeatUser = await user(100);
    const repeats = await Promise.all([1, 2].map(() => reserveCommerce7Claim(repeatUser.id, repeatOffer.id, "same-logical-request-key", [brand.id])));
    assert.equal(repeats[0].id, repeats[1].id);
    await assert.rejects(saveCommerce7Offer(brand.id, offerInput, repeatOffer.id, offerDeps), { code: "OFFER_HAS_CLAIMS" });
    await assert.rejects(db.commerceRewardRedemption.update({ where: { id: repeats[0].id }, data: { slotReleased: true } }));
    assert.equal(await db.pointTransaction.count({ where: { userId: repeatUser.id, type: "SPEND" } }), 1);
    assert.equal((await db.userPointAccount.findUniqueOrThrow({ where: { userId: repeatUser.id } })).spendablePoints, 0);
    await assert.rejects(reserveCommerce7Claim(repeatUser.id, repeatOffer.id, "different-request-key", [brand.id]), { code: "INSUFFICIENT_POINTS" });
    assert.equal(await db.commerceRewardRedemption.count({ where: { offerId: repeatOffer.id } }), 1);
    await Promise.all([1, 2].map(() => cancelCommerce7Claim(repeatUser.id, repeats[0].id)));
    assert.equal((await db.userPointAccount.findUniqueOrThrow({ where: { userId: repeatUser.id } })).spendablePoints, 100);
    assert.equal(await db.pointTransaction.count({ where: { userId: repeatUser.id, type: "REFUND" } }), 1);
    assert.equal((await db.commerceRewardRedemption.findUniqueOrThrow({ where: { id: repeats[0].id } })).slotReleased, true);
    assert.equal((await db.brandRewardOffer.findUniqueOrThrow({ where: { id: repeatOffer.id } })).reservedClaimCount, 0);
    const overspendUser = await user(100); const overspendOffers = await Promise.all([offer(1), offer(1)]);
    const overspend = await Promise.allSettled(overspendOffers.map((reward) => reserveCommerce7Claim(overspendUser.id, reward.id, "concurrent-points-key", [brand.id])));
    assert.equal(overspend.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(await db.pointTransaction.count({ where: { userId: overspendUser.id, type: "SPEND" } }), 1);
    assert.equal((await db.userPointAccount.findUniqueOrThrow({ where: { userId: overspendUser.id } })).spendablePoints, 0);

    const unverified = await user(100, false);
    await assert.rejects(reserveCommerce7Claim(unverified.id, repeatOffer.id, "unverified-request-key", [brand.id]), { code: "EMAIL_VERIFICATION_REQUIRED" });
    await assert.rejects(reserveCommerce7Claim(users[25].id, repeatOffer.id, "foreign-brand-request", ["foreign-brand"]), { code: "NOT_FOUND" });

    // Missing native customer is a pending claim with a full cancel path.
    const pendingUser = await user(100); const pending = await reserveCommerce7Claim(pendingUser.id, repeatOffer.id, "pending-customer-request", [brand.id]);
    class MissingCustomer extends Commerce7RewardsClient { async customer() { return null; } }
    const dependencies = { db, client: (tenant: string) => new MissingCustomer(tenant), now: () => new Date() };
    const result = await provisionCommerce7Claim(pending.id, pendingUser.id, dependencies);
    assert.equal(result?.provisioningState, "AWAITING_CUSTOMER"); assert.equal(result?.providerCustomerId, null);
    await cancelCommerce7Claim(pendingUser.id, pending.id);
    assert.equal((await db.userPointAccount.findUniqueOrThrow({ where: { userId: pendingUser.id } })).spendablePoints, 100);

    // Full provider saga with synthetic native resources. No network calls.
    let clock = Date.now();
    class NativeFixture extends Commerce7RewardsClient {
      lastEmail = ""; lastPayload: import("../src/lib/commerce/providers/commerce7-rewards-client").CouponWriteRequest | null = null; customerReads = 0;
      eligible = false; tagCreates = 0; couponCreates = 0; loseTagResponse = false; loseCouponResponse = false;
      tagResource: { id: string; title: string; type: "Manual"; objectType: "Customer" } | null = null;
      couponResource: import("../src/lib/commerce/providers/commerce7-rewards-client").NativeCoupon | null = null;
      async customer(email: string) { this.customerReads++; this.lastEmail = email; return { id: "exact-customer", emails: [email], tagIds: this.eligible && this.tagResource ? [this.tagResource.id] : [] }; }
      async customerById() { return this.customer(this.lastEmail); }
      async tagOnlyForCustomer() { return this.eligible; }
      async findTag() { return this.tagResource; }
      async createTag(id: string) { this.tagCreates++; this.tagResource = { id: `tag-${id}`, title: claimTagTitle(id), type: "Manual", objectType: "Customer" }; if (this.loseTagResponse) throw new Commerce7RewardError("PROVIDER_UNAVAILABLE", true); return this.tagResource; }
      async findCoupon() { return this.couponResource; }
      async createCoupon(payload: import("../src/lib/commerce/providers/commerce7-rewards-client").CouponWriteRequest) { this.couponCreates++; this.lastPayload = payload; const created = parseNativeCoupon({ id: "exact-native-coupon", appliesToObjectIds: null, availableToObjectIds: null, shippingDiscount: null, minimumCartAmount: null, ...payload }); this.couponResource = created; if (this.loseCouponResponse) throw new Commerce7RewardError("PROVIDER_UNAVAILABLE", true); return created; }
    }
    async function setup() { const owner = await user(100); const reward = await offer(10); const claim = await reserveCommerce7Claim(owner.id, reward.id, "synthetic-saga-request", [brand.id]); const native = new NativeFixture(connection.externalAccountId); return { owner, claim, native, deps: { db, client: () => native, now: () => new Date(clock += 60000) } }; }
    const saga = await setup();
    // Even a privileged deletion outside the guarded app route cannot recycle
    // lifetime capacity. This synthetic fixture intentionally bypasses that route.
    const deletedUser = await user(100); const lifetimeOffer = await offer(1);
    const lifetimeClaim = await reserveCommerce7Claim(deletedUser.id, lifetimeOffer.id, "lifetime-capacity-claim", [brand.id]);
    const lifetimeNative = new NativeFixture(connection.externalAccountId); lifetimeNative.eligible = true;
    assert.equal((await provisionCommerce7Claim(lifetimeClaim.id, deletedUser.id, { db, client: () => lifetimeNative, now: () => new Date(clock += 60000) }))?.status, "ISSUED");
    await db.user.delete({ where: { id: deletedUser.id } });
    assert.equal(await db.commerceRewardRedemption.count({ where: { offerId: lifetimeOffer.id } }), 0);
    assert.equal((await db.brandRewardOffer.findUniqueOrThrow({ where: { id: lifetimeOffer.id } })).reservedClaimCount, 1);
    const nextUser = await user(100);
    await assert.rejects(reserveCommerce7Claim(nextUser.id, lifetimeOffer.id, "no-recycled-issued-slot", [brand.id]), { code: "SOLD_OUT" });
    assert.equal(await db.pointTransaction.count({ where: { userId: nextUser.id } }), 0);
    await assert.rejects(cancelCommerce7Claim("foreign-user", saga.claim.id), { code: "NOT_FOUND" });
    assert.equal(await provisionCommerce7Claim(saga.claim.id, "foreign-user", saga.deps), null);
    let checked = await provisionCommerce7Claim(saga.claim.id, saga.owner.id, saga.deps);
    assert.equal(checked?.provisioningState, "AWAITING_ELIGIBILITY"); assert.equal(checked?.externalDiscountId, null); assert.equal(saga.native.couponCreates, 0);
    saga.native.eligible = true;
    checked = await provisionCommerce7Claim(saga.claim.id, saga.owner.id, saga.deps);
    assert.equal(checked?.status, "ISSUED"); assert.equal(checked?.provisioningState, "READY"); assert.equal(checked?.entitlementEverGranted, true); assert.equal(saga.native.tagCreates, 1); assert.equal(saga.native.couponCreates, 1);
    await provisionCommerce7Claim(saga.claim.id, saga.owner.id, saga.deps); assert.equal(saga.native.couponCreates, 1);
    await assert.rejects(cancelCommerce7Claim(saga.owner.id, saga.claim.id), { code: "MANUAL_REVIEW_REQUIRED" });
    assert.equal((await db.commerceRewardRedemption.findUniqueOrThrow({ where: { id: saga.claim.id } })).slotReleased, false);

    const lostCoupon = await setup(); lostCoupon.native.eligible = true; lostCoupon.native.loseCouponResponse = true;
    checked = await provisionCommerce7Claim(lostCoupon.claim.id, lostCoupon.owner.id, lostCoupon.deps);
    assert.equal(checked?.provisioningState, "MANUAL_REVIEW"); assert.equal(checked?.couponCreateAttempted, true);
    await assert.rejects(cancelCommerce7Claim(lostCoupon.owner.id, lostCoupon.claim.id), { code: "MANUAL_REVIEW_REQUIRED" });
    await db.commerceRewardRedemption.update({ where: { id: lostCoupon.claim.id }, data: { needsManualReview: false, providerLastCheckedAt: null } });
    checked = await provisionCommerce7Claim(lostCoupon.claim.id, lostCoupon.owner.id, lostCoupon.deps);
    assert.equal(checked?.status, "ISSUED"); assert.equal(lostCoupon.native.couponCreates, 1);

    const lostTag = await setup(); lostTag.native.loseTagResponse = true;
    checked = await provisionCommerce7Claim(lostTag.claim.id, lostTag.owner.id, lostTag.deps);
    assert.equal(checked?.provisioningState, "MANUAL_REVIEW"); assert.equal(checked?.tagCreateAttempted, true);
    await db.commerceRewardRedemption.update({ where: { id: lostTag.claim.id }, data: { needsManualReview: false, providerLastCheckedAt: null } });
    lostTag.native.eligible = true;
    checked = await provisionCommerce7Claim(lostTag.claim.id, lostTag.owner.id, lostTag.deps);
    assert.equal(checked?.status, "ISSUED"); assert.equal(lostTag.native.tagCreates, 1);

    const absentCoupon = await setup(); absentCoupon.native.eligible = true;
    await db.commerceRewardRedemption.update({ where: { id: absentCoupon.claim.id }, data: { couponCreateAttempted: true } });
    checked = await provisionCommerce7Claim(absentCoupon.claim.id, absentCoupon.owner.id, absentCoupon.deps);
    assert.equal(checked?.provisioningState, "MANUAL_REVIEW"); assert.equal(absentCoupon.native.couponCreates, 0);

    const changedEmail = await setup();
    await db.user.update({ where: { id: changedEmail.owner.id }, data: { emailVerifiedAt: new Date(Date.now() + 5000) } });
    checked = await provisionCommerce7Claim(changedEmail.claim.id, changedEmail.owner.id, changedEmail.deps);
    assert.equal(checked?.provisioningState, "FAILED_RETRYABLE"); assert.equal(changedEmail.native.tagCreates, 0);
    await cancelCommerce7Claim(changedEmail.owner.id, changedEmail.claim.id);

    const denied = await setup();
    class DeniedNative extends NativeFixture { async customer(): Promise<never> { throw new Commerce7RewardError("SETUP_INCOMPLETE"); } }
    checked = await provisionCommerce7Claim(denied.claim.id, denied.owner.id, { ...denied.deps, client: () => new DeniedNative(connection.externalAccountId) });
    assert.equal(checked?.status, "REFUNDED"); assert.equal((await db.userPointAccount.findUniqueOrThrow({ where: { userId: denied.owner.id } })).spendablePoints, 100);

    const owned = await setup(); let release: () => void = () => {}; let started: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; }); const entered = new Promise<void>((resolve) => { started = resolve; });
    class BlockingNative extends NativeFixture { async customer(email: string) { started(); await gate; return super.customer(email); } }
    const blocking = new BlockingNative(connection.externalAccountId); const deps = { ...owned.deps, client: () => blocking };
    const first = provisionCommerce7Claim(owned.claim.id, owned.owner.id, deps); await entered;
    try { const second = await provisionCommerce7Claim(owned.claim.id, owned.owner.id, deps); assert.equal(second?.provisioningState, "PROVISIONING"); await assert.rejects(cancelCommerce7Claim(owned.owner.id, owned.claim.id), { code: "PROVISIONING" }); }
    finally { release(); }
    await first; assert.equal(blocking.tagCreates, 1);
    await db.commerceRewardRedemption.update({ where: { id: owned.claim.id }, data: { provisioningOwner: "crashed-owner", provisioningStartedAt: new Date(0) } });
    checked = await provisionCommerce7Claim(owned.claim.id, owned.owner.id, deps); assert.equal(checked?.provisioningOwner, "crashed-owner"); assert.equal(blocking.tagCreates, 1);

    // Template-free bearer reward on Postgres: frozen snapshot, minute-aligned window, one coupon, no customer or tag traffic.
    const bearerConfig = { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true };
    const bearerOffer = await offer(5, 5, bearerConfig); await db.brandRewardOffer.update({ where: { id: bearerOffer.id }, data: { discountAmountCents: 1999, minimumSubtotalCents: 5000 } });
    const bearerUser = await user(100, false); const bearerNative = new NativeFixture(connection.externalAccountId);
    const bearerClaims = await Promise.all([1, 2].map(() => reserveCommerce7Claim(bearerUser.id, bearerOffer.id, "template-free-bearer-key", [brand.id])));
    assert.equal(bearerClaims[0].id, bearerClaims[1].id); assert.equal(await db.commerceRewardRedemption.count({ where: { offerId: bearerOffer.id } }), 1);
    assert.deepEqual(bearerClaims[0].rewardConfigSnapshot, { snapshotVersion: 2, eligibilityMode: "ANYONE_WITH_CODE", title: "Reward fixture", minimumSubtotalCents: 5000, appliesTo: "ALL_PRODUCTS", productIds: [], discount: { type: "FIXED_AMOUNT", amountCents: 1999, percentageBasisPoints: null } });
    assert.equal(bearerClaims[0].expiresAt!.getTime() % 60000, 0);
    const bearerDeps = { db, client: () => bearerNative, now: () => new Date(clock += 60000) };
    const bearerIssued = await provisionCommerce7Claim(bearerClaims[0].id, bearerUser.id, bearerDeps);
    assert.equal(bearerIssued?.status, "ISSUED"); assert.equal(bearerNative.couponCreates, 1); assert.equal(bearerNative.customerReads, 0); assert.equal(bearerNative.tagCreates, 0);
    assert.equal(bearerNative.lastPayload?.discount, 1999); assert.equal(bearerNative.lastPayload?.discountType, "Dollar Off"); assert.equal(bearerNative.lastPayload?.dollarOffDiscountApplies, "Once Per Order"); assert.equal(bearerNative.lastPayload?.availableTo, "Everyone"); assert.equal(bearerNative.lastPayload?.appliesTo, "Store"); assert.equal(bearerNative.lastPayload?.cartRequirement, 5000); assert.equal(bearerNative.lastPayload?.cartRequirementType, "Minimum Purchase Amount");
    assert.equal(bearerNative.lastPayload?.endDate, bearerClaims[0].expiresAt!.toISOString());
    await provisionCommerce7Claim(bearerClaims[0].id, bearerUser.id, bearerDeps); assert.equal(bearerNative.couponCreates, 1);
    // A definitive provider rejection refunds once; a lost response keeps the points and never posts twice.
    const rejectedUser = await user(100, false); const rejectedClaim = await reserveCommerce7Claim(rejectedUser.id, bearerOffer.id, "template-free-rejected-key", [brand.id]);
    class RejectingNative extends NativeFixture { async createCoupon(): Promise<never> { this.couponCreates++; throw new Commerce7RewardError("WRITE_REJECTED"); } }
    const rejecting = new RejectingNative(connection.externalAccountId);
    const refunded = await provisionCommerce7Claim(rejectedClaim.id, rejectedUser.id, { db, client: () => rejecting, now: () => new Date(clock += 60000) });
    assert.equal(refunded?.status, "REFUNDED"); assert.equal(refunded?.couponCreateAttempted, false); assert.equal((await db.userPointAccount.findUniqueOrThrow({ where: { userId: rejectedUser.id } })).spendablePoints, 100);
    assert.equal(await db.pointTransaction.count({ where: { userId: rejectedUser.id, type: "REFUND" } }), 1);
    const unverifiedUser = await user(100); const unverifiedOffer = await offer(5, 5, { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: true });
    await assert.rejects(reserveCommerce7Claim(unverifiedUser.id, unverifiedOffer.id, "template-free-claimant-key", [brand.id]), { code: "COUPON_CONTRACT_UNVERIFIED" });
    assert.equal(await db.pointTransaction.count({ where: { userId: unverifiedUser.id } }), 0);

    await db.commerceRewardRedemption.updateMany({ where: { brandId: brand.id }, data: { rewardOrderCheckedAt: new Date(Date.now() + 86400000) } });
    await db.commerceRewardRedemption.update({ where: { id: saga.claim.id }, data: { rewardOrderCheckedAt: null } });
    const paidAt = new Date();
    const paid = await db.commerceOrder.create({ data: { brandId: brand.id, provider: "COMMERCE7", connectionId: connection.id, externalOrderId: "synthetic-paid-order", currencyCode: "CAD", minorUnitExponent: 2, totalMinor: BigInt(1000), netRevenueMinor: BigInt(1000), financialStatus: "PAID", providerUpdatedAt: paidAt, providerCreatedAt: paidAt } });
    const issued = await db.commerceRewardRedemption.findUniqueOrThrow({ where: { id: saga.claim.id } });
    const beforePoints = await db.pointTransaction.count({ where: { userId: saga.owner.id } });
    const orderDeps = { db, fetchOrder: async (request: { tenant: string; externalOrderId: string }) => { assert.equal(request.tenant, connection.externalAccountId); return { id: request.externalOrderId, customerId: "exact-customer", coupons: [{ couponId: issued.externalDiscountId, id: "applied-entry", code: issued.code }], updatedAt: paidAt.toISOString() }; } };
    assert.equal((await reconcileCommerce7RewardOrders(orderDeps)).linked, 1);
    const used = await db.commerceRewardRedemption.findUniqueOrThrow({ where: { id: saga.claim.id } });
    assert.equal(used.status, "USED"); assert.equal(used.canonicalOrderId, paid.id);
    assert.deepEqual(await db.commerceOrder.findUniqueOrThrow({ where: { id: paid.id } }), paid);
    assert.equal(await db.pointTransaction.count({ where: { userId: saga.owner.id } }), beforePoints);

    // A provider failure retains the cursor, but rotates the queue fairly.
    await db.commerceOrder.update({ where: { id: paid.id }, data: { financialStatus: "PAID", totalRefundedMinor: BigInt(0), netRevenueMinor: BigInt(1000), providerUpdatedAt: paidAt } });
    await db.commerceRewardRedemption.update({ where: { id: lostCoupon.claim.id }, data: { rewardOrderCheckedAt: null } });
    const failTime = new Date();
    const failed = await reconcileCommerce7RewardOrders({ db, now: () => failTime, fetchOrder: async () => { throw new Error("synthetic provider outage"); } });
    assert.equal(failed.failed, 1);
    const afterFailure = await db.commerceRewardRedemption.findUniqueOrThrow({ where: { id: lostCoupon.claim.id } });
    assert.equal(afterFailure.rewardOrderCheckedAt?.getTime(), failTime.getTime()); assert.equal(afterFailure.rewardOrderCursor, null);
    const revoked = await db.commerceRewardRedemption.update({ where: { id: lostTag.claim.id }, data: { status: "CANCELLED", provisioningState: "REVOKED", rewardOrderCheckedAt: null } });
    const revokedRaw = { id: paid.externalOrderId, customerId: revoked.providerCustomerId, coupons: [{ couponId: revoked.externalDiscountId, id: "applied-entry", code: revoked.code }], updatedAt: paidAt.toISOString() };
    assert.equal((await reconcileCommerce7RewardOrders({ db, fetchOrder: async () => revokedRaw })).linked, 1);
    const revokedLinked = await db.commerceRewardRedemption.findUniqueOrThrow({ where: { id: revoked.id } });
    assert.equal(revokedLinked.status, "CANCELLED"); assert.equal(revokedLinked.provisioningState, "REVOKED"); assert.equal(revokedLinked.canonicalOrderId, paid.id);
    assert.equal((await reconcileCommerce7RewardOrders(orderDeps)).linked, 0);
    await db.commerceOrder.update({ where: { id: paid.id }, data: { financialStatus: "PARTIALLY_REFUNDED", totalRefundedMinor: BigInt(200), netRevenueMinor: BigInt(800) } });
    assert.equal((await db.commerceRewardRedemption.findUniqueOrThrow({ where: { id: saga.claim.id } })).canonicalOrderId, paid.id);
    assert.equal(await db.pointTransaction.count({ where: { userId: saga.owner.id } }), beforePoints);
  } finally {
    await db.pointTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await db.commerceRewardRedemption.deleteMany({ where: { brandId: brand.id } });
    await db.brandRewardOffer.deleteMany({ where: { brandId: brand.id } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.commerceOrder.deleteMany({ where: { connectionId: connection.id } });
    await db.connectedCommerceProduct.deleteMany({ where: { connectionId: connection.id } });
    await db.commerceConnection.delete({ where: { id: connection.id } }); await db.brand.delete({ where: { id: brand.id } }); await db.$disconnect();
  }
});

test("real Postgres: exclusive access grants once, never charges an already-eligible customer, enforces ownership constraints and one in-flight claim per tag", { skip: !enabled && `Disposable DB opt-in required (${decision.reason})` }, async () => {
  const { default: db } = await import("../src/lib/prisma");
  const { claimCommerce7Reward, reserveCommerce7Claim, provisionCommerce7Claim } = await import("../src/lib/commerce7-rewards");
  const { Commerce7RewardsClient } = await import("../src/lib/commerce/providers/commerce7-rewards-client");
  const TAG = "synthetic-exclusive-tag"; const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const brand = await db.brand.create({ data: { name: "Exclusive fixture", slug: `c7-exclusive-${unique}` } });
  const connection = await db.commerceConnection.create({ data: { brandId: brand.id, provider: "COMMERCE7", status: "CONNECTED", externalAccountId: "synthetic-exclusive-tenant", displayName: "Synthetic store", providerMetadata: { currencyCode: "CAD" } } });
  const userIds: string[] = [];
  async function member(name: string) {
    const row = await db.user.create({ data: { email: `${name}-${unique}@example.test`, password: "synthetic-unused", isEmailVerified: true, emailVerifiedAt: new Date() } }); userIds.push(row.id);
    await db.userPointAccount.create({ data: { userId: row.id, spendablePoints: 1000, lifetimeEarnedPoints: 1000 } }); return row;
  }
  /** Synthetic, stateful tenant with the live semantics: the membership POST is not idempotent. */
  class Tenant extends Commerce7RewardsClient {
    customers: { id: string; email: string; tagIds: string[] }[] = []; grants = 0;
    async customerTag(id: string) { return { id, title: "Rare Members", type: "Manual", objectType: "Customer" }; }
    async productAccess(id: string) { return { id, available: true, security: { availableTo: "Tag", displayOption: null, availableToObjectIds: [TAG] } }; }
    async customer(email: string) { const found = this.customers.find((c) => c.email === email.toLowerCase()); return found ? { id: found.id, emails: [found.email], tagIds: [...found.tagIds] } : null; }
    async customerById(id: string) { const found = this.customers.find((c) => c.id === id)!; return { id: found.id, emails: [found.email], tagIds: [...found.tagIds] }; }
    async assignCustomerTag(customerId: string, tagId: string) { this.grants++; this.customers.find((c) => c.id === customerId)!.tagIds.push(tagId); return { id: `membership-${this.grants}` }; }
  }
  const tenant = new Tenant(connection.externalAccountId);
  const deps = { db, client: () => tenant, now: () => new Date(), backendConfigured: () => true };
  const points = async (userId: string) => (await db.userPointAccount.findUniqueOrThrow({ where: { userId } })).spendablePoints;
  const violation = async (sql: string, constraint: string) => assert.rejects(db.$executeRawUnsafe(sql), (error: Error) => error.message.includes(constraint), constraint);
  try {
    await db.connectedCommerceProduct.create({ data: { brandId: brand.id, connectionId: connection.id, provider: "COMMERCE7", externalId: "rare-wine", externalKey: "rare-wine", title: "Rare wine", productUrl: "", images: [], externalVariantIds: [], providerMetadata: { security: { availableTo: "Tag", displayOption: "Display Product / Show Login", availableToObjectIds: [TAG] } } } });
    const offer = await db.brandRewardOffer.create({ data: { brandId: brand.id, provider: "COMMERCE7", connectionId: connection.id, sourceExternalAccountId: connection.externalAccountId, title: "Rare access", isActive: true, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", appliesTo: "SPECIFIC_PRODUCTS", pointsCost: 100, discountAmountCents: null, currencyCode: "CAD", maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, commerce7Config: { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: false, exclusiveAccess: { productId: "rare-wine", securityAvailableTo: "Tag", securityTagId: TAG, tagTitle: "Rare Members" } }, products: { create: [{ externalProductId: "rare-wine", title: "Rare wine" }] } } });

    const alice = await member("alice"); tenant.customers.push({ id: "c7-alice", email: alice.email, tagIds: [] });
    const granted = await claimCommerce7Reward(alice.id, offer.id, "alice-exclusive-request", [brand.id], deps);
    assert.equal(granted.claim?.status, "ISSUED"); assert.equal(granted.claim?.membershipOwnership, "SQRATCH_GRANTED"); assert.equal(granted.claim?.providerMembershipId, "membership-1");
    assert.equal(granted.claim?.discountAmountCents, null, "Postgres accepts an access-only claim (relaxed discount CHECK)"); assert.equal(tenant.grants, 1); assert.equal(await points(alice.id), 900);
    await provisionCommerce7Claim(granted.claim!.id, alice.id, deps); assert.equal(tenant.grants, 1, "a replay never re-posts");

    const bob = await member("bob"); tenant.customers.push({ id: "c7-bob", email: bob.email, tagIds: [TAG] });
    assert.equal((await claimCommerce7Reward(bob.id, offer.id, "bob-exclusive-request", [brand.id], deps)).alreadyEligible, true);
    assert.equal(await db.commerceRewardRedemption.count({ where: { userId: bob.id } }), 0); assert.equal(await db.pointTransaction.count({ where: { userId: bob.id } }), 0); assert.equal(await points(bob.id), 1000);

    const carol = await member("carol"); tenant.customers.push({ id: "c7-carol", email: carol.email, tagIds: [] });
    const reserved = await reserveCommerce7Claim(carol.id, offer.id, "carol-exclusive-request", [brand.id], deps);
    tenant.customers.find((c) => c.id === "c7-carol")!.tagIds.push(TAG); // granted natively before SQRATCH's grant
    const returned = await provisionCommerce7Claim(reserved.id, carol.id, deps);
    assert.equal(returned?.status, "REFUNDED"); assert.equal(returned?.membershipOwnership, "PRE_EXISTING"); assert.equal(returned?.slotReleased, true); assert.equal(await points(carol.id), 1000); assert.equal(tenant.grants, 1);
    assert.equal((await db.brandRewardOffer.findUniqueOrThrow({ where: { id: offer.id } })).reservedClaimCount, 1, "only Alice's grant consumes capacity");

    // Two concurrent claims for the same tag by one member under real SERIALIZABLE isolation: exactly one reservation and debit.
    await db.brandRewardOffer.update({ where: { id: offer.id }, data: { maxRedemptionsPerUser: 2 } }); // so only the in-flight guard can refuse
    const dave = await member("dave");
    const raced = await Promise.allSettled([reserveCommerce7Claim(dave.id, offer.id, "dave-request-one", [brand.id], deps), reserveCommerce7Claim(dave.id, offer.id, "dave-request-two", [brand.id], deps)]);
    assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1); assert.match(String((raced.find((result) => result.status === "rejected") as PromiseRejectedResult).reason?.code), /CLAIM_IN_PROGRESS|OFFER_CHANGED/);
    assert.equal(await db.commerceRewardRedemption.count({ where: { userId: dave.id } }), 1); assert.equal(await points(dave.id), 900);

    // Ownership is evidence-bound in the database itself.
    const id = granted.claim!.id;
    await violation(`UPDATE "ShopifyRewardRedemption" SET "membershipOwnership" = 'PRE_EXISTING' WHERE "id" = '${id}'`, "reward_c7_membership_owner");
    await violation(`UPDATE "ShopifyRewardRedemption" SET "providerMembershipId" = NULL WHERE "id" = '${id}'`, "reward_c7_membership_owner");
    await violation(`UPDATE "ShopifyRewardRedemption" SET "status" = 'REFUNDED', "slotReleased" = true, "entitlementEverGranted" = false WHERE "id" = '${id}'`, "reward_c7_release_safe");
    await violation(`UPDATE "ShopifyRewardRedemption" SET "membershipOwnership" = NULL, "rewardMode" = 'DISCOUNT', "discountAmountCents" = 100 WHERE "id" = '${id}'`, "reward_c7_membership_write");
    await violation(`UPDATE "ShopifyRewardRedemption" SET "membershipOwnership" = 'SQRATCH_GRANTED', "membershipWriteAttempted" = false, "providerMembershipId" = 'x' WHERE "id" = '${returned!.id}'`, "reward_c7_membership_owner");
    assert.equal((await db.commerceRewardRedemption.findUniqueOrThrow({ where: { id } })).membershipOwnership, "SQRATCH_GRANTED");
  } finally {
    await db.pointTransaction.deleteMany({ where: { userId: { in: userIds } } });
    await db.commerceRewardRedemption.deleteMany({ where: { brandId: brand.id } });
    await db.brandRewardOfferProduct.deleteMany({ where: { offer: { brandId: brand.id } } });
    await db.brandRewardOffer.deleteMany({ where: { brandId: brand.id } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.connectedCommerceProduct.deleteMany({ where: { connectionId: connection.id } });
    await db.commerceConnection.delete({ where: { id: connection.id } }); await db.brand.delete({ where: { id: brand.id } }); await db.$disconnect();
  }
});
