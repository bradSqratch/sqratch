import type { CommerceOrder, CommerceRewardRedemption } from "@prisma/client";
import { object } from "./commerce7-rewards-client";
import { fetchCommerce7Order } from "./commerce7-orders";

/** Closed reader contract. Public docs show coupons:[] but no populated
 * example. Accept only full native coupon identity (id AND code); unknown
 * representations remain unlinked until an operator supplies a real fixture.
 * This is evidence observation, never a provider write or payment inference. */
export function exactCommerce7RewardOrderMatch(raw: unknown, order: CommerceOrder, claim: CommerceRewardRedemption) {
  const row = object(raw);
  if (!row || order.provider !== "COMMERCE7" || claim.provider !== "COMMERCE7" || order.brandId !== claim.brandId || order.connectionId !== claim.connectionId || order.externalOrderId !== row.id || !claim.providerCustomerId || row.customerId !== claim.providerCustomerId || !claim.externalDiscountId || order.financialStatus !== "PAID" || order.cancelledAt || order.totalMinor === null || order.totalMinor <= BigInt(0) || !order.providerUpdatedAt || typeof row.updatedAt !== "string" || Date.parse(row.updatedAt) !== order.providerUpdatedAt.getTime() || !Array.isArray(row.coupons) || row.coupons.length > 50) return false;
  if (claim.status !== "ISSUED" && claim.status !== "USED" && claim.status !== "EXPIRED" && !(claim.status === "CANCELLED" && claim.entitlementEverGranted)) return false;
  if ((claim.status === "EXPIRED" || claim.status === "CANCELLED") && (!claim.expiresAt || !order.providerCreatedAt || order.providerCreatedAt > claim.expiresAt)) return false;
  const matches = row.coupons.filter((entry) => {
    const coupon = object(entry);
    return coupon?.id === claim.externalDiscountId && typeof coupon.code === "string" && coupon.code.toUpperCase() === claim.code.toUpperCase();
  });
  return matches.length === 1;
}
export type Commerce7RewardOrderDeps = {
  db: typeof import("@/lib/prisma").default;
  fetchOrder: typeof fetchCommerce7Order;
  now: () => Date;
};
export async function reconcileCommerce7RewardOrders(deps: Partial<Commerce7RewardOrderDeps> = {}) {
  const prisma = deps.db ?? (await import("@/lib/prisma")).default;
  const fetchOrder = deps.fetchOrder ?? fetchCommerce7Order;
  const now = deps.now?.() ?? new Date();
  const deadline = Date.now() + 25000;
  // The cursor belongs to the claim. Financial orders and attribution are
  // strictly read-only here. Exhausted scans restart so later payment or
  // backfill can supply evidence that was unavailable on the earlier pass.
  const claims = await prisma.commerceRewardRedemption.findMany({ where: { provider: "COMMERCE7", status: { in: ["ISSUED", "EXPIRED", "CANCELLED"] }, entitlementEverGranted: true, canonicalOrderId: null, externalDiscountId: { not: null }, OR: [{ rewardOrderCheckedAt: null }, { rewardOrderCheckedAt: { lt: new Date(now.getTime() - 300000) } }] }, orderBy: { rewardOrderCheckedAt: { sort: "asc", nulls: "first" } }, take: 1 });
  let linked = 0; let failed = 0; let checked = 0;
  for (const claim of claims) {
    let nextCursor = claim.rewardOrderCursor;
    try {
      const connection = await prisma.commerceConnection.findFirst({ where: { id: claim.connectionId ?? "", brandId: claim.brandId, provider: "COMMERCE7", externalAccountId: claim.externalAccountId, status: "CONNECTED", uninstalledAt: null } });
      if (!connection) continue;
      const orders = await prisma.commerceOrder.findMany({ where: { provider: "COMMERCE7", connectionId: connection.id, brandId: claim.brandId, externalOrderId: { not: null }, createdAt: { gte: claim.createdAt } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }], ...(claim.rewardOrderCursor ? { cursor: { id: claim.rewardOrderCursor }, skip: 1 } : {}), take: 5 });
      for (const order of orders) {
        checked++;
        if (order.financialStatus !== "PAID" || order.cancelledAt) continue;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Reward order read budget exhausted");
        const raw = await fetchOrder({ tenant: connection.externalAccountId, externalOrderId: order.externalOrderId!, signal: AbortSignal.timeout(Math.min(10000, remaining)) });
        if (!exactCommerce7RewardOrderMatch(raw, order, claim)) continue;
        // Re-read payment/version inside the transaction: concurrent financial
        // changes cannot turn a stale observation into a recorded purchase.
        await prisma.$transaction(async (tx) => {
          const current = await tx.commerceOrder.findUnique({ where: { id: order.id } });
          if (!current || !exactCommerce7RewardOrderMatch(raw, current, claim)) return;
          // Revocation does not erase a purchase made before the deletion.
          // Keep its closed state while recording the historical purchase.
          const result = await tx.commerceRewardRedemption.updateMany({ where: { id: claim.id, provider: "COMMERCE7", status: claim.status, entitlementEverGranted: true, canonicalOrderId: null, connectionId: current.connectionId, providerCustomerId: claim.providerCustomerId, externalDiscountId: claim.externalDiscountId }, data: { status: claim.status === "CANCELLED" ? "CANCELLED" : "USED", usedAt: current.providerUpdatedAt, canonicalOrderId: current.id, externalUsageCount: 1 } });
          linked += result.count;
        }, { isolationLevel: "Serializable" });
      }
      nextCursor = orders.length === 5 ? orders[orders.length - 1].id : null;
    } catch { failed++; }
    finally {
      // Failed or disconnected claims must not monopolize the bounded queue.
      // On failure retain the cursor, so the same evidence is retried later.
      await prisma.commerceRewardRedemption.updateMany({ where: { id: claim.id, provider: "COMMERCE7", canonicalOrderId: null, rewardOrderCursor: claim.rewardOrderCursor, rewardOrderCheckedAt: claim.rewardOrderCheckedAt }, data: { rewardOrderCursor: nextCursor, rewardOrderCheckedAt: now } });
    }
  }
  return { checked, linked, failed };
}
