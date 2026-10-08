import { createHash } from "node:crypto";
import type { BrandRewardOffer, CommerceRewardRedemption } from "@prisma/client";
import { storedCommerce7Eligibility, type Commerce7RewardEligibility } from "./commerce7-reward-eligibility";
import { COMMERCE7_COUPON_CONTRACT, commerce7CouponSupport, isCouponBranchSupported, resolveCouponScope, type Commerce7CouponAppliesTo, type CouponContract, type CouponScopeResult } from "./commerce7-coupon-contract";
import { object, parseNativeCoupon, type NativeCoupon, type RewardCouponTerms } from "./commerce/providers/commerce7-rewards-client";

/**
 * `automaticCustomerTagAssignment` / `exclusiveProductAccess`: Exclusive Wine Access grants the merchant's EXISTING Manual
 * Customer Tag through the live-proven POST /v1/tag-x-object/customer and verifies it with GET /v1/customer/{id}.
 * Claimant-only discount coupons still rely on manual CRM assignment of their per-claim tag.
 */
export const COMMERCE7_REWARD_CAPABILITIES = {
  fixedAmount: true, percentage: true, minimumSubtotal: true,
  productScope: "NATIVE_COUPON" as const, customerRestriction: "OPTIONAL_MANUAL_CUSTOMER_TAG" as const,
  automaticCustomerTagAssignment: true, exclusiveProductAccess: true,
  createCoupon: true, lookupCoupon: true, revokeCoupon: true,
  usageReconciliation: "EXACT_ORDER_COUPON_WITH_ELIGIBILITY_CHECK" as const,
};
const REVIEW_MESSAGE = "Reward configuration needs review.";
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
  requireValue(row.eligibilityMode === undefined || row.eligibilityMode === "ANYONE_WITH_CODE" || row.eligibilityMode === "CLAIMANT_ONLY", "Choose a valid reward eligibility mode.");
  const eligibilityMode: Commerce7RewardEligibility = rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" ? "CLAIMANT_ONLY" : row.eligibilityMode ?? "ANYONE_WITH_CODE";
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
  const appliesTo = rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" ? "SPECIFIC_PRODUCTS" : row.appliesTo ?? ((Array.isArray(row.productIds) && row.productIds.length) ? "SPECIFIC_PRODUCTS" : "ALL_PRODUCTS");
  requireValue(appliesTo === "ALL_PRODUCTS" || appliesTo === "SPECIFIC_PRODUCTS", "Choose all products or selected products.");
  const productIds = appliesTo === "ALL_PRODUCTS" ? [] : row.productIds ?? [];
  requireValue(Array.isArray(productIds) && productIds.length <= 50 && productIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100) && new Set(productIds).size === productIds.length, "Select valid, distinct catalog products.");
  requireValue(appliesTo !== "SPECIFIC_PRODUCTS" || productIds.length > 0, "Select at least one product.");
  requireValue(rewardMode !== "EXCLUSIVE_PRODUCT_ACCESS" || productIds.length === 1, "Exclusive access requires one synchronized product.");
  // The one Customer Tag SQRATCH will grant. Optional on input: the server defaults it only for a single-tag product.
  const exclusiveTagId = rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" && row.exclusiveTagId != null && row.exclusiveTagId !== "" ? row.exclusiveTagId : null;
  requireValue(exclusiveTagId === null || (typeof exclusiveTagId === "string" && exclusiveTagId.length <= 100 && exclusiveTagId.trim() === exclusiveTagId), "Choose a valid Customer Tag.");
  return {
    title: row.title.trim(), description: typeof row.description === "string" ? row.description.trim() || null : null,
    isActive: row.isActive, rewardMode: rewardMode as "DISCOUNT" | "EXCLUSIVE_PRODUCT_ACCESS", pointsCost: integer(row.pointsCost, 1, 2147483647, "Points cost"), discountType: discountType as "FIXED_AMOUNT" | "PERCENTAGE",
    discountAmountCents, discountPercentageBasisPoints, currencyCode: currency, claimStartsAt, claimEndsAt,
    maxTotalRedemptions, maxRedemptionsPerUser, codeValidDays: integer(row.codeValidDays, 1, 365, "Validity in days"),
    minimumSubtotalCents: !discountEnabled || row.minimumSubtotalCents == null ? null : integer(row.minimumSubtotalCents, 1, 2147483647, "Minimum subtotal in cents"),
    appliesTo: appliesTo as "SPECIFIC_PRODUCTS" | "ALL_PRODUCTS", eligibilityMode,
    productIds: productIds as string[], discountEnabled, exclusiveTagId: exclusiveTagId as string | null,
  };
}
/** Pre-refinement offers/claims embed the merchant's native template. It is only ever validated here, never fetched or required. */
export function validateLegacyNativeTemplate(template: NativeCoupon, productIds: string[], tagId: string | null, eligibilityMode: Commerce7RewardEligibility = "CLAIMANT_ONLY") {
  const { usageLimitType, usageLimit, readNoShippingDiscount: shippingDiscountType, appliesTo, availableTo } = COMMERCE7_COUPON_CONTRACT;
  const everyone = availableTo.ANYONE_WITH_CODE; const store = appliesTo.ALL_PRODUCTS;
  if (eligibilityMode === "ANYONE_WITH_CODE") requireValue(template.availableTo === everyone && !template.availableToObjectIds?.length, REVIEW_MESSAGE);
  else requireValue(template.availableTo !== everyone && template.availableToObjectIds?.length === 1 && template.availableToObjectIds[0] === tagId, REVIEW_MESSAGE);
  requireValue(template.usageLimitType === usageLimitType && template.usageLimit === usageLimit && (template.shippingDiscountType ?? shippingDiscountType) === shippingDiscountType && template.shippingDiscount === null, REVIEW_MESSAGE);
  requireValue(productIds.length ? template.appliesTo !== store && JSON.stringify([...(template.appliesToObjectIds ?? [])].sort()) === JSON.stringify([...productIds].sort()) : template.appliesTo === store && !template.appliesToObjectIds?.length, REVIEW_MESSAGE);
}
export type Commerce7RewardDiscount = { type: "FIXED_AMOUNT" | "PERCENTAGE"; amountCents: number | null; percentageBasisPoints: number | null };
/** Frozen at reservation. Everything POST /coupon needs, so issuance never reads a provider template. */
export type Commerce7RewardSnapshot = {
  eligibilityMode: Commerce7RewardEligibility; title: string; minimumSubtotalCents: number | null;
  appliesTo: Commerce7CouponAppliesTo; productIds: string[];
  /** Null only on pre-refinement snapshots, whose discount terms live in the claim columns. */
  discount: Commerce7RewardDiscount | null;
  /** Observed native enums for a branch the contract has not verified. Null when the contract covers the branch. */
  legacyTemplate: NativeCoupon | null;
  /** Exclusive Wine Access (snapshotVersion 3): the one product and the merchant's Manual Customer Tag this claim grants. */
  exclusiveAccess?: Commerce7ExclusiveSnapshot | null;
};
export type Commerce7ExclusiveSnapshot = { productId: string; tagId: string };
function reviewNeeded(message = REVIEW_MESSAGE): never { throw new RewardClaimError("INVALID_OFFER", message, 400); }
function legacyTemplate(value: unknown, eligibilityMode: Commerce7RewardEligibility, productIds: string[]): NativeCoupon {
  let template: NativeCoupon;
  try { template = parseNativeCoupon(value); } catch { return reviewNeeded(); }
  validateLegacyNativeTemplate(template, productIds, template.availableToObjectIds?.[0] ?? null, eligibilityMode);
  return template;
}
function snapshotDiscount(value: unknown): Commerce7RewardDiscount {
  const row = object(value);
  if (!row || (row.type !== "FIXED_AMOUNT" && row.type !== "PERCENTAGE")) return reviewNeeded();
  const amount = row.amountCents; const basis = row.percentageBasisPoints;
  const fixed = row.type === "FIXED_AMOUNT" && typeof amount === "number" && Number.isSafeInteger(amount) && amount >= 1 && amount <= 2147483647 && basis === null;
  const percentage = row.type === "PERCENTAGE" && amount === null && typeof basis === "number" && Number.isSafeInteger(basis) && basis >= 100 && basis <= 10000 && basis % 100 === 0;
  if (!fixed && !percentage) return reviewNeeded();
  return { type: row.type, amountCents: amount as number | null, percentageBasisPoints: basis as number | null };
}
export function parseRewardSnapshot(value: unknown): Commerce7RewardSnapshot {
  const row = object(value);
  requireValue(row && typeof row.title === "string", "Reward configuration needs review.");
  requireValue(row.minimumSubtotalCents === null || (Number.isSafeInteger(row.minimumSubtotalCents) && Number(row.minimumSubtotalCents) > 0), "Invalid reward minimum.");
  const eligibilityMode = storedCommerce7Eligibility(row);
  requireValue(eligibilityMode, "Reward eligibility configuration needs review.");
  const common = { eligibilityMode, title: row.title, minimumSubtotalCents: row.minimumSubtotalCents as number | null };
  if (row.snapshotVersion === undefined) {
    // Pre-refinement shape: scope and eligibility are read from the embedded native template.
    requireValue(typeof row.templateCouponId === "string", "Reward configuration needs review.");
    let template: NativeCoupon;
    try { template = parseNativeCoupon(row.template); } catch { return reviewNeeded(); }
    const storeScope = template.appliesTo === COMMERCE7_COUPON_CONTRACT.appliesTo.ALL_PRODUCTS;
    const productIds = storeScope ? [] : template.appliesToObjectIds ?? [];
    validateLegacyNativeTemplate(template, productIds, template.availableToObjectIds?.[0] ?? null, eligibilityMode);
    return { ...common, appliesTo: storeScope ? "ALL_PRODUCTS" : "SPECIFIC_PRODUCTS", productIds, discount: null, legacyTemplate: template };
  }
  if (row.snapshotVersion === 3) {
    // Exclusive access: always customer-bound, exactly the one frozen product, optional discount, never a legacy template.
    const access = object(row.exclusiveAccess);
    const productIds = row.productIds;
    requireValue(access && typeof access.productId === "string" && access.productId.length > 0 && access.productId.length <= 100 && typeof access.tagId === "string" && access.tagId.length > 0 && access.tagId.length <= 100, REVIEW_MESSAGE);
    requireValue(eligibilityMode === "CLAIMANT_ONLY" && row.appliesTo === "SPECIFIC_PRODUCTS" && Array.isArray(productIds) && productIds.length === 1 && productIds[0] === access.productId && row.legacyTemplate === undefined, REVIEW_MESSAGE);
    const discount = row.discount === null ? null : snapshotDiscount(row.discount);
    requireValue(discount || row.minimumSubtotalCents === null, REVIEW_MESSAGE);
    return { ...common, appliesTo: "SPECIFIC_PRODUCTS", productIds: [access.productId as string], discount, legacyTemplate: null, exclusiveAccess: { productId: access.productId as string, tagId: access.tagId as string } };
  }
  requireValue(row.snapshotVersion === 2, "Reward configuration needs review.");
  requireValue(row.appliesTo === "ALL_PRODUCTS" || row.appliesTo === "SPECIFIC_PRODUCTS", "Reward configuration needs review.");
  const productIds = row.productIds;
  requireValue(Array.isArray(productIds) && productIds.every((id) => typeof id === "string" && id.length > 0) && new Set(productIds).size === productIds.length && (row.appliesTo === "ALL_PRODUCTS" ? productIds.length === 0 : productIds.length >= 1 && productIds.length <= 50), "Reward configuration needs review.");
  return { ...common, appliesTo: row.appliesTo, productIds: productIds as string[], discount: snapshotDiscount(row.discount), legacyTemplate: row.legacyTemplate == null ? null : legacyTemplate(row.legacyTemplate, eligibilityMode, productIds as string[]) };
}
export function serializeRewardSnapshot(snapshot: Commerce7RewardSnapshot) {
  const access = snapshot.exclusiveAccess;
  if (access) {
    requireValue(snapshot.eligibilityMode === "CLAIMANT_ONLY" && snapshot.appliesTo === "SPECIFIC_PRODUCTS" && snapshot.productIds.length === 1 && snapshot.productIds[0] === access.productId && !snapshot.legacyTemplate && (snapshot.discount || snapshot.minimumSubtotalCents === null), REVIEW_MESSAGE);
    return { snapshotVersion: 3, eligibilityMode: snapshot.eligibilityMode, title: snapshot.title, minimumSubtotalCents: snapshot.minimumSubtotalCents, appliesTo: snapshot.appliesTo, productIds: snapshot.productIds, discount: snapshot.discount, exclusiveAccess: { productId: access.productId, tagId: access.tagId } };
  }
  requireValue(snapshot.discount, "Reward configuration needs review.");
  return { snapshotVersion: 2, eligibilityMode: snapshot.eligibilityMode, title: snapshot.title, minimumSubtotalCents: snapshot.minimumSubtotalCents, appliesTo: snapshot.appliesTo, productIds: snapshot.productIds, discount: snapshot.discount, ...(snapshot.legacyTemplate ? { legacyTemplate: snapshot.legacyTemplate } : {}) };
}
type SnapshotOffer = Pick<BrandRewardOffer, "title" | "minimumSubtotalCents" | "appliesTo" | "discountType" | "discountAmountCents" | "discountPercentageBasisPoints"> & { rewardMode?: string };
/** Freeze an offer into a claim snapshot. A stored template is ignored where the contract is verified and kept (validated) where it is the only evidence. */
export function buildRewardSnapshot(offer: SnapshotOffer, config: Record<string, unknown>, productIds: readonly string[], contract: CouponContract = COMMERCE7_COUPON_CONTRACT): Commerce7RewardSnapshot {
  if (offer.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS") {
    const frozen = frozenExclusiveAccess(config);
    requireValue(frozen && productIds.length === 1 && productIds[0] === frozen.productId, REVIEW_MESSAGE);
    const discountEnabled = config.discountEnabled === true;
    return parseRewardSnapshot(serializeRewardSnapshot({
      eligibilityMode: "CLAIMANT_ONLY", title: offer.title, minimumSubtotalCents: discountEnabled ? offer.minimumSubtotalCents : null, appliesTo: "SPECIFIC_PRODUCTS", productIds: [frozen.productId],
      discount: discountEnabled ? { type: offer.discountType as "FIXED_AMOUNT" | "PERCENTAGE", amountCents: offer.discountAmountCents, percentageBasisPoints: offer.discountPercentageBasisPoints } : null,
      legacyTemplate: null, exclusiveAccess: { productId: frozen.productId, tagId: frozen.tagId },
    }));
  }
  const eligibilityMode = storedCommerce7Eligibility(config);
  requireValue(eligibilityMode, "Reward eligibility configuration needs review.");
  const appliesTo = offer.appliesTo as Commerce7CouponAppliesTo;
  const keepTemplate = !isCouponBranchSupported(eligibilityMode, appliesTo, contract) && config.template != null;
  return parseRewardSnapshot(serializeRewardSnapshot({
    eligibilityMode, title: offer.title, minimumSubtotalCents: offer.minimumSubtotalCents, appliesTo,
    productIds: appliesTo === "ALL_PRODUCTS" ? [] : [...productIds].sort(),
    discount: { type: offer.discountType as "FIXED_AMOUNT" | "PERCENTAGE", amountCents: offer.discountAmountCents, percentageBasisPoints: offer.discountPercentageBasisPoints },
    legacyTemplate: keepTemplate ? config.template as NativeCoupon : null,
  }));
}
/** On edit: keep a stored merchant template only while it is still valid for the edited eligibility and scope. Never required, never fetched. */
export function retainLegacyTemplate(config: unknown, eligibilityMode: Commerce7RewardEligibility, productIds: string[]): { templateCouponId: string; template: NativeCoupon } | null {
  const row = object(config);
  if (!row || typeof row.templateCouponId !== "string" || row.template == null) return null;
  try { return { templateCouponId: row.templateCouponId, template: legacyTemplate(row.template, eligibilityMode, productIds) }; } catch { return null; }
}
export function commerce7SnapshotIssuable(snapshot: Commerce7RewardSnapshot, contract: CouponContract = COMMERCE7_COUPON_CONTRACT) {
  if (snapshot.exclusiveAccess) return !snapshot.discount || isCouponBranchSupported(EXCLUSIVE_COUPON_ELIGIBILITY, "SPECIFIC_PRODUCTS", contract);
  return isCouponBranchSupported(snapshot.eligibilityMode, snapshot.appliesTo, contract) || snapshot.legacyTemplate !== null;
}
/** Contract first; a legacy snapshot's observed enums only for a branch the contract has no value for. */
export function couponScopeForSnapshot(snapshot: Commerce7RewardSnapshot, claimTagId: string | null, contract: CouponContract = COMMERCE7_COUPON_CONTRACT): CouponScopeResult {
  // The optional exclusive discount is a single-use code limited to the exclusive product. It uses the verified bearer
  // eligibility: a Customer-tag restricted Coupon value is unproven, and access itself comes from the tag membership.
  if (snapshot.exclusiveAccess) return resolveCouponScope({ eligibilityMode: EXCLUSIVE_COUPON_ELIGIBILITY, appliesTo: "SPECIFIC_PRODUCTS", productIds: [snapshot.exclusiveAccess.productId], customerTagId: null }, contract);
  const resolved = resolveCouponScope({ eligibilityMode: snapshot.eligibilityMode, appliesTo: snapshot.appliesTo, productIds: snapshot.productIds, customerTagId: claimTagId }, contract);
  const template = snapshot.legacyTemplate;
  if (resolved.ok || !template || resolved.unsupported === "INVALID_INPUT") return resolved;
  if (snapshot.eligibilityMode === "CLAIMANT_ONLY" && !claimTagId) return { ok: false, unsupported: "INVALID_INPUT" };
  return { ok: true, scope: { appliesTo: template.appliesTo, appliesToObjectIds: template.appliesToObjectIds ? [...template.appliesToObjectIds].sort() : null, availableTo: template.availableTo, availableToObjectIds: snapshot.eligibilityMode === "CLAIMANT_ONLY" ? [claimTagId!] : template.availableToObjectIds } };
}
/** Discount terms from the snapshot, which must agree with the claim's immutable columns. */
export function couponTermsForClaim(snapshot: Commerce7RewardSnapshot, claim: Pick<CommerceRewardRedemption, "discountType" | "discountAmountCents" | "discountPercentageBasisPoints">): RewardCouponTerms {
  const columns = { type: claim.discountType, amountCents: claim.discountAmountCents, percentageBasisPoints: claim.discountPercentageBasisPoints };
  if (columns.type !== "FIXED_AMOUNT" && columns.type !== "PERCENTAGE") return reviewNeeded();
  const frozen = snapshot.discount;
  if (frozen && (frozen.type !== columns.type || frozen.amountCents !== columns.amountCents || frozen.percentageBasisPoints !== columns.percentageBasisPoints)) throw new RewardClaimError("SNAPSHOT_MISMATCH", "The reward's frozen terms differ from the claim. The store must review this claim.");
  const discount = frozen ?? columns as Commerce7RewardDiscount;
  return { title: snapshot.title, discountType: discount.type, discountAmountCents: discount.amountCents, discountPercentageBasisPoints: discount.percentageBasisPoints, minimumSubtotalCents: snapshot.minimumSubtotalCents };
}
/** Brand-facing view of stored config. Never exposes native template IDs or bodies, and never throws on historical rows. */
export function serializeBrandCommerce7Config(config: unknown, rewardMode?: string) {
  const row = object(config);
  const exclusiveTagTitle = rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" ? frozenExclusiveAccess(config)?.tagTitle ?? null : undefined;
  return { eligibilityMode: storedCommerce7Eligibility(config, rewardMode), discountEnabled: typeof row?.discountEnabled === "boolean" ? row.discountEnabled : undefined, ...(exclusiveTagTitle !== undefined ? { exclusiveTagTitle } : {}) };
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
  if (offer.rewardMode !== "DISCOUNT" && offer.rewardMode !== "EXCLUSIVE_PRODUCT_ACCESS") return { code: "UNSUPPORTED_ACCESS", message: "This reward type cannot be claimed." };
  if (offer.claimStartsAt && offer.claimStartsAt > now) return { code: "NOT_STARTED", message: "This reward's claim window has not started." };
  if (offer.claimEndsAt && offer.claimEndsAt <= now) return { code: "EXPIRED", message: "This reward's claim window has ended." };
  if (offer.maxTotalRedemptions === null || total >= offer.maxTotalRedemptions) return { code: "SOLD_OUT", message: "All claims for this reward have been reserved or issued." };
  if (offer.maxRedemptionsPerUser === null || userTotal >= offer.maxRedemptionsPerUser) return { code: "USER_LIMIT", message: "You have reached this reward's per-user claim limit." };
  return null;
}
export type Commerce7AccessState = "ACCESS_GRANTED" | "ALREADY_ELIGIBLE" | "WAITING_FOR_CUSTOMER" | "CONFIRMATION_PENDING" | "PROCESSING" | "MANUAL_REVIEW" | "FAILED";
type AccessClaim = Pick<CommerceRewardRedemption, "rewardMode" | "status" | "provisioningState" | "needsManualReview" | "membershipOwnership" | "membershipWriteAttempted" | "providerMembershipId" | "membershipVerifiedAt" | "lastReconcileReason">;
/** The customer-facing state of an Exclusive Wine Access claim, from durable claim facts only. Null for discount claims. */
export function commerce7ClaimAccessState(claim: AccessClaim): Commerce7AccessState | null {
  if (claim.rewardMode !== "EXCLUSIVE_PRODUCT_ACCESS") return null;
  if (claim.status === "REFUNDED") return claim.membershipOwnership === "PRE_EXISTING" ? "ALREADY_ELIGIBLE" : "FAILED";
  if (claim.status === "ISSUED" || claim.status === "USED" || claim.status === "EXPIRED") return "ACCESS_GRANTED";
  if (claim.status !== "POINTS_DEBITED") return "FAILED";
  if (claim.needsManualReview || claim.provisioningState === "MANUAL_REVIEW") return "MANUAL_REVIEW";
  if (claim.provisioningState === "AWAITING_CUSTOMER") return "WAITING_FOR_CUSTOMER";
  if (claim.membershipWriteAttempted && claim.providerMembershipId && !claim.membershipVerifiedAt) return "CONFIRMATION_PENDING";
  return "PROCESSING";
}
/** True while no native resource or entitlement can exist for this claim, so returning its points is safe. */
export function commerce7ClaimRefundable(claim: Pick<CommerceRewardRedemption, "status" | "couponCreateAttempted" | "entitlementEverGranted" | "membershipWriteAttempted">) {
  return claim.status === "POINTS_DEBITED" && !claim.couponCreateAttempted && !claim.entitlementEverGranted && !claim.membershipWriteAttempted;
}
export function serializeCommerce7Claim(claim: CommerceRewardRedemption) {
  const eligibilityMode = storedCommerce7Eligibility(claim.rewardConfigSnapshot, claim.rewardMode);
  const exclusive = claim.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS";
  // Validity limits a coupon. Access-only exclusive claims carry no coupon, and their Commerce7 access does not expire here.
  const hasCoupon = !exclusive || claim.externalDiscountId !== null;
  const expired = hasCoupon && claim.status === "ISSUED" && claim.expiresAt !== null && claim.expiresAt <= new Date();
  return { eligibilityMode, rewardMode: claim.rewardMode, id: claim.id, offerId: claim.offerId, status: expired ? "EXPIRED" : claim.status, provisioningState: claim.provisioningState,
    pointsCost: claim.pointsCost, code: eligibilityMode && hasCoupon && !expired && claim.status === "ISSUED" && claim.provisioningState === "READY" ? claim.code : null,
    issuedAt: claim.issuedAt, expiresAt: hasCoupon ? claim.expiresAt : null, usedAt: claim.usedAt,
    accessState: commerce7ClaimAccessState(claim), accessGranted: exclusive && claim.membershipVerifiedAt !== null && claim.status !== "REFUNDED",
    canCancel: commerce7ClaimRefundable(claim) && !claim.provisioningOwner,
    canRetry: claim.status === "POINTS_DEBITED" && !claim.provisioningOwner && !claim.needsManualReview,
    message: claim.errorMessage, createdAt: claim.createdAt };
}
/** What the Brand UI may offer. `couponContract` tells it which eligibility/scope choices can go live; nothing about provider objects. */
export function commerce7RewardReadiness(backendConfigured: boolean) {
  return {
    backendConfigured, manualCustomerTagAssignmentRequiredFor: "CLAIMANT_ONLY" as const, eligibilityModes: ["ANYONE_WITH_CODE", "CLAIMANT_ONLY"] as const,
    exclusiveAccessSupported: true, exclusiveMultiTagAccessVerified: COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT.multiTagAccessVerified, couponContract: commerce7CouponSupport(), permissions: ["Coupon: Full", "Tag: Full", "Customer: Read", "Product: Read", "Order: Read"],
  };
}
/** Operators see a closed STAGE:CODE token, never free-form provider text. */
export function safeClaimDiagnostic(value: string | null | undefined) {
  return typeof value === "string" && /^[A-Z_]{3,40}(:[A-Z_]{3,40})?$/.test(value) ? value : null;
}
/** The offer's stored terms in the shape the editor submits, so Enable re-runs exactly the validators a save would. */
export function storedCommerce7OfferInput(offer: BrandRewardOffer, productIds: string[]) {
  const config = object(offer.commerce7Config);
  return {
    title: offer.title, description: offer.description, isActive: true, rewardMode: offer.rewardMode, pointsCost: offer.pointsCost,
    discountType: offer.discountType, discountAmountCents: offer.discountAmountCents, discountPercentageBasisPoints: offer.discountPercentageBasisPoints,
    minimumSubtotalCents: offer.minimumSubtotalCents, claimStartsAt: offer.claimStartsAt?.toISOString() ?? null, claimEndsAt: offer.claimEndsAt?.toISOString() ?? null,
    maxTotalRedemptions: offer.maxTotalRedemptions, maxRedemptionsPerUser: offer.maxRedemptionsPerUser, codeValidDays: offer.codeValidDays,
    appliesTo: offer.appliesTo, productIds, eligibilityMode: storedCommerce7Eligibility(config, offer.rewardMode),
    discountEnabled: typeof config?.discountEnabled === "boolean" ? config.discountEnabled : undefined,
    exclusiveTagId: offer.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" ? frozenExclusiveAccess(config)?.tagId ?? null : null,
  };
}
/** The Brand-facing offer after a write: the stored row without its raw provider config. */
export function serializeCommerce7OfferResponse<T extends { commerce7Config: unknown; rewardMode: string }>(offer: T) {
  return { ...offer, commerce7Config: serializeBrandCommerce7Config(offer.commerce7Config, offer.rewardMode) };
}
/**
 * A claim that provably never produced a provider object or entitlement and holds no points or capacity: refunded and
 * closed, slot released, never granted, no coupon attempt left open (a definitive rejection clears it), no coupon ID,
 * no review, no owner, no purchase. Used as a POSITIVE equality filter so a null or unknown value fails closed
 * (a SQL NOT over nullable columns such as provisioningState would silently treat NULL as safe).
 */
