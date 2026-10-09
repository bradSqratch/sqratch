import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import type { CommerceOrder, CommerceRewardRedemption } from "@prisma/client";
import { commerce7RewardOrderEvidence, exactCommerce7RewardOrderMatch, reconcileCommerce7RewardOrders } from "../src/lib/commerce/providers/commerce7-reward-orders";
import { commerce7ClaimAccessState, safeClaimDiagnostic, serializeCommerce7Claim } from "../src/lib/commerce7-reward-domain";

/**
 * Coupon USED reconciliation against the live order shape. The operator's #1007 Order Create payload
 * (tests/fixtures/commerce7-rewards/live-order-coupons-1007.json, sanitized) shows each `coupons[]` entry is an APPLIED coupon:
 * `couponId` = the native coupon (SQRATCH's externalDiscountId), `id` = the applied entry, plus the code. A claim is USED only
 * when exactly one entry matches couponId AND code on a paid, current, uncancelled order of the same connection.
 */
const live = JSON.parse(readFileSync(new URL("./fixtures/commerce7-rewards/live-order-coupons-1007.json", import.meta.url), "utf8")).order;
const liveCoupon = live.coupons[0];

// #1006: QA 04 ($5, selected product, Anyone with the code), imported by Custom Range a day after the purchase.
const qa04Code = `SQRA${"0".repeat(28)}0A04`;
const qa04 = (overrides: Partial<CommerceRewardRedemption> = {}) => ({ id: "claim-qa04", userId: "member", brandId: "brand", offerId: "qa04", provider: "COMMERCE7", connectionId: "connection", externalAccountId: "sqratch-inc", providerCustomerId: null, externalDiscountId: "00000000-0000-4000-8000-00000000c004", code: qa04Code, status: "ISSUED", provisioningState: "READY", rewardMode: "DISCOUNT", entitlementEverGranted: true, canonicalOrderId: null, rewardOrderCursor: null, rewardOrderCheckedAt: null, lastReconcileReason: null, expiresAt: new Date("2026-10-15T08:29:00.000Z"), createdAt: new Date("2026-10-08T08:29:13.230Z"), rewardConfigSnapshot: { snapshotVersion: 2, eligibilityMode: "ANYONE_WITH_CODE" }, ...overrides } as unknown as CommerceRewardRedemption);
const order1006 = (overrides: Partial<CommerceOrder> = {}) => ({ id: "order-1006", provider: "COMMERCE7", brandId: "brand", connectionId: "connection", externalOrderId: "native-order-1006", orderNumber: "1006", financialStatus: "PAID", cancelledAt: null, totalMinor: BigInt(7345), providerCreatedAt: new Date("2026-10-08T08:47:06.199Z"), providerUpdatedAt: new Date("2026-10-08T08:50:38.483Z"), createdAt: new Date("2026-10-09T11:56:21.762Z"), ...overrides } as unknown as CommerceOrder);
const native1006 = (coupons: unknown[], updatedAt = "2026-10-08T08:50:38.483Z") => ({ id: "native-order-1006", customerId: "c7-customer", updatedAt, coupons });
const qa04Entry = { couponId: "00000000-0000-4000-8000-00000000c004", id: "00000000-0000-4000-8000-0000000a1006", code: qa04Code, inUse: true, quantityUsed: 1, totalValue: 500 };

