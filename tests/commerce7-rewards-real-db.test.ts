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
  const { Commerce7RewardsClient, Commerce7RewardError, claimTagTitle } = await import("../src/lib/commerce/providers/commerce7-rewards-client");
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const brand = await db.brand.create({ data: { name: "Reward fixture", slug: `c7-reward-${unique}` } });
  const connection = await db.commerceConnection.create({ data: { brandId: brand.id, provider: "COMMERCE7", status: "CONNECTED", externalAccountId: "synthetic-reward-tenant", displayName: "Synthetic store", providerMetadata: { currencyCode: "CAD" } } });
  const template = { id: "native-template", title: "Template", code: "template", usageLimitType: "Per Store", usageLimit: 1, appliesTo: "Store", appliesToObjectIds: null, productDiscountType: "Dollar Off", productDiscount: 1000, shippingDiscountType: "No Discount", shippingDiscount: null, startDate: "2026-01-01T00:00:00.000Z", endDate: null, status: "Enabled", minimumCartAmount: null, availableTo: "opaque-native-tag-selector", availableToObjectIds: ["native-tag"] };
  const userIds: string[] = []; let userIndex = 0;
  async function user(balance = 1000, verified = true) {
    const index = userIndex++;
    const row = await db.user.create({ data: { email: `reward-${index}-${unique}@example.test`, password: "synthetic-unused", isEmailVerified: verified, emailVerifiedAt: verified ? new Date() : null } }); userIds.push(row.id);
    await db.userPointAccount.create({ data: { userId: row.id, spendablePoints: balance, lifetimeEarnedPoints: balance } }); return row;
  }
  async function offer(cap: number, perUser = 1) {
    return db.brandRewardOffer.create({ data: { brandId: brand.id, provider: "COMMERCE7", connectionId: connection.id, sourceExternalAccountId: connection.externalAccountId, title: "Reward fixture", isActive: true, pointsCost: 100, discountAmountCents: 1000, currencyCode: "CAD", maxTotalRedemptions: cap, maxRedemptionsPerUser: perUser, commerce7Config: { templateCouponId: template.id, template } } });
  }
  try {
    await db.connectedCommerceProduct.create({ data: { brandId: brand.id, connectionId: connection.id, provider: "COMMERCE7", externalId: "rare-wine", externalKey: "rare-wine", title: "Rare wine", productUrl: "", images: [], externalVariantIds: [] } });
    const exclusiveDraft = { title: "Rare wine access", isActive: false, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", discountEnabled: false, discountType: "FIXED_AMOUNT", pointsCost: 100, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, codeValidDays: 30, templateCouponId: null, productIds: ["rare-wine"] };
    const draft = await saveCommerce7Offer(brand.id, exclusiveDraft);
    assert.equal(draft.rewardMode, "EXCLUSIVE_PRODUCT_ACCESS"); assert.equal(draft.discountAmountCents, null);
    await assert.rejects(saveCommerce7Offer(brand.id, { ...exclusiveDraft, isActive: true }), { code: "INVALID_OFFER" });
    await assert.rejects(saveCommerce7Offer(brand.id, { ...exclusiveDraft, productIds: ["foreign-wine"] }), { code: "INVALID_OFFER" });
    class OfferReads extends Commerce7RewardsClient {
      async coupon() { return template; }
      async tag(id: string) { return { id, title: "Native template tag", type: "Manual" as const, objectType: "Customer" as const }; }
    }
    const offerDeps = { db, client: (tenant: string) => new OfferReads(tenant), now: () => new Date() };
    const offerInput = { title: "Real offer service", isActive: true, rewardMode: "DISCOUNT", discountType: "FIXED_AMOUNT", discountAmountCents: 1000, pointsCost: 100, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, codeValidDays: 30, templateCouponId: template.id, productIds: [], brandId: "forged-brand", connectionId: "forged-connection", currencyCode: "USD" };
    const createdOffer = await saveCommerce7Offer(brand.id, offerInput, undefined, offerDeps);
    assert.equal(createdOffer.brandId, brand.id); assert.equal(createdOffer.connectionId, connection.id); assert.equal(createdOffer.currencyCode, "CAD");
    const editedOffer = await saveCommerce7Offer(brand.id, { ...offerInput, isActive: false, discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1500 }, createdOffer.id, offerDeps);
    assert.equal(editedOffer.discountPercentageBasisPoints, 1500); assert.equal(editedOffer.isActive, false);
    await assert.rejects(saveCommerce7Offer(brand.id, offerInput, "foreign-offer", offerDeps), { code: "NOT_FOUND" });
    const capped = await offer(25);
    // SQL constraints are independent of the TypeScript parser.
    await assert.rejects(db.brandRewardOffer.update({ where: { id: capped.id }, data: { maxTotalRedemptions: 0 } }));
    await assert.rejects(db.brandRewardOffer.update({ where: { id: draft.id }, data: { isActive: true } }));
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
    await db.brandRewardOffer.update({ where: { id: retiredOffer.id }, data: { appliesTo: "SPECIFIC_PRODUCTS", commerce7Config: { templateCouponId: template.id, template: { ...template, appliesTo: "opaque-product-selector", appliesToObjectIds: ["retired-product"] } } } });
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
      lastEmail = "";
      eligible = false; tagCreates = 0; couponCreates = 0; loseTagResponse = false; loseCouponResponse = false;
      tagResource: { id: string; title: string; type: "Manual"; objectType: "Customer" } | null = null;
      couponResource: import("../src/lib/commerce/providers/commerce7-rewards-client").NativeCoupon | null = null;
      async customer(email: string) { this.lastEmail = email; return { id: "exact-customer", emails: [email], tagIds: this.eligible && this.tagResource ? [this.tagResource.id] : [] }; }
      async customerById() { return this.customer(this.lastEmail); }
      async tagOnlyForCustomer() { return this.eligible; }
      async findTag() { return this.tagResource; }
      async createTag(id: string) { this.tagCreates++; this.tagResource = { id: `tag-${id}`, title: claimTagTitle(id), type: "Manual", objectType: "Customer" }; if (this.loseTagResponse) throw new Commerce7RewardError("PROVIDER_UNAVAILABLE", true); return this.tagResource; }
      async findCoupon() { return this.couponResource; }
      async createCoupon(payload: import("../src/lib/commerce/providers/commerce7-rewards-client").CouponPayload) { this.couponCreates++; this.couponResource = { id: "exact-native-coupon", ...payload }; if (this.loseCouponResponse) throw new Commerce7RewardError("PROVIDER_UNAVAILABLE", true); return this.couponResource; }
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

    await db.commerceRewardRedemption.updateMany({ where: { brandId: brand.id }, data: { rewardOrderCheckedAt: new Date(Date.now() + 86400000) } });
    await db.commerceRewardRedemption.update({ where: { id: saga.claim.id }, data: { rewardOrderCheckedAt: null } });
    const paidAt = new Date();
    const paid = await db.commerceOrder.create({ data: { brandId: brand.id, provider: "COMMERCE7", connectionId: connection.id, externalOrderId: "synthetic-paid-order", currencyCode: "CAD", minorUnitExponent: 2, totalMinor: BigInt(1000), netRevenueMinor: BigInt(1000), financialStatus: "PAID", providerUpdatedAt: paidAt, providerCreatedAt: paidAt } });
    const issued = await db.commerceRewardRedemption.findUniqueOrThrow({ where: { id: saga.claim.id } });
    const beforePoints = await db.pointTransaction.count({ where: { userId: saga.owner.id } });
    const orderDeps = { db, fetchOrder: async (request: { tenant: string; externalOrderId: string }) => { assert.equal(request.tenant, connection.externalAccountId); return { id: request.externalOrderId, customerId: "exact-customer", coupons: [{ id: issued.externalDiscountId, code: issued.code }], updatedAt: paidAt.toISOString() }; } };
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
    const revokedRaw = { id: paid.externalOrderId, customerId: revoked.providerCustomerId, coupons: [{ id: revoked.externalDiscountId, code: revoked.code }], updatedAt: paidAt.toISOString() };
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
