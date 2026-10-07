import { createHash } from "node:crypto";
import type { BrandRewardOffer, CommerceRewardRedemption } from "@prisma/client";
import { object, parseNativeCoupon, type NativeCoupon } from "./commerce/providers/commerce7-rewards-client";

export const COMMERCE7_REWARD_CAPABILITIES = {
  fixedAmount: true, percentage: true, minimumSubtotal: true,
  productScope: "NATIVE_TEMPLATE" as const, customerRestriction: "MANUAL_CUSTOMER_TAG" as const,
  automaticCustomerTagAssignment: false, exclusiveProductAccess: false,
  createCoupon: true, lookupCoupon: true, revokeCoupon: true,
  usageReconciliation: "EXACT_ORDER_COUPON_AND_CUSTOMER" as const,
};
export class RewardClaimError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}
export function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new RewardClaimError("INVALID_OFFER", message, 400);
}
function integer(value: unknown, min: number, max: number, field: string): number {
  requireValue(typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max, `${field} must be an integer between ${min} and ${max}.`);
  return value;
}
function date(value: unknown, field: string): Date | null {
  if (value == null || value === "") return null;
  requireValue(typeof value === "string" && Number.isFinite(Date.parse(value)), `${field} must be a valid date.`);
  return new Date(value);
}
export function parseCommerce7Offer(value: unknown, currency: string | null) {
  const row = object(value);
  requireValue(row, "An offer is required.");
  requireValue(typeof row.title === "string" && row.title.trim().length > 0 && row.title.trim().length <= 120, "Enter a title of at most 120 characters.");
  requireValue(row.description == null || (typeof row.description === "string" && row.description.length <= 2000), "Description is too long.");
  requireValue(row.isActive === true || row.isActive === false, "Specify whether the offer is active.");
  const rewardMode = row.rewardMode ?? "DISCOUNT";
  requireValue(rewardMode === "DISCOUNT" || rewardMode === "EXCLUSIVE_PRODUCT_ACCESS", "Invalid reward mode.");
  const discountEnabled = rewardMode === "DISCOUNT" || row.discountEnabled === true;
  const discountType = row.discountType ?? "FIXED_AMOUNT";
  requireValue(discountType === "FIXED_AMOUNT" || discountType === "PERCENTAGE", "Choose fixed amount or percentage.");
  requireValue(currency && /^[A-Z]{3}$/.test(currency), "Sync the Commerce7 connection currency before saving rewards.");
  // Commerce7 documents amounts in cents. Do not reinterpret a non-cent currency.
  requireValue(!discountEnabled || ["CAD", "USD", "EUR", "GBP", "AUD", "NZD", "ZAR"].includes(currency), "This currency's Commerce7 monetary contract has not been verified.");
  const discountAmountCents = discountEnabled && discountType === "FIXED_AMOUNT" ? integer(row.discountAmountCents, 1, 2147483647, "Amount in cents") : null;
  const discountPercentageBasisPoints = discountEnabled && discountType === "PERCENTAGE" ? integer(row.discountPercentageBasisPoints, 100, 10000, "Percentage basis points") : null;
  requireValue(!discountEnabled || discountType !== "PERCENTAGE" || discountPercentageBasisPoints! % 100 === 0, "Commerce7 rewards currently support whole percentage values.");
  requireValue(discountType !== "FIXED_AMOUNT" || row.discountPercentageBasisPoints == null, "Remove the percentage from a fixed reward.");
  requireValue(discountType !== "PERCENTAGE" || row.discountAmountCents == null, "Remove the amount from a percentage reward.");
  const claimStartsAt = date(row.claimStartsAt, "Start date"); const claimEndsAt = date(row.claimEndsAt, "End date");
  requireValue(!claimStartsAt || !claimEndsAt || claimEndsAt > claimStartsAt, "End date must follow start date.");
  const maxTotalRedemptions = integer(row.maxTotalRedemptions, 1, rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" ? 25 : 1000, "Total claim limit");
  const maxRedemptionsPerUser = integer(row.maxRedemptionsPerUser, 1, maxTotalRedemptions, "Per-user claim limit");
  const productIds = row.productIds ?? [];
  requireValue(Array.isArray(productIds) && productIds.length <= 50 && productIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100) && new Set(productIds).size === productIds.length, "Select valid, distinct catalog products.");
  requireValue(rewardMode !== "EXCLUSIVE_PRODUCT_ACCESS" || productIds.length === 1, "Exclusive access requires one synchronized product.");
  requireValue(!discountEnabled || (typeof row.templateCouponId === "string" && row.templateCouponId.length > 0 && row.templateCouponId.length <= 100), "Enter a native Commerce7 coupon template ID.");
  requireValue(!row.isActive || rewardMode === "DISCOUNT", "Exclusive access cannot be activated until Commerce7 confirms a writable, customer-bound access contract.");
  return {
    title: row.title.trim(), description: typeof row.description === "string" ? row.description.trim() || null : null,
    isActive: row.isActive, rewardMode: rewardMode as "DISCOUNT" | "EXCLUSIVE_PRODUCT_ACCESS", pointsCost: integer(row.pointsCost, 1, 2147483647, "Points cost"), discountType: discountType as "FIXED_AMOUNT" | "PERCENTAGE",
    discountAmountCents, discountPercentageBasisPoints, currencyCode: currency, claimStartsAt, claimEndsAt,
    maxTotalRedemptions, maxRedemptionsPerUser, codeValidDays: integer(row.codeValidDays, 1, 365, "Validity in days"),
    minimumSubtotalCents: !discountEnabled || row.minimumSubtotalCents == null ? null : integer(row.minimumSubtotalCents, 1, 2147483647, "Minimum subtotal in cents"),
    appliesTo: productIds.length ? "SPECIFIC_PRODUCTS" as const : "ALL_PRODUCTS" as const,
    productIds: productIds as string[], templateCouponId: discountEnabled ? row.templateCouponId as string : null, discountEnabled,
  };
}
export function validateNativeTemplate(template: NativeCoupon, productIds: string[], tagId: string) {
  requireValue(template.availableTo !== "Everyone" && template.availableToObjectIds?.length === 1 && template.availableToObjectIds[0] === tagId, "Template must be restricted to exactly one manual Customer tag.");
  requireValue(template.usageLimitType === "Per Store" && template.usageLimit === 1 && template.shippingDiscountType === "No Discount" && template.shippingDiscount === null, "Template must allow one use per store and no shipping discount.");
  requireValue(productIds.length ? template.appliesTo !== "Store" && JSON.stringify([...(template.appliesToObjectIds ?? [])].sort()) === JSON.stringify([...productIds].sort()) : template.appliesTo === "Store" && !template.appliesToObjectIds?.length, "Native template product scope must exactly match the selected catalog products.");
}
export function parseRewardSnapshot(value: unknown): { template: NativeCoupon; templateCouponId: string; title: string; minimumSubtotalCents: number | null } {
  const row = object(value);
  requireValue(row && typeof row.templateCouponId === "string" && typeof row.title === "string", "Reward configuration needs review.");
  requireValue(row.minimumSubtotalCents === null || (Number.isSafeInteger(row.minimumSubtotalCents) && Number(row.minimumSubtotalCents) > 0), "Invalid reward minimum.");
  return { template: parseNativeCoupon(row.template), templateCouponId: row.templateCouponId, title: row.title, minimumSubtotalCents: row.minimumSubtotalCents as number | null };
}
export function rewardIdempotencyKey(userId: string, offerId: string, key: unknown) {
  requireValue(typeof key === "string" && /^[A-Za-z0-9_-]{16,100}$/.test(key), "Provide a valid claim request key.");
  return `c7-reward:${createHash("sha256").update(JSON.stringify([userId, offerId, key])).digest("hex")}`;
}
export function commerce7OfferAvailable(offer: BrandRewardOffer, total: number, userTotal: number, now = new Date()) {
  return commerce7OfferUnavailableReason(offer, total, userTotal, now) === null;
}
export function commerce7OfferUnavailableReason(offer: BrandRewardOffer, total: number, userTotal: number, now = new Date()) {
  if (!offer.isActive) return { code: "INACTIVE", message: "This reward is no longer open for claims." };
  if (offer.rewardMode !== "DISCOUNT") return { code: "UNSUPPORTED_ACCESS", message: "Exclusive access is awaiting provider setup and cannot be claimed." };
  if (offer.claimStartsAt && offer.claimStartsAt > now) return { code: "NOT_STARTED", message: "This reward's claim window has not started." };
  if (offer.claimEndsAt && offer.claimEndsAt <= now) return { code: "EXPIRED", message: "This reward's claim window has ended." };
  if (offer.maxTotalRedemptions === null || total >= offer.maxTotalRedemptions) return { code: "SOLD_OUT", message: "All claims for this reward have been reserved or issued." };
  if (offer.maxRedemptionsPerUser === null || userTotal >= offer.maxRedemptionsPerUser) return { code: "USER_LIMIT", message: "You have reached this reward's per-user claim limit." };
  return null;
}
export function serializeCommerce7Claim(claim: CommerceRewardRedemption) {
  const expired = claim.status === "ISSUED" && claim.expiresAt !== null && claim.expiresAt <= new Date();
  return { id: claim.id, offerId: claim.offerId, status: expired ? "EXPIRED" : claim.status, provisioningState: claim.provisioningState,
    pointsCost: claim.pointsCost, code: !expired && claim.status === "ISSUED" && claim.provisioningState === "READY" ? claim.code : null,
    issuedAt: claim.issuedAt, expiresAt: claim.expiresAt, usedAt: claim.usedAt,
    canCancel: claim.status === "POINTS_DEBITED" && !claim.couponCreateAttempted && !claim.entitlementEverGranted && !claim.provisioningOwner,
    canRetry: claim.status === "POINTS_DEBITED" && !claim.provisioningOwner && !claim.needsManualReview,
    message: claim.errorMessage, createdAt: claim.createdAt };
}
