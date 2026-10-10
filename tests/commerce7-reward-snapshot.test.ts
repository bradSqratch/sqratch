import "./env-setup";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommerceRewardRedemption } from "@prisma/client";
import {
  buildRewardSnapshot, commerce7SnapshotIssuable, couponScopeForSnapshot, couponTermsForClaim, parseCommerce7Offer, parseRewardSnapshot,
  serializeBrandCommerce7Config, serializeRewardSnapshot, COMMERCE7_REWARD_CAPABILITIES, commerce7RewardReadiness, safeClaimDiagnostic,
} from "../src/lib/commerce7-reward-domain";
import { COMMERCE7_COUPON_CONTRACT, type CouponContract } from "../src/lib/commerce7-coupon-contract";
import type { NativeCoupon } from "../src/lib/commerce/providers/commerce7-rewards-client";
import { nativeReadDefaults } from "./commerce7-reward-harness";

// Opaque native values, as a merchant-created tenant template would have supplied to the pre-refinement flow.
const everyoneTemplate: NativeCoupon = { ...nativeReadDefaults, id: "template", code: "tpl", title: "Template", usageLimitType: "Per Store", usageLimit: 1, appliesTo: "Store", appliesToObjectIds: null, productDiscountType: "Dollar Off", productDiscount: 1000, shippingDiscountType: "No Discount", shippingDiscount: null, startDate: "2026-01-01T00:00:00.000Z", endDate: null, status: "Enabled", minimumCartAmount: null, availableTo: "Everyone", availableToObjectIds: null };
const tagTemplate: NativeCoupon = { ...everyoneTemplate, availableTo: "opaque-customer-tag", availableToObjectIds: ["template-tag"] };
const productTemplate: NativeCoupon = { ...everyoneTemplate, appliesTo: "opaque-product-scope", appliesToObjectIds: ["wine"] };
const offerRow = { title: "Wine reward", minimumSubtotalCents: 5000, appliesTo: "ALL_PRODUCTS" as const, discountType: "FIXED_AMOUNT" as const, discountAmountCents: 1000, discountPercentageBasisPoints: null };
const body = { title: "Wine reward", isActive: true, rewardMode: "DISCOUNT", pointsCost: 100, discountType: "FIXED_AMOUNT", discountAmountCents: 1000, maxTotalRedemptions: 25, maxRedemptionsPerUser: 1, codeValidDays: 30, productIds: [] };

test("offer input needs no coupon template and silently drops a stale template field instead of persisting or requiring it", () => {
  const parsed = parseCommerce7Offer(body, "CAD");
  assert.equal(parsed.eligibilityMode, "ANYONE_WITH_CODE"); assert.equal(parsed.appliesTo, "ALL_PRODUCTS"); assert.equal(parsed.discountEnabled, true);
  const stale = parseCommerce7Offer({ ...body, templateCouponId: "old-client-field" }, "CAD");
  assert.ok(!("templateCouponId" in stale)); assert.ok(!JSON.stringify(stale).includes("old-client-field"));
  for (const templateCouponId of [undefined, null, "", 7]) assert.equal(parseCommerce7Offer({ ...body, templateCouponId }, "CAD").title, "Wine reward");
  assert.equal(COMMERCE7_REWARD_CAPABILITIES.productScope, "NATIVE_COUPON");
});

test("a new claim snapshot carries every native-relevant term, so issuance never reads a provider template", () => {
  const snapshot = buildRewardSnapshot(offerRow, { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true }, []);
  assert.deepEqual(serializeRewardSnapshot(snapshot), { snapshotVersion: 2, eligibilityMode: "ANYONE_WITH_CODE", title: "Wine reward", minimumSubtotalCents: 5000, appliesTo: "ALL_PRODUCTS", productIds: [], discount: { type: "FIXED_AMOUNT", amountCents: 1000, percentageBasisPoints: null } });
  assert.deepEqual(parseRewardSnapshot(serializeRewardSnapshot(snapshot)), snapshot);
  const percent = buildRewardSnapshot({ ...offerRow, discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1500, minimumSubtotalCents: null }, { eligibilityMode: "ANYONE_WITH_CODE" }, []);
  assert.deepEqual(percent.discount, { type: "PERCENTAGE", amountCents: null, percentageBasisPoints: 1500 }); assert.equal(percent.minimumSubtotalCents, null);
  const selected = buildRewardSnapshot({ ...offerRow, appliesTo: "SPECIFIC_PRODUCTS" }, { eligibilityMode: "ANYONE_WITH_CODE" }, ["b", "a"]);
  assert.deepEqual(selected.productIds, ["a", "b"]);
  assert.throws(() => buildRewardSnapshot({ ...offerRow, appliesTo: "SPECIFIC_PRODUCTS" }, { eligibilityMode: "ANYONE_WITH_CODE" }, []), { code: "INVALID_OFFER" });
  assert.throws(() => buildRewardSnapshot(offerRow, { eligibilityMode: "invented" }, []), { code: "INVALID_OFFER" });
});

