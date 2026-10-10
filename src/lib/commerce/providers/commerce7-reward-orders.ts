import type { CommerceOrder, CommerceRewardRedemption } from "@prisma/client";
import { storedCommerce7Eligibility } from "../../commerce7-reward-eligibility";
import { object } from "./commerce7-rewards-client";
import { fetchCommerce7Order } from "./commerce7-orders";

/**
 * Commerce7's order `coupons[]` lists APPLIED coupons. Live evidence (Order Create for #1007): each entry's `id` is the applied
 * entry's own id, `couponId` is the native coupon's id (what SQRATCH stores as `externalDiscountId`), and the entry also carries
 * the coupon `code`. A claim's coupon is proven used only by exactly one entry whose `couponId` AND code both match; never by
 * the entry id, the code alone, a title, an amount, a product or an email.
 */
type AppliedCoupon = Record<string, unknown>;
function appliedCoupons(raw: Record<string, unknown> | null): AppliedCoupon[] {
  return Array.isArray(raw?.coupons) && raw.coupons.length <= 50 ? raw.coupons.flatMap((entry) => { const coupon = object(entry); return coupon ? [coupon] : []; }) : [];
}
const sameCode = (coupon: AppliedCoupon, claim: CommerceRewardRedemption) => typeof coupon.code === "string" && coupon.code.toUpperCase() === claim.code.toUpperCase();
/** Entries that mention this claim's coupon at all (by native coupon id or by code). Linking needs exactly one, matching both. */
const candidateCoupons = (coupons: AppliedCoupon[], claim: CommerceRewardRedemption) => coupons.filter((coupon) => (!!claim.externalDiscountId && coupon.couponId === claim.externalDiscountId) || sameCode(coupon, claim));
const orderEligible = (order: CommerceOrder) => order.financialStatus === "PAID" && !order.cancelledAt && order.totalMinor !== null && order.totalMinor > BigInt(0);
const orderCurrent = (row: Record<string, unknown> | null, order: CommerceOrder) => !!order.providerUpdatedAt && typeof row?.updatedAt === "string" && Date.parse(row.updatedAt) === order.providerUpdatedAt.getTime();

/** Evidence observation only: never a provider write or a payment inference. */
export function exactCommerce7RewardOrderMatch(raw: unknown, order: CommerceOrder, claim: CommerceRewardRedemption) {
  const row = object(raw);
  const eligibilityMode = storedCommerce7Eligibility(claim.rewardConfigSnapshot, claim.rewardMode);
  if (!eligibilityMode) return false;
  // A legacy claimant-only DISCOUNT coupon is restricted to the pinned customer, so the purchaser must be that customer. An
  // Exclusive Wine Access coupon is a bearer coupon (its customer binding is the Customer Tag), so it is used whoever redeems it.
  if (claim.rewardMode !== "EXCLUSIVE_PRODUCT_ACCESS" && eligibilityMode === "CLAIMANT_ONLY" && (!claim.providerCustomerId || row?.customerId !== claim.providerCustomerId)) return false;
  if (!row || order.provider !== "COMMERCE7" || claim.provider !== "COMMERCE7" || order.brandId !== claim.brandId || order.connectionId !== claim.connectionId || order.externalOrderId !== row.id || !claim.externalDiscountId || !orderEligible(order) || !orderCurrent(row, order) || !Array.isArray(row.coupons) || row.coupons.length > 50) return false;
  if (claim.status !== "ISSUED" && claim.status !== "USED" && claim.status !== "EXPIRED" && !(claim.status === "CANCELLED" && claim.entitlementEverGranted)) return false;
  if ((claim.status === "EXPIRED" || claim.status === "CANCELLED") && (!claim.expiresAt || !order.providerCreatedAt || order.providerCreatedAt > claim.expiresAt)) return false;
  const candidates = candidateCoupons(appliedCoupons(row), claim);
  return candidates.length === 1 && candidates[0].couponId === claim.externalDiscountId && sameCode(candidates[0], claim);
}
/**
 * Why an imported order did or did not prove this claim's coupon was used. Diagnostic only: linking still requires
 * `exactCommerce7RewardOrderMatch`. An entry that mentions the coupon (by id or code) without the exact, unambiguous id + code
 * pair is reported as COUPON_IDENTITY_UNCONFIRMED, never accepted.
 */
