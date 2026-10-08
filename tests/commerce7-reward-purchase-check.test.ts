import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommerceOrder, CommerceRewardRedemption } from "@prisma/client";
import { commerce7RewardOrderEvidence, reconcileCommerce7RewardOrders } from "../src/lib/commerce/providers/commerce7-reward-orders";
import { safeClaimDiagnostic, serializeCommerce7Claim } from "../src/lib/commerce7-reward-domain";

/**
 * Coupon USED reconciliation. Production evidence (read-only, 2026-10-08): the four issued QA claims were checked every
 * ~10 minutes but never linked, because the order that used the Chardonnay coupon (#1006) was never imported. These tests
 * pin that a claim becomes USED exactly once from an imported, paid order carrying the exact native coupon identity, and that
 * every unlinked pass leaves a PII-free reason. The populated native `coupons` shape is still unverified, so a code-only or
 * differently keyed entry is reported, never accepted.
 */
const code = `SQRA${"B".repeat(32)}`;
const paidAt = new Date("2026-10-08T08:45:00.000Z");
const claimRow = (overrides: Partial<CommerceRewardRedemption> = {}) => ({ id: "claim", userId: "alice", brandId: "brand", offerId: "offer", provider: "COMMERCE7", connectionId: "connection", externalAccountId: "sqratch-inc", providerCustomerId: null, externalDiscountId: "native-coupon", code, status: "ISSUED", provisioningState: "READY", rewardMode: "DISCOUNT", entitlementEverGranted: true, canonicalOrderId: null, rewardOrderCursor: null, rewardOrderCheckedAt: null, lastReconcileReason: null, expiresAt: new Date("2026-10-15T08:29:00.000Z"), createdAt: new Date("2026-10-08T08:29:13.000Z"), rewardConfigSnapshot: { snapshotVersion: 2, eligibilityMode: "ANYONE_WITH_CODE" }, ...overrides } as unknown as CommerceRewardRedemption);
const orderRow = (overrides: Partial<CommerceOrder> = {}) => ({ id: "order-1006", provider: "COMMERCE7", brandId: "brand", connectionId: "connection", externalOrderId: "native-order-1006", orderNumber: "1006", financialStatus: "PAID", cancelledAt: null, totalMinor: BigInt(6500), providerCreatedAt: paidAt, providerUpdatedAt: paidAt, createdAt: new Date("2026-10-08T10:00:00.000Z"), ...overrides } as unknown as CommerceOrder);
const nativeOrder = (coupons: unknown[], updatedAt = paidAt.toISOString()) => ({ id: "native-order-1006", customerId: "c7-customer", updatedAt, coupons });

test("evidence classification: exact identity matches; a code without confirmed identity or on a stale version is reported, never accepted", () => {
  const claim = claimRow(); const order = orderRow();
  assert.equal(commerce7RewardOrderEvidence(nativeOrder([{ id: "native-coupon", code }]), order, claim), "MATCHED");
  assert.equal(commerce7RewardOrderEvidence(nativeOrder([{ id: "native-coupon", code: code.toLowerCase() }]), order, claim), "MATCHED", "codes are case-insensitive");
  assert.equal(commerce7RewardOrderEvidence(nativeOrder([{ code }]), order, claim), "COUPON_IDENTITY_UNCONFIRMED");
  assert.equal(commerce7RewardOrderEvidence(nativeOrder([{ couponId: "native-coupon", code }]), order, claim), "COUPON_IDENTITY_UNCONFIRMED", "an unverified key is never guessed");
  assert.equal(commerce7RewardOrderEvidence(nativeOrder([{ id: "native-coupon", code }], "2026-10-08T09:00:00.000Z"), order, claim), "ORDER_VERSION_STALE");
  assert.equal(commerce7RewardOrderEvidence(nativeOrder([{ id: "other", code: "OTHERCODE" }]), order, claim), "NOT_THIS_COUPON");
  assert.equal(commerce7RewardOrderEvidence(nativeOrder([]), order, claim), "NOT_THIS_COUPON");
  assert.equal(commerce7RewardOrderEvidence(null, order, claim), "NOT_THIS_COUPON");
  assert.equal(commerce7RewardOrderEvidence(nativeOrder([{ id: "native-coupon", code }]), orderRow({ financialStatus: "PENDING" } as never), claim), "ORDER_NOT_ELIGIBLE", "an unpaid order never marks a coupon used");
  assert.equal(commerce7RewardOrderEvidence(nativeOrder([{ id: "native-coupon", code }]), orderRow({ cancelledAt: paidAt } as never), claim), "ORDER_NOT_ELIGIBLE");
});