test("legacy template-bearing config: ignored where the contract is verified, retained as observed evidence where it is not", () => {
  // Verified branch (bearer + whole store): the template ID and body are ignored for new issuance.
  const bearer = buildRewardSnapshot(offerRow, { eligibilityMode: "ANYONE_WITH_CODE", templateCouponId: "template", template: everyoneTemplate }, []);
  assert.equal(bearer.legacyTemplate, null); assert.ok(!JSON.stringify(serializeRewardSnapshot(bearer)).includes("template"));
  // Unverified branches keep the real native enums the merchant's template proved, validated against the offer.
  const claimant = buildRewardSnapshot(offerRow, { templateCouponId: "template", template: tagTemplate }, []);
  assert.equal(claimant.eligibilityMode, "CLAIMANT_ONLY"); assert.deepEqual(claimant.legacyTemplate, tagTemplate);
  // Selected products are now verified (live "Product" 201), so a legacy product template is ignored like the whole-store one.
  const selected = buildRewardSnapshot({ ...offerRow, appliesTo: "SPECIFIC_PRODUCTS" }, { eligibilityMode: "ANYONE_WITH_CODE", templateCouponId: "template", template: productTemplate }, ["wine"]);
  assert.equal(selected.legacyTemplate, null); assert.ok(!JSON.stringify(serializeRewardSnapshot(selected)).includes("template"));
  assert.equal(commerce7SnapshotIssuable(bearer), true); assert.equal(commerce7SnapshotIssuable(claimant), true); assert.equal(commerce7SnapshotIssuable(selected), true);
  // A legacy template that does not match the offer is never reinterpreted where it is still the only evidence.
  assert.throws(() => buildRewardSnapshot(offerRow, { templateCouponId: "template", template: everyoneTemplate }, []), { code: "INVALID_OFFER" });
  const claimantProducts = { ...tagTemplate, appliesTo: "opaque-product-scope", appliesToObjectIds: ["wine"] };
  assert.throws(() => buildRewardSnapshot({ ...offerRow, appliesTo: "SPECIFIC_PRODUCTS" }, { eligibilityMode: "CLAIMANT_ONLY", templateCouponId: "template", template: claimantProducts }, ["other-wine"]), { code: "INVALID_OFFER" });
  // Unverified branch with no template at all builds, but is not issuable.
  const bare = buildRewardSnapshot(offerRow, { eligibilityMode: "CLAIMANT_ONLY" }, []);
  assert.equal(bare.legacyTemplate, null); assert.equal(commerce7SnapshotIssuable(bare), false);
  assert.equal(commerce7SnapshotIssuable(buildRewardSnapshot({ ...offerRow, appliesTo: "SPECIFIC_PRODUCTS" }, { eligibilityMode: "ANYONE_WITH_CODE" }, ["wine"])), true, "selected products are issuable from the contract alone");
});