export const COMMERCE7_EDIT_SAFE_CLAIM = {
  status: "REFUNDED", provisioningState: "FAILED_FINAL", slotReleased: true, entitlementEverGranted: false, couponCreateAttempted: false, membershipWriteAttempted: false,
  needsManualReview: false, provisioningOwner: null, externalDiscountId: null, canonicalOrderId: null, usedAt: null,
} as const;
export function commerce7ClaimAllowsOfferEdit(claim: Record<string, unknown>) {
  return Object.entries(COMMERCE7_EDIT_SAFE_CLAIM).every(([key, value]) => claim[key] === value);
}
/** Terms may change only with no live reservation and when every historical claim is provably dead. */
export function commerce7OfferEditable(reservedClaimCount: number, totalClaims: number, safeClaims: number) {
  return reservedClaimCount === 0 && totalClaims === safeClaims;
}
/**
 * Exclusive Wine Access. The winery secures the product to one or more Customer Tags in Commerce7 (SQRATCH never writes product
 * security or tag definitions). A qualifying product reads `security.availableTo` exactly "Tag" (the live value, never the
 * documented "Group") with 1–50 distinct, non-blank tag IDs. The Brand chooses ONE existing Manual Customer Tag for SQRATCH to
 * grant; its UUID, not its title, is authoritative.
 *
 * `multiTagAccessVerified`: whether a customer holding any ONE of several security tags may buy the product (OR) has not been
 * observed. Until it is, a multi-tag product may be configured as a draft but never activated or claimed.
 */