function fakeDb(options: { claims: CommerceRewardRedemption[]; orders: CommerceOrder[] }) {
  const claims = options.claims.map((claim) => ({ ...claim })) as unknown as Record<string, unknown>[];
  const writes: Record<string, unknown>[] = [];
  const apply = (row: Record<string, unknown>, data: Record<string, unknown>) => Object.assign(row, data);
  const matches = (row: Record<string, unknown>, where: Record<string, unknown>) => Object.entries(where).every(([key, value]) => key === "OR" || key === "provider" || (value !== null && typeof value === "object" && !(value instanceof Date)) || row[key] === value);
  const db = {
    commerceRewardRedemption: {
      findMany: async () => claims.filter((claim) => claim.canonicalOrderId === null && ["ISSUED", "EXPIRED", "CANCELLED"].includes(String(claim.status))).map((claim) => ({ ...claim })),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { const rows = claims.filter((row) => matches(row, where)); rows.forEach((row) => apply(row, data)); writes.push({ where, data, count: rows.length }); return { count: rows.length }; },
    },
    commerceConnection: { findFirst: async () => ({ id: "connection", externalAccountId: "sqratch-inc" }) },
    commerceOrder: {
      findMany: async ({ where }: { where: { createdAt: { gte: Date } } }) => options.orders.filter((order) => order.createdAt >= where.createdAt.gte),
      findUnique: async ({ where }: { where: { id: string } }) => options.orders.find((order) => order.id === where.id) ?? null,
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work(db),
  };
  return { db, claims, writes };
}

test("a missing imported order (the #1006 case) leaves the claim Ready with a PII-free reason, and never calls the provider", async () => {
  const fake = fakeDb({ claims: [claimRow()], orders: [] }); const fetches: string[] = [];
  const result = await reconcileCommerce7RewardOrders({ db: fake.db as never, now: () => new Date("2026-10-08T11:00:00.000Z"), fetchOrder: async (request: { externalOrderId: string }) => { fetches.push(request.externalOrderId); return {}; } });
  assert.deepEqual(result, { checked: 0, linked: 0, failed: 0 }); assert.deepEqual(fetches, []);
  assert.equal(fake.claims[0].status, "ISSUED"); assert.equal(fake.claims[0].lastReconcileReason, "PURCHASE_CHECK:NO_MATCHING_ORDER");
  assert.equal(safeClaimDiagnostic(String(fake.claims[0].lastReconcileReason)), "PURCHASE_CHECK:NO_MATCHING_ORDER", "shown to the Brand as a closed token");
});

test("once the paid order is imported with the exact native coupon identity, the bearer claim becomes USED once with its order link", async () => {
  const fake = fakeDb({ claims: [claimRow()], orders: [orderRow()] });
  const deps = { db: fake.db as never, now: () => new Date("2026-10-08T11:00:00.000Z"), fetchOrder: async () => nativeOrder([{ id: "native-coupon", code }]) };
  assert.equal((await reconcileCommerce7RewardOrders(deps)).linked, 1);
  assert.equal(fake.claims[0].status, "USED"); assert.equal(fake.claims[0].canonicalOrderId, "order-1006"); assert.equal((fake.claims[0].usedAt as Date).getTime(), paidAt.getTime());
  assert.equal((await reconcileCommerce7RewardOrders(deps)).linked, 0, "a linked claim is never re-linked or double-counted");
  const view = serializeCommerce7Claim({ ...fake.claims[0], provisioningOwner: null, needsManualReview: false, couponCreateAttempted: true, membershipWriteAttempted: false, membershipVerifiedAt: null, membershipOwnership: null, providerMembershipId: null, pointsCost: 100, issuedAt: paidAt, errorMessage: null } as never);
  assert.equal(view.status, "USED"); assert.equal(view.code, null, "a used coupon's code is never shown again");
});

test("a code-only (or differently keyed) order coupon stays unlinked and tells the operator the native coupon shape needs evidence", async () => {
  for (const coupons of [[{ code }], [{ couponId: "native-coupon", code }]]) {
    const fake = fakeDb({ claims: [claimRow()], orders: [orderRow()] });
    const result = await reconcileCommerce7RewardOrders({ db: fake.db as never, now: () => new Date("2026-10-08T11:00:00.000Z"), fetchOrder: async () => nativeOrder(coupons) });
    assert.equal(result.linked, 0); assert.equal(fake.claims[0].status, "ISSUED"); assert.equal(fake.claims[0].lastReconcileReason, "PURCHASE_CHECK:COUPON_IDENTITY_UNCONFIRMED");
  }
});

test("unpaid or cancelled orders are never fetched or linked; a provider failure is recorded without advancing the cursor", async () => {
  const unpaid = fakeDb({ claims: [claimRow()], orders: [orderRow({ financialStatus: "PENDING" } as never), orderRow({ id: "cancelled", cancelledAt: paidAt } as never)] }); const fetches: string[] = [];
  await reconcileCommerce7RewardOrders({ db: unpaid.db as never, now: () => new Date(), fetchOrder: async (request: { externalOrderId: string }) => { fetches.push(request.externalOrderId); return {}; } });
  assert.deepEqual(fetches, []); assert.equal(unpaid.claims[0].status, "ISSUED"); assert.equal(unpaid.claims[0].lastReconcileReason, "PURCHASE_CHECK:NO_MATCHING_ORDER");
  const failing = fakeDb({ claims: [claimRow()], orders: [orderRow()] });
  const result = await reconcileCommerce7RewardOrders({ db: failing.db as never, now: () => new Date(), fetchOrder: async () => { throw new Error("synthetic provider outage"); } });
  assert.equal(result.failed, 1); assert.equal(failing.claims[0].lastReconcileReason, "PURCHASE_CHECK:PROVIDER_UNAVAILABLE"); assert.equal(failing.claims[0].rewardOrderCursor, null);
});