test("historical claim snapshots (pre-refinement shape) still parse, with scope and eligibility derived from their template and no discount terms", () => {
  const stored = { templateCouponId: "template", template: tagTemplate, discountEnabled: true, title: "Old reward", minimumSubtotalCents: 2500 };
  const parsed = parseRewardSnapshot(stored);
  assert.equal(parsed.eligibilityMode, "CLAIMANT_ONLY"); assert.equal(parsed.appliesTo, "ALL_PRODUCTS"); assert.deepEqual(parsed.productIds, []); assert.equal(parsed.discount, null); assert.deepEqual(parsed.legacyTemplate, tagTemplate);
  const bearer = parseRewardSnapshot({ ...stored, eligibilityMode: "ANYONE_WITH_CODE", template: everyoneTemplate });
  assert.equal(bearer.eligibilityMode, "ANYONE_WITH_CODE");
  const selected = parseRewardSnapshot({ ...stored, eligibilityMode: "ANYONE_WITH_CODE", template: productTemplate });
  assert.equal(selected.appliesTo, "SPECIFIC_PRODUCTS"); assert.deepEqual(selected.productIds, ["wine"]);
  // Fail closed on anything ambiguous rather than reinterpreting it.
  for (const bad of [null, {}, { ...stored, template: null }, { ...stored, template: { ...tagTemplate, usageLimit: 2 } }, { ...stored, eligibilityMode: "invented" }, { ...stored, template: everyoneTemplate }, { ...stored, minimumSubtotalCents: 0 }, { ...stored, title: 3 }]) assert.throws(() => parseRewardSnapshot(bad), { code: "INVALID_OFFER" }, JSON.stringify(bad));
  assert.throws(() => parseRewardSnapshot({ snapshotVersion: 2, eligibilityMode: "ANYONE_WITH_CODE", title: "x", minimumSubtotalCents: null, appliesTo: "SPECIFIC_PRODUCTS", productIds: [], discount: null }), { code: "INVALID_OFFER" });
  assert.throws(() => parseRewardSnapshot({ snapshotVersion: 3 }), { code: "INVALID_OFFER" });
});

test("claim discount terms come from the snapshot and must agree with the immutable claim columns", () => {
  const snapshot = buildRewardSnapshot(offerRow, { eligibilityMode: "ANYONE_WITH_CODE" }, []);
  const claim = { discountType: "FIXED_AMOUNT", discountAmountCents: 1000, discountPercentageBasisPoints: null } as CommerceRewardRedemption;
  assert.deepEqual(couponTermsForClaim(snapshot, claim), { title: "Wine reward", discountType: "FIXED_AMOUNT", discountAmountCents: 1000, discountPercentageBasisPoints: null, minimumSubtotalCents: 5000 });
  for (const drift of [{ discountAmountCents: 1001 }, { discountType: "PERCENTAGE" }, { discountPercentageBasisPoints: 1500 }]) assert.throws(() => couponTermsForClaim(snapshot, { ...claim, ...drift } as CommerceRewardRedemption), { code: "SNAPSHOT_MISMATCH" });
  // A pre-refinement snapshot has no discount terms; the claim columns are the only source.
  const old = parseRewardSnapshot({ templateCouponId: "t", template: tagTemplate, title: "Old", minimumSubtotalCents: null });
  assert.deepEqual(couponTermsForClaim(old, { discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1500 } as CommerceRewardRedemption), { title: "Old", discountType: "PERCENTAGE", discountAmountCents: null, discountPercentageBasisPoints: 1500, minimumSubtotalCents: null });
});

test("scope resolution: the contract wins where verified; a legacy snapshot's observed enums are used only where it has none", () => {
  const bearer = buildRewardSnapshot(offerRow, { eligibilityMode: "ANYONE_WITH_CODE", templateCouponId: "t", template: everyoneTemplate }, []);
  assert.deepEqual(couponScopeForSnapshot(bearer, null), { ok: true, scope: { appliesTo: "Store", appliesToObjectIds: null, availableTo: "Everyone", availableToObjectIds: null } });
  const claimant = buildRewardSnapshot(offerRow, { templateCouponId: "t", template: tagTemplate }, []);
  assert.deepEqual(couponScopeForSnapshot(claimant, "claim-tag"), { ok: true, scope: { appliesTo: "Store", appliesToObjectIds: null, availableTo: "opaque-customer-tag", availableToObjectIds: ["claim-tag"] } });
  assert.deepEqual(couponScopeForSnapshot(claimant, null), { ok: false, unsupported: "INVALID_INPUT" });
  const selected = buildRewardSnapshot({ ...offerRow, appliesTo: "SPECIFIC_PRODUCTS" }, { eligibilityMode: "ANYONE_WITH_CODE", templateCouponId: "t", template: productTemplate }, ["wine"]);
  assert.deepEqual(couponScopeForSnapshot(selected, null), { ok: true, scope: { appliesTo: "Product", appliesToObjectIds: ["wine"], availableTo: "Everyone", availableToObjectIds: null } }, "the live-proven value wins over the legacy template's");
  const bare = buildRewardSnapshot(offerRow, { eligibilityMode: "CLAIMANT_ONLY" }, []);
  assert.deepEqual(couponScopeForSnapshot(bare, "claim-tag"), { ok: false, unsupported: "CUSTOMER_TAG_RESTRICTION" });
  const verified: CouponContract = { ...COMMERCE7_COUPON_CONTRACT, availableTo: { ...COMMERCE7_COUPON_CONTRACT.availableTo, CLAIMANT_ONLY: "proven-tag-enum" } };
  assert.deepEqual(couponScopeForSnapshot(bare, "claim-tag", verified), { ok: true, scope: { appliesTo: "Store", appliesToObjectIds: null, availableTo: "proven-tag-enum", availableToObjectIds: ["claim-tag"] } });
  assert.equal(commerce7SnapshotIssuable(bare, verified), true);
});