// #1007: QA 05 (Exclusive Wine Access + $5 bearer coupon), the live payload's coupon.
const qa05 = (overrides: Partial<CommerceRewardRedemption> = {}) => ({ ...qa04(), id: "claim-qa05", offerId: "qa05", rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", externalDiscountId: liveCoupon.couponId, code: liveCoupon.code, providerCustomerId: "c7-claimant", providerTagId: "tag", membershipOwnership: "SQRATCH_GRANTED", membershipWriteAttempted: true, providerMembershipId: "membership", membershipVerifiedAt: new Date("2026-10-08T09:53:08.264Z"), needsManualReview: false, createdAt: new Date("2026-10-08T09:49:08.559Z"), rewardConfigSnapshot: { snapshotVersion: 3, eligibilityMode: "CLAIMANT_ONLY" }, ...overrides } as unknown as CommerceRewardRedemption);
const order1007 = (overrides: Partial<CommerceOrder> = {}) => order1006({ id: "order-1007", externalOrderId: live.id, orderNumber: "1007", totalMinor: BigInt(live.total), providerCreatedAt: new Date("2026-10-09T10:00:00.000Z"), providerUpdatedAt: new Date("2026-10-09T10:00:05.000Z"), createdAt: new Date("2026-10-09T12:30:00.000Z"), ...overrides } as never);
const native1007 = (coupons: unknown[] = live.coupons, customerId = "c7-claimant") => ({ id: live.id, customerId, updatedAt: "2026-10-09T10:00:05.000Z", coupons });

test("the applied entry's id is not the coupon: only couponId + exact code on a single entry proves use", () => {
  const claim = qa04(); const order = order1006();
  assert.equal(commerce7RewardOrderEvidence(native1006([qa04Entry]), order, claim), "MATCHED");
  assert.equal(commerce7RewardOrderEvidence(native1006([{ ...qa04Entry, code: qa04Code.toLowerCase() }]), order, claim), "MATCHED", "codes are case-insensitive");
  // The earlier (wrong) reader compared the entry id: an entry whose id equals the coupon id but whose couponId differs is not this coupon.
  assert.equal(exactCommerce7RewardOrderMatch(native1006([{ id: qa04Entry.couponId, code: qa04Code }]), order, claim), false);
  assert.equal(commerce7RewardOrderEvidence(native1006([{ id: qa04Entry.couponId, code: qa04Code }]), order, claim), "COUPON_IDENTITY_UNCONFIRMED");
  assert.equal(commerce7RewardOrderEvidence(native1006([{ ...qa04Entry, code: undefined }]), order, claim), "COUPON_IDENTITY_UNCONFIRMED", "couponId without the code");
  assert.equal(commerce7RewardOrderEvidence(native1006([{ ...qa04Entry, couponId: "another-coupon" }]), order, claim), "COUPON_IDENTITY_UNCONFIRMED", "code without the coupon id");
  assert.equal(commerce7RewardOrderEvidence(native1006([qa04Entry, { ...qa04Entry, id: "second-entry" }]), order, claim), "COUPON_IDENTITY_UNCONFIRMED", "two entries are ambiguous");
  assert.equal(commerce7RewardOrderEvidence(native1006([{ ...qa04Entry, couponId: "x", code: "OTHERCODE" }]), order, claim), "NOT_THIS_COUPON");
  assert.equal(commerce7RewardOrderEvidence(native1006([qa04Entry], "2026-10-08T09:00:00.000Z"), order, claim), "ORDER_VERSION_STALE");
  assert.equal(commerce7RewardOrderEvidence(native1006([qa04Entry]), order1006({ financialStatus: "PENDING" } as never), claim), "ORDER_NOT_ELIGIBLE");
  assert.equal(commerce7RewardOrderEvidence(native1006([qa04Entry]), order1006({ cancelledAt: new Date() } as never), claim), "ORDER_NOT_ELIGIBLE");
  assert.equal(exactCommerce7RewardOrderMatch(native1006([qa04Entry]), order1006({ connectionId: "another-connection" } as never), claim), false, "another tenant connection");
  // inUse, amount and other provider fields are never evidence on their own.
  assert.equal(commerce7RewardOrderEvidence(native1006([{ inUse: true, quantityUsed: 1, totalValue: 500 }]), order, claim), "NOT_THIS_COUPON");
});

function fakeDb(options: { claims: CommerceRewardRedemption[]; orders: CommerceOrder[] }) {
  const claims = options.claims.map((claim) => ({ ...claim })) as unknown as Record<string, unknown>[];
  const orders = options.orders;
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => key === "OR" || key === "provider" || (value !== null && typeof value === "object" && !(value instanceof Date)) || row[key] === value);
  const db = {
    commerceRewardRedemption: {
      findMany: async () => claims.filter((claim) => claim.canonicalOrderId === null && ["ISSUED", "EXPIRED", "CANCELLED"].includes(String(claim.status))).sort((a, b) => Number(a.rewardOrderCheckedAt ?? 0) - Number(b.rewardOrderCheckedAt ?? 0)).slice(0, 1).map((claim) => ({ ...claim })),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { const rows = claims.filter((row) => matches(row, where)); rows.forEach((row) => Object.assign(row, data)); return { count: rows.length }; },
    },
    commerceConnection: { findFirst: async () => ({ id: "connection", externalAccountId: "sqratch-inc" }) },
    commerceOrder: {
      // Same ordering and cursor semantics as Prisma: (createdAt, id) ascending, resume after the cursor row, at most `take`.
      findMany: async ({ where, cursor, take }: { where: { createdAt: { gte: Date } }; cursor?: { id: string }; take: number }) => {
        const sorted = orders.filter((order) => order.createdAt >= where.createdAt.gte).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
        const start = cursor ? sorted.findIndex((order) => order.id === cursor.id) + 1 : 0;
        return sorted.slice(start, start + take);
      },
      findUnique: async ({ where }: { where: { id: string } }) => orders.find((order) => order.id === where.id) ?? null,
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
  };
  return { db, claims, orders };
}
const NOW = () => new Date("2026-10-09T13:00:00.000Z");

test("#1006 imported by Custom Range: QA 04 becomes USED once, linked to the order, with the purchase time; a second pass changes nothing", async () => {
  const fake = fakeDb({ claims: [qa04()], orders: [order1006()] }); const fetched: string[] = [];
  const deps = { db: fake.db as never, now: NOW, fetchOrder: async (request: { externalOrderId: string }) => { fetched.push(request.externalOrderId); return native1006([qa04Entry]); } };
  assert.deepEqual(await reconcileCommerce7RewardOrders(deps), { checked: 1, linked: 1, failed: 0 });
  const claim = fake.claims[0];
  assert.equal(claim.status, "USED"); assert.equal(claim.canonicalOrderId, "order-1006"); assert.equal((claim.usedAt as Date).toISOString(), "2026-10-08T08:47:06.199Z", "the order's creation time, not the import time");
  assert.deepEqual(fetched, ["native-order-1006"]);
  assert.deepEqual(await reconcileCommerce7RewardOrders(deps), { checked: 0, linked: 0, failed: 0 }, "a linked claim is never re-linked or double-counted");
  const view = serializeCommerce7Claim({ ...claim, provisioningOwner: null, needsManualReview: false, couponCreateAttempted: true, membershipWriteAttempted: false, membershipVerifiedAt: null, membershipOwnership: null, providerMembershipId: null, pointsCost: 100, issuedAt: new Date(), errorMessage: null } as never);
  assert.equal(view.status, "USED"); assert.equal(view.code, null, "a used coupon's code is never shown again");
});

test("#1007: the Exclusive claim's $5 coupon becomes USED while its Customer Tag access stays granted; no points or membership change", async () => {
  // A bearer coupon: whoever redeems it uses it, so the purchaser need not be the claimant.
  for (const customerId of ["c7-claimant", "another-customer"]) {
    const fake = fakeDb({ claims: [qa05()], orders: [order1007()] });
    const result = await reconcileCommerce7RewardOrders({ db: fake.db as never, now: NOW, fetchOrder: async () => native1007(live.coupons, customerId) });
    assert.equal(result.linked, 1, customerId);
    const claim = fake.claims[0];
    assert.equal(claim.status, "USED"); assert.equal(claim.canonicalOrderId, "order-1007");
    for (const field of ["membershipOwnership", "providerMembershipId", "membershipVerifiedAt", "providerTagId", "providerCustomerId", "entitlementEverGranted"] as const) assert.deepEqual(claim[field], (qa05() as unknown as Record<string, unknown>)[field], field);
    assert.equal(commerce7ClaimAccessState(claim as never), "ACCESS_GRANTED", "coupon consumption never revokes access");
    const view = serializeCommerce7Claim({ ...claim, provisioningOwner: null, couponCreateAttempted: true, pointsCost: 100, issuedAt: new Date(), errorMessage: null } as never);
    assert.equal(view.code, null); assert.equal(view.accessGranted, true); assert.equal(view.status, "USED");
  }
});

test("historical imports are eventually checked: paging past five earlier orders, and an order imported after an exhausted pass", async () => {
  const filler = Array.from({ length: 6 }, (_, i) => order1006({ id: `order-filler-${i}`, externalOrderId: `native-filler-${i}`, createdAt: new Date(`2026-10-08T1${i}:00:00.000Z`) } as never));
  const fake = fakeDb({ claims: [qa04()], orders: [...filler] });
  const fetchOrder = async (request: { externalOrderId: string }) => request.externalOrderId === "native-order-1006" ? native1006([qa04Entry]) : { id: request.externalOrderId, updatedAt: "2026-10-08T08:50:38.483Z", coupons: [] };
  let now = NOW(); const pass = async () => { now = new Date(now.getTime() + 600000); return reconcileCommerce7RewardOrders({ db: fake.db as never, now: () => now, fetchOrder }); };
  await pass(); assert.equal(fake.claims[0].rewardOrderCursor, "order-filler-4", "first page of five");
  await pass(); assert.equal(fake.claims[0].rewardOrderCursor, null, "exhausted: the next pass restarts from the beginning");
  assert.equal(fake.claims[0].lastReconcileReason, "PURCHASE_CHECK:NO_MATCHING_ORDER");
  fake.orders.push(order1006()); // Custom Range imports #1006 later (local createdAt after every earlier order)
  await pass(); assert.equal(fake.claims[0].status, "ISSUED", "still paging the first five");
  await pass(); assert.equal(fake.claims[0].status, "USED"); assert.equal(fake.claims[0].canonicalOrderId, "order-1006");
});

test("unlinked passes leave PII-free reasons; unpaid orders are never fetched; a provider failure keeps the cursor", async () => {
  const missing = fakeDb({ claims: [qa04()], orders: [] });
  await reconcileCommerce7RewardOrders({ db: missing.db as never, now: NOW, fetchOrder: async () => { throw new Error("must not be called"); } });
  assert.equal(missing.claims[0].lastReconcileReason, "PURCHASE_CHECK:NO_MATCHING_ORDER"); assert.equal(safeClaimDiagnostic(String(missing.claims[0].lastReconcileReason)), "PURCHASE_CHECK:NO_MATCHING_ORDER");
  const shape = fakeDb({ claims: [qa04()], orders: [order1006()] });
  await reconcileCommerce7RewardOrders({ db: shape.db as never, now: NOW, fetchOrder: async () => native1006([{ id: qa04Entry.couponId, code: qa04Code }]) });
  assert.equal(shape.claims[0].status, "ISSUED"); assert.equal(shape.claims[0].lastReconcileReason, "PURCHASE_CHECK:COUPON_IDENTITY_UNCONFIRMED");
  const unpaid = fakeDb({ claims: [qa04()], orders: [order1006({ financialStatus: "PENDING" } as never)] }); const fetches: string[] = [];
  await reconcileCommerce7RewardOrders({ db: unpaid.db as never, now: NOW, fetchOrder: async (request: { externalOrderId: string }) => { fetches.push(request.externalOrderId); return {}; } });
  assert.deepEqual(fetches, []); assert.equal(unpaid.claims[0].status, "ISSUED");
  const failing = fakeDb({ claims: [qa04()], orders: [order1006()] });
  const result = await reconcileCommerce7RewardOrders({ db: failing.db as never, now: NOW, fetchOrder: async () => { throw new Error("synthetic provider outage"); } });
  assert.equal(result.failed, 1); assert.equal(failing.claims[0].lastReconcileReason, "PURCHASE_CHECK:PROVIDER_UNAVAILABLE"); assert.equal(failing.claims[0].rewardOrderCursor, null);
});