export const COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT = {
  securityAvailableTo: "Tag", tagType: "Manual", tagObjectType: "Customer",
  membershipGrant: true, multiTagAccessVerified: false,
} as const;
export const COMMERCE7_EXCLUSIVE_SECURITY_AVAILABLE_TO = COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT.securityAvailableTo;
/** The optional exclusive discount coupon uses the verified bearer eligibility, scoped to the exclusive product. */
const EXCLUSIVE_COUPON_ELIGIBILITY = "ANYONE_WITH_CODE" as const;
export function commerce7ExclusiveSecurity(providerMetadata: unknown): { tagIds: string[] } | null {
  const security = object(object(providerMetadata)?.security);
  if (!security || security.availableTo !== COMMERCE7_EXCLUSIVE_SECURITY_AVAILABLE_TO) return null;
  const ids = security.availableToObjectIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 50 || new Set(ids).size !== ids.length) return null;
  if (!ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 100 && id.trim() === id)) return null;
  return { tagIds: [...ids] as string[] };
}
/** A tag definition SQRATCH may grant: exactly the live-observed Manual Customer type. Never matched by title. */
export function commerce7GrantableTag(tag: { id: string; type: string; objectType: string } | null, tagId: string) {
  return !!tag && tag.id === tagId && tag.type === COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT.tagType && tag.objectType === COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT.tagObjectType;
}
export type Commerce7FrozenExclusiveAccess = { productId: string; tagId: string; tagTitle: string | null };
/** The exclusive product and tag frozen in an offer's commerce7Config at save time. */
export function frozenExclusiveAccess(config: unknown): Commerce7FrozenExclusiveAccess | null {
  const frozen = object(object(config)?.exclusiveAccess);
  if (!frozen || typeof frozen.productId !== "string" || !frozen.productId || typeof frozen.securityTagId !== "string" || !frozen.securityTagId || frozen.securityAvailableTo !== COMMERCE7_EXCLUSIVE_SECURITY_AVAILABLE_TO) return null;
  return { productId: frozen.productId, tagId: frozen.securityTagId, tagTitle: typeof frozen.tagTitle === "string" ? frozen.tagTitle : null };
}
export type Commerce7ExclusiveAccessStatus = "CONFIGURED" | "MULTI_TAG_UNVERIFIED" | "TAG_REMOVED" | "SECURITY_CHANGED" | "PRODUCT_UNAVAILABLE" | "NOT_CONFIGURED";
/**
 * Whether an exclusive offer still matches its product as last synchronized. Only CONFIGURED may be activated or claimed;
 * MULTI_TAG_UNVERIFIED may be kept as a draft. Tag deletion or type change is detected live (see commerce7GrantableTag).
 */