test("Brand offer DTO exposes eligibility and discount flags only: no template ID, template body or stored native values", () => {
  const legacy = { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true, templateCouponId: "secret-template-id", template: tagTemplate };
  const dto = serializeBrandCommerce7Config(legacy, "DISCOUNT");
  assert.deepEqual(dto, { eligibilityMode: "ANYONE_WITH_CODE", discountEnabled: true });
  assert.ok(!JSON.stringify(dto).includes("template"));
  // Historical or malformed configs never throw; they keep their binding (missing => claimant-only, unknown => review).
  assert.deepEqual(serializeBrandCommerce7Config({}, "DISCOUNT"), { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: undefined });
  assert.deepEqual(serializeBrandCommerce7Config(null, "DISCOUNT"), { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: undefined });
  assert.deepEqual(serializeBrandCommerce7Config({ eligibilityMode: "invented" }, "DISCOUNT"), { eligibilityMode: null, discountEnabled: undefined });
  assert.deepEqual(serializeBrandCommerce7Config({ eligibilityMode: "ANYONE_WITH_CODE" }, "EXCLUSIVE_PRODUCT_ACCESS"), { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: undefined, exclusiveTagTitle: null });
  const exclusive = serializeBrandCommerce7Config({ discountEnabled: false, exclusiveAccess: { productId: "rare", securityAvailableTo: "Tag", securityTagId: "secret-tag-uuid", tagTitle: "Rare Wine Members" } }, "EXCLUSIVE_PRODUCT_ACCESS");
  assert.deepEqual(exclusive, { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: false, exclusiveTagTitle: "Rare Wine Members" }); assert.ok(!JSON.stringify(exclusive).includes("secret-tag-uuid"));
});

test("Brand readiness no longer mentions templates and reports exactly which coupon branches can go live", () => {
  const readiness = commerce7RewardReadiness(true);
  assert.equal(readiness.backendConfigured, true); assert.equal(readiness.exclusiveAccessSupported, true); assert.equal(readiness.exclusiveMultiTagAccessVerified, true, "OR semantics verified on the live storefront");
  assert.deepEqual(readiness.couponContract, { eligibility: { ANYONE_WITH_CODE: true, CLAIMANT_ONLY: false }, scope: { ALL_PRODUCTS: true, SPECIFIC_PRODUCTS: true }, discount: { FIXED_AMOUNT: true, PERCENTAGE: true } });
  assert.deepEqual(readiness.permissions, ["Coupon: Full", "Tag: Full", "Customer: Read", "Product: Read", "Order: Read"]);
  assert.doesNotMatch(JSON.stringify(readiness), /template/i); assert.equal(commerce7RewardReadiness(false).backendConfigured, false);
});

test("claim diagnostics reach the Brand only as a closed STAGE:CODE token", () => {
  for (const ok of ["COUPON_CREATE:WRITE_REJECTED", "MANUAL_PROVIDER_SETUP_REQUIRED", "TAG_CREATE:PROVIDER_UNAVAILABLE"]) assert.equal(safeClaimDiagnostic(ok), ok);
  for (const bad of [null, "", "lowercase", "COUPON_CREATE:", "SQRA" + "A".repeat(32) + "!", "has space", "X".repeat(80), "alice@example.test"]) assert.equal(safeClaimDiagnostic(bad), null, String(bad));
});