export type Commerce7RewardOrderEvidence = "MATCHED" | "ORDER_NOT_ELIGIBLE" | "ORDER_VERSION_STALE" | "COUPON_IDENTITY_UNCONFIRMED" | "NOT_THIS_COUPON";
export function commerce7RewardOrderEvidence(raw: unknown, order: CommerceOrder, claim: CommerceRewardRedemption): Commerce7RewardOrderEvidence {
  if (exactCommerce7RewardOrderMatch(raw, order, claim)) return "MATCHED";
  const row = object(raw);
  if (!candidateCoupons(appliedCoupons(row), claim).length) return "NOT_THIS_COUPON";
  if (!orderEligible(order)) return "ORDER_NOT_ELIGIBLE";
  if (!orderCurrent(row, order)) return "ORDER_VERSION_STALE";
  return "COUPON_IDENTITY_UNCONFIRMED";
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
    // PII-free progress for the Brand (closed STAGE:CODE token on the claim). Undefined keeps the previous reason.
    let diagnostic: string | undefined;
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
        const evidence = commerce7RewardOrderEvidence(raw, order, claim);
        if (evidence !== "MATCHED") { if (evidence !== "NOT_THIS_COUPON") diagnostic = `PURCHASE_CHECK:${evidence}`; continue; }
        // Re-read payment/version inside the transaction: concurrent financial
        // changes cannot turn a stale observation into a recorded purchase.
        await prisma.$transaction(async (tx) => {
          const current = await tx.commerceOrder.findUnique({ where: { id: order.id } });
          if (!current || !exactCommerce7RewardOrderMatch(raw, current, claim)) return;
          // Revocation does not erase a purchase made before the deletion.
          // Keep its closed state while recording the historical purchase.
          const result = await tx.commerceRewardRedemption.updateMany({ where: { id: claim.id, provider: "COMMERCE7", status: claim.status, entitlementEverGranted: true, canonicalOrderId: null, connectionId: current.connectionId, providerCustomerId: claim.providerCustomerId, externalDiscountId: claim.externalDiscountId }, data: { status: claim.status === "CANCELLED" ? "CANCELLED" : "USED", usedAt: current.providerCreatedAt ?? current.providerUpdatedAt, canonicalOrderId: current.id, externalUsageCount: 1,
            // The link is the result of this check: clear the earlier pass's PURCHASE_CHECK reason so it never lingers on a USED claim.
            lastReconcileReason: null, rewardOrderCheckedAt: now, rewardOrderCursor: null } });
          linked += result.count;
        }, { isolationLevel: "Serializable" });
      }
      nextCursor = orders.length === 5 ? orders[orders.length - 1].id : null;
      // A completed pass with no evidence: the coupon's order has not been imported (or used) yet.
      if (!diagnostic && nextCursor === null) diagnostic = "PURCHASE_CHECK:NO_MATCHING_ORDER";
    } catch { failed++; diagnostic = "PURCHASE_CHECK:PROVIDER_UNAVAILABLE"; }
    finally {
      // Failed or disconnected claims must not monopolize the bounded queue.
      // On failure retain the cursor, so the same evidence is retried later.
      await prisma.commerceRewardRedemption.updateMany({ where: { id: claim.id, provider: "COMMERCE7", canonicalOrderId: null, rewardOrderCursor: claim.rewardOrderCursor, rewardOrderCheckedAt: claim.rewardOrderCheckedAt }, data: { rewardOrderCursor: nextCursor, rewardOrderCheckedAt: now, ...(diagnostic ? { lastReconcileReason: diagnostic } : {}) } });
    }
  }
  return { checked, linked, failed };
}
