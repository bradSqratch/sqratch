import { createHash } from "node:crypto";
import type { BrandRewardOffer, CommerceRewardRedemption } from "@prisma/client";
import { storedCommerce7Eligibility, type Commerce7RewardEligibility } from "./commerce7-reward-eligibility";
import { COMMERCE7_COUPON_CONTRACT, commerce7CouponSupport, isCouponBranchSupported, resolveCouponScope, type Commerce7CouponAppliesTo, type CouponContract, type CouponScopeResult } from "./commerce7-coupon-contract";
import { object, parseNativeCoupon, type NativeCoupon, type RewardCouponTerms } from "./commerce/providers/commerce7-rewards-client";

export const COMMERCE7_REWARD_CAPABILITIES = {
  fixedAmount: true, percentage: true, minimumSubtotal: true,
  productScope: "NATIVE_COUPON" as const, customerRestriction: "OPTIONAL_MANUAL_CUSTOMER_TAG" as const,
  automaticCustomerTagAssignment: false, exclusiveProductAccess: false,
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
  requireValue(!row.isActive || rewardMode === "DISCOUNT", "Exclusive access cannot be activated until Commerce7 confirms a writable, customer-bound access contract.");
  return {
    title: row.title.trim(), description: typeof row.description === "string" ? row.description.trim() || null : null,
    isActive: row.isActive, rewardMode: rewardMode as "DISCOUNT" | "EXCLUSIVE_PRODUCT_ACCESS", pointsCost: integer(row.pointsCost, 1, 2147483647, "Points cost"), discountType: discountType as "FIXED_AMOUNT" | "PERCENTAGE",
    discountAmountCents, discountPercentageBasisPoints, currencyCode: currency, claimStartsAt, claimEndsAt,
    maxTotalRedemptions, maxRedemptionsPerUser, codeValidDays: integer(row.codeValidDays, 1, 365, "Validity in days"),
    minimumSubtotalCents: !discountEnabled || row.minimumSubtotalCents == null ? null : integer(row.minimumSubtotalCents, 1, 2147483647, "Minimum subtotal in cents"),
    appliesTo: appliesTo as "SPECIFIC_PRODUCTS" | "ALL_PRODUCTS", eligibilityMode,
    productIds: productIds as string[], discountEnabled,
  };
}
/** Pre-refinement offers/claims embed the merchant's native template. It is only ever validated here, never fetched or required. */
export function validateLegacyNativeTemplate(template: NativeCoupon, productIds: string[], tagId: string | null, eligibilityMode: Commerce7RewardEligibility = "CLAIMANT_ONLY") {
  const { usageLimitType, usageLimit, shippingDiscountType, appliesTo, availableTo } = COMMERCE7_COUPON_CONTRACT;
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
};
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
  requireValue(row.snapshotVersion === 2, "Reward configuration needs review.");
  requireValue(row.appliesTo === "ALL_PRODUCTS" || row.appliesTo === "SPECIFIC_PRODUCTS", "Reward configuration needs review.");
  const productIds = row.productIds;
  requireValue(Array.isArray(productIds) && productIds.every((id) => typeof id === "string" && id.length > 0) && new Set(productIds).size === productIds.length && (row.appliesTo === "ALL_PRODUCTS" ? productIds.length === 0 : productIds.length >= 1 && productIds.length <= 50), "Reward configuration needs review.");
  return { ...common, appliesTo: row.appliesTo, productIds: productIds as string[], discount: snapshotDiscount(row.discount), legacyTemplate: row.legacyTemplate == null ? null : legacyTemplate(row.legacyTemplate, eligibilityMode, productIds as string[]) };
}
export function serializeRewardSnapshot(snapshot: Commerce7RewardSnapshot) {
  requireValue(snapshot.discount, "Reward configuration needs review.");
  return { snapshotVersion: 2, eligibilityMode: snapshot.eligibilityMode, title: snapshot.title, minimumSubtotalCents: snapshot.minimumSubtotalCents, appliesTo: snapshot.appliesTo, productIds: snapshot.productIds, discount: snapshot.discount, ...(snapshot.legacyTemplate ? { legacyTemplate: snapshot.legacyTemplate } : {}) };
}
type SnapshotOffer = Pick<BrandRewardOffer, "title" | "minimumSubtotalCents" | "appliesTo" | "discountType" | "discountAmountCents" | "discountPercentageBasisPoints">;
/** Freeze an offer into a claim snapshot. A stored template is ignored where the contract is verified and kept (validated) where it is the only evidence. */
export function buildRewardSnapshot(offer: SnapshotOffer, config: Record<string, unknown>, productIds: readonly string[], contract: CouponContract = COMMERCE7_COUPON_CONTRACT): Commerce7RewardSnapshot {
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
  return isCouponBranchSupported(snapshot.eligibilityMode, snapshot.appliesTo, contract) || snapshot.legacyTemplate !== null;
}
/** Contract first; a legacy snapshot's observed enums only for a branch the contract has no value for. */
export function couponScopeForSnapshot(snapshot: Commerce7RewardSnapshot, claimTagId: string | null, contract: CouponContract = COMMERCE7_COUPON_CONTRACT): CouponScopeResult {
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
  return { eligibilityMode: storedCommerce7Eligibility(config, rewardMode), discountEnabled: typeof row?.discountEnabled === "boolean" ? row.discountEnabled : undefined };
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
  const eligibilityMode = storedCommerce7Eligibility(claim.rewardConfigSnapshot, claim.rewardMode);
  const expired = claim.status === "ISSUED" && claim.expiresAt !== null && claim.expiresAt <= new Date();
  return { eligibilityMode, id: claim.id, offerId: claim.offerId, status: expired ? "EXPIRED" : claim.status, provisioningState: claim.provisioningState,
    pointsCost: claim.pointsCost, code: eligibilityMode && !expired && claim.status === "ISSUED" && claim.provisioningState === "READY" ? claim.code : null,
    issuedAt: claim.issuedAt, expiresAt: claim.expiresAt, usedAt: claim.usedAt,
    canCancel: claim.status === "POINTS_DEBITED" && !claim.couponCreateAttempted && !claim.entitlementEverGranted && !claim.provisioningOwner,
    canRetry: claim.status === "POINTS_DEBITED" && !claim.provisioningOwner && !claim.needsManualReview,
    message: claim.errorMessage, createdAt: claim.createdAt };
}
/** What the Brand UI may offer. `couponContract` tells it which eligibility/scope choices can go live; nothing about provider objects. */
export function commerce7RewardReadiness(backendConfigured: boolean) {
  return {
    backendConfigured, manualCustomerTagAssignmentRequiredFor: "CLAIMANT_ONLY" as const, eligibilityModes: ["ANYONE_WITH_CODE", "CLAIMANT_ONLY"] as const,
    exclusiveAccessSupported: false, couponContract: commerce7CouponSupport(), permissions: ["Coupon: Full", "Tag: Full", "Customer: Read", "Product: Read", "Order: Read"],
  };
}
/** Operators see a closed STAGE:CODE token, never free-form provider text. */
export function safeClaimDiagnostic(value: string | null | undefined) {
  return typeof value === "string" && /^[A-Z_]{3,40}(:[A-Z_]{3,40})?$/.test(value) ? value : null;
}