test("no legacy-validation failure leaks template wording to a claimant or Brand", () => {
  const stored = { templateCouponId: "template", template: tagTemplate, discountEnabled: true, title: "Old reward", minimumSubtotalCents: null };
  const failures: unknown[] = [
    () => parseRewardSnapshot({ ...stored, template: { ...tagTemplate, usageLimit: 2 } }), () => parseRewardSnapshot({ ...stored, template: everyoneTemplate }), () => parseRewardSnapshot({ ...stored, template: null }),
    () => parseRewardSnapshot({ ...stored, eligibilityMode: "ANYONE_WITH_CODE", template: tagTemplate }), () => parseRewardSnapshot({ ...stored, template: { ...productTemplate, availableTo: "x", availableToObjectIds: ["a", "b"] } }),
    () => buildRewardSnapshot(offerRow, { templateCouponId: "template", template: everyoneTemplate }, []),
    () => buildRewardSnapshot({ ...offerRow, appliesTo: "SPECIFIC_PRODUCTS" }, { eligibilityMode: "CLAIMANT_ONLY", templateCouponId: "t", template: { ...tagTemplate, appliesTo: "opaque-product-scope", appliesToObjectIds: ["wine"] } }, ["other"]),
  ];
  for (const failure of failures) assert.throws(failure as () => void, (error: Error) => error.message === "Reward configuration needs review." && !/template/i.test(error.message));
});

test("exclusive claim snapshots (version 3) freeze the product and the one tag, carry an optional discount, and fail closed on drift", () => {
  const config = { eligibilityMode: "CLAIMANT_ONLY", discountEnabled: false, exclusiveAccess: { productId: "rare", securityAvailableTo: "Tag", securityTagId: "tag-uuid", tagTitle: "Members" } };
  const exclusiveOffer = { ...offerRow, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", appliesTo: "SPECIFIC_PRODUCTS" as const, discountAmountCents: null };
  const accessOnly = buildRewardSnapshot(exclusiveOffer, config, ["rare"]);
  assert.deepEqual(serializeRewardSnapshot(accessOnly), { snapshotVersion: 3, eligibilityMode: "CLAIMANT_ONLY", title: "Wine reward", minimumSubtotalCents: null, appliesTo: "SPECIFIC_PRODUCTS", productIds: ["rare"], discount: null, exclusiveAccess: { productId: "rare", tagId: "tag-uuid" } });
  assert.ok(!JSON.stringify(serializeRewardSnapshot(accessOnly)).includes("Members"), "the display title is not part of the frozen terms");
  assert.equal(commerce7SnapshotIssuable(accessOnly), true);
  const withDiscount = buildRewardSnapshot({ ...exclusiveOffer, discountAmountCents: 1500 }, { ...config, discountEnabled: true }, ["rare"]);
  assert.deepEqual(withDiscount.discount, { type: "FIXED_AMOUNT", amountCents: 1500, percentageBasisPoints: null }); assert.equal(withDiscount.minimumSubtotalCents, 5000);
  assert.deepEqual(couponScopeForSnapshot(withDiscount, "ignored-claim-tag"), { ok: true, scope: { appliesTo: "Product", appliesToObjectIds: ["rare"], availableTo: "Everyone", availableToObjectIds: null } });
  assert.deepEqual(parseRewardSnapshot(JSON.parse(JSON.stringify(serializeRewardSnapshot(withDiscount)))), withDiscount, "round-trips through JSON storage");
  const stored = serializeRewardSnapshot(accessOnly);
  for (const bad of [{ ...stored, exclusiveAccess: null }, { ...stored, exclusiveAccess: { productId: "rare" } }, { ...stored, productIds: ["other"] }, { ...stored, productIds: ["rare", "other"] }, { ...stored, appliesTo: "ALL_PRODUCTS" }, { ...stored, eligibilityMode: "ANYONE_WITH_CODE" }, { ...stored, minimumSubtotalCents: 100 }, { ...stored, legacyTemplate: tagTemplate }]) assert.throws(() => parseRewardSnapshot(bad), { code: "INVALID_OFFER" }, JSON.stringify(bad));
  for (const [productIds, frozen] of [[["other"], config], [["rare"], { eligibilityMode: "CLAIMANT_ONLY" }], [["rare"], { ...config, exclusiveAccess: { ...config.exclusiveAccess, securityAvailableTo: "Group" } }]] as const) assert.throws(() => buildRewardSnapshot(exclusiveOffer, frozen as Record<string, unknown>, [...productIds]), { code: "INVALID_OFFER" });
});