export function commerce7ExclusiveAccessStatus(config: unknown, product: { externalId: string; isAvailable: boolean; providerMetadata: unknown } | null, multiTagVerified: boolean = COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT.multiTagAccessVerified): Commerce7ExclusiveAccessStatus {
  const frozen = frozenExclusiveAccess(config);
  if (!frozen) return "NOT_CONFIGURED";
  if (!product || !product.isAvailable || product.externalId !== frozen.productId) return "PRODUCT_UNAVAILABLE";
  const security = commerce7ExclusiveSecurity(product.providerMetadata);
  if (!security) return "SECURITY_CHANGED";
  if (!security.tagIds.includes(frozen.tagId)) return "TAG_REMOVED";
  return security.tagIds.length > 1 && !multiTagVerified ? "MULTI_TAG_UNVERIFIED" : "CONFIGURED";
}
export type Commerce7MembershipGuidance = "NOT_SQRATCH_OWNED" | "OWNERSHIP_UNVERIFIED" | "SHARED_WITH_OTHER_REWARDS" | "SQRATCH_GRANTED" | null;
/**
 * Manual-review guidance for a membership; SQRATCH never deletes one. Commerce7 removes EVERY matching membership of a tag on
 * DELETE (live evidence), so even a SQRATCH-granted membership is never removed automatically: removal is the merchant's
 * decision in Commerce7. A pre-existing or unverified membership must not be removed on this reward's account at all.
 */
export function commerce7MembershipGuidance(ownership: string | null, otherActiveClaimsForSameCustomerTag: number): Commerce7MembershipGuidance {
  if (ownership === "PRE_EXISTING") return "NOT_SQRATCH_OWNED";
  if (ownership === "UNVERIFIED") return "OWNERSHIP_UNVERIFIED";
  if (ownership !== "SQRATCH_GRANTED") return null;
  return otherActiveClaimsForSameCustomerTag > 0 ? "SHARED_WITH_OTHER_REWARDS" : "SQRATCH_GRANTED";
}
