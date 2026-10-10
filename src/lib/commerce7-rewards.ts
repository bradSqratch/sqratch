import { randomBytes, randomUUID } from "node:crypto";
import { Prisma, type BrandRewardOffer, type CommerceRewardRedemption } from "@prisma/client";
import prisma from "./prisma";
import { storedCommerce7Eligibility, type Commerce7RewardEligibility } from "./commerce7-reward-eligibility";
import { COMMERCE7_COUPON_CONTRACT, isCouponBranchSupported, isDiscountTypeSupported, type Commerce7CouponAppliesTo, type CouponContract } from "./commerce7-coupon-contract";
import { applyPointLedgerEvent } from "./points";
import { getActiveCommerceConnection, isConnectionUsable } from "./commerce/connection-service";
import { getCommerce7AppConfig } from "./commerce/providers/commerce7";
import { Commerce7RewardsClient, Commerce7RewardError, buildCommerce7RewardCoupon, couponMatches, customerTagCount, floorToMinute, normalizeRewardEmail, object, type NativeCoupon, type NativeCustomer } from "./commerce/providers/commerce7-rewards-client";
import { buildRewardSnapshot, COMMERCE7_EDIT_SAFE_CLAIM, COMMERCE7_PERCENTAGE_UNVERIFIED_MESSAGE, commerce7SnapshotDiscountBlocked, COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT, COMMERCE7_EXCLUSIVE_SECURITY_AVAILABLE_TO, commerce7ClaimRefundable, commerce7ExclusiveAccessStatus, commerce7ExclusiveSecurity, commerce7GrantableTag, commerce7OfferEditable, commerce7OfferUnavailableReason, commerce7SnapshotIssuable, couponScopeForSnapshot, couponTermsForClaim, frozenExclusiveAccess, parseCommerce7Offer, parseRewardSnapshot, requireValue, retainLegacyTemplate, RewardClaimError, rewardIdempotencyKey, serializeRewardSnapshot, storedCommerce7OfferInput, type Commerce7ExclusiveAccessStatus } from "./commerce7-reward-domain";

type Db = typeof prisma;
/**
 * `contract` defaults to the verified production Coupon contract and `multiTagAccessVerified` to the exclusive access
 * contract; only tests inject others.
 */
export type Commerce7RewardDeps = { db: Db; client: (tenant: string) => Commerce7RewardsClient; now: () => Date; contract?: CouponContract; backendConfigured?: () => boolean; multiTagAccessVerified?: boolean };
const defaults: Commerce7RewardDeps = { db: prisma, client: (tenant) => new Commerce7RewardsClient(tenant), now: () => new Date() };
const backendReady = (deps: Commerce7RewardDeps) => (deps.backendConfigured ?? (() => !!getCommerce7AppConfig()))();
const multiTagVerified = (deps: Commerce7RewardDeps) => deps.multiTagAccessVerified ?? COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT.multiTagAccessVerified;
const SERIALIZABLE = { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 10000 };
export async function rewardTransaction<T>(db: Db, work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(work, SERIALIZABLE); }
    catch (error) {
      if (attempt < 3 && error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" || error.code === "P2002")) continue;
      throw error;
    }
  }
}
async function connectionForClaim(claim: CommerceRewardRedemption, db: Db) {
  const row = await db.commerceConnection.findFirst({ where: { id: claim.connectionId ?? "", brandId: claim.brandId, provider: "COMMERCE7", externalAccountId: claim.externalAccountId, status: "CONNECTED", uninstalledAt: null } });
  if (!row) throw new RewardClaimError("CONNECTION_UNAVAILABLE", "Reconnect the original Commerce7 store to continue this claim.");
  return row;
}
const EXCLUSIVE_STATUS_MESSAGES: Record<Exclude<Commerce7ExclusiveAccessStatus, "CONFIGURED">, string> = {
  MULTI_TAG_UNVERIFIED: "This product is secured to several Customer Tags in Commerce7. Access for multi-tag products has not been verified, so this reward can be saved as a draft only.",
  TAG_REMOVED: "The selected Customer Tag no longer secures this product in Commerce7. Sync products and review this reward.",
  SECURITY_CHANGED: "The product is no longer secured to a Customer Tag in Commerce7. Sync products and review this reward.",
  PRODUCT_UNAVAILABLE: "The exclusive product is no longer synchronized and available. Sync products and review this reward.",
  NOT_CONFIGURED: "Choose a product secured to a Customer Tag and the tag SQRATCH should grant.",
};
type ExclusiveProviderCheck = { ok: true; tagTitle: string } | { ok: false; code: "TAG_UNAVAILABLE" | "PRODUCT_SECURITY_CHANGED" | "MULTI_TAG_UNVERIFIED"; message: string };
/**
 * Live, read-only proof that an exclusive grant is still legitimate: the frozen tag still exists as a Manual Customer tag and
 * still secures the available product. Matching is by UUID only. Never inside a database transaction.
 */
async function verifyExclusiveProvider(client: Commerce7RewardsClient, productId: string, tagId: string, multiTag: boolean): Promise<ExclusiveProviderCheck> {
  const tag = await client.customerTag(tagId);
  if (!tag || !commerce7GrantableTag(tag, tagId)) return { ok: false, code: "TAG_UNAVAILABLE", message: "This reward's Customer Tag was deleted or is no longer a Manual Customer Tag in Commerce7. The store must review this reward." };
  const product = await client.productAccess(productId);
  const security = product?.security ? commerce7ExclusiveSecurity({ security: product.security }) : null;
  if (!product || !product.available || !security || !security.tagIds.includes(tagId)) return { ok: false, code: "PRODUCT_SECURITY_CHANGED", message: "The exclusive product is no longer available and secured to this reward's Customer Tag in Commerce7. The store must review this reward." };
  if (security.tagIds.length > 1 && !multiTag) return { ok: false, code: "MULTI_TAG_UNVERIFIED", message: EXCLUSIVE_STATUS_MESSAGES.MULTI_TAG_UNVERIFIED };
  return { ok: true, tagTitle: tag.title };
}
type ConnectionSummary = { id: string; externalAccountId: string; currencyCode: string | null };
/**
 * The Customer Tag an exclusive save will grant: the Brand's explicit choice, or the product's only tag. Resolved from the
 * synchronized product and the live Tag read API before the save transaction, which then re-checks the product.
 */
async function resolveExclusiveTag(brandId: string, connection: ConnectionSummary, body: unknown, deps: Commerce7RewardDeps) {
  const parsed = parseCommerce7Offer(body, connection.currencyCode);
  const product = parsed.productIds.length === 1 ? await deps.db.connectedCommerceProduct.findFirst({ where: { brandId, connectionId: connection.id, provider: "COMMERCE7", externalId: parsed.productIds[0], isAvailable: true }, select: { externalId: true, providerMetadata: true } }) : null;
  const security = product ? commerce7ExclusiveSecurity(product.providerMetadata) : null;
  requireValue(product && security, "Choose a product secured to a Customer Tag in Commerce7, then sync products in SQRATCH.");
  const tagId = parsed.exclusiveTagId ?? (security.tagIds.length === 1 ? security.tagIds[0] : null);
  requireValue(tagId, "This product is secured to several Customer Tags. Choose which tag SQRATCH should grant.");
  requireValue(security.tagIds.includes(tagId), "Choose a Customer Tag that secures this product in Commerce7.");
  if (parsed.isActive && security.tagIds.length > 1 && !multiTagVerified(deps)) throw new RewardClaimError("MULTI_TAG_UNVERIFIED", EXCLUSIVE_STATUS_MESSAGES.MULTI_TAG_UNVERIFIED);
  if (!backendReady(deps)) throw new RewardClaimError("SETUP_INCOMPLETE", "Commerce7 rewards are not configured on the server. Contact SQRATCH support.");
  const client = deps.client(connection.externalAccountId);
  const tag = await client.customerTag(tagId);
  requireValue(tag && commerce7GrantableTag(tag, tagId), "Choose a Manual Customer Tag that still exists in Commerce7.");
  if (parsed.isActive) {
    const check = await verifyExclusiveProvider(client, product.externalId, tagId, multiTagVerified(deps));
    if (!check.ok) throw new RewardClaimError(check.code, check.message);
  }
  return { id: tagId, title: tag.title };
}
const CLAIMANT_DISCOUNT_RETIRED_MESSAGE = "Discount rewards are issued to anyone with the code. Claiming customer only is no longer offered for discounts; use Exclusive wine access to reward a specific customer.";
function unverifiedBranchMessage(eligibilityMode: Commerce7RewardEligibility, appliesTo: Commerce7CouponAppliesTo, contract: CouponContract) {
  if (!isCouponBranchSupported(eligibilityMode, "ALL_PRODUCTS", contract)) return "Claiming-customer-only rewards can be saved as drafts but cannot be activated yet. Choose Anyone with the code to go live.";
  return appliesTo === "SPECIFIC_PRODUCTS" ? "Selected-product rewards can be saved as drafts but cannot be activated yet. Choose All products to go live." : "This reward option cannot be activated yet.";
}
/**
 * Stores and validates SQRATCH configuration only. Offers own no provider resources, so a save never WRITES to Commerce7.
 * Discount saves make no provider call at all; an exclusive save reads its Customer Tag (and, when activating, the live
 * product security) through the public Tag/Product read APIs, before and outside the transaction.
 */
export async function saveCommerce7Offer(brandId: string, body: unknown, offerId?: string, deps = defaults) {
  const connection = await getActiveCommerceConnection(brandId, "COMMERCE7");
  if (!connection || !isConnectionUsable(connection)) throw new RewardClaimError("CONNECTION_UNAVAILABLE", "Connect Commerce7 before configuring rewards.");
  const contract = deps.contract ?? COMMERCE7_COUPON_CONTRACT;
  const row = object(body);
  const exclusiveTag = row?.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" ? await resolveExclusiveTag(brandId, connection, body, deps) : null;
  return rewardTransaction(deps.db, async (tx) => {
    const current = await tx.commerceConnection.findFirst({ where: { id: connection.id, brandId, provider: "COMMERCE7", externalAccountId: connection.externalAccountId, status: "CONNECTED", uninstalledAt: null } });
    if (!current) throw new RewardClaimError("CONNECTION_UNAVAILABLE", "Commerce7 connection changed. Reload and review the offer.");
    const existing = offerId ? await tx.brandRewardOffer.findFirst({ where: { id: offerId, brandId, provider: "COMMERCE7", connectionId: connection.id, sourceExternalAccountId: connection.externalAccountId } }) : null;
    if (offerId && !existing) throw new RewardClaimError("NOT_FOUND", "Reward offer not found for this connection.", 404);
    // Older edit callers must not silently turn a deployed bound offer public.
    let inputBody = body;
    if (existing && row && row.eligibilityMode === undefined) {
      const stored = storedCommerce7Eligibility(existing.commerce7Config, existing.rewardMode);
      requireValue(stored, "Reward eligibility configuration needs review.");
      inputBody = { ...row, eligibilityMode: stored };
    }
    const { productIds, discountEnabled, eligibilityMode, exclusiveTagId, ...fields } = parseCommerce7Offer(inputBody, connection.currencyCode);
    const exclusive = fields.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS";
    const products = await tx.connectedCommerceProduct.findMany({ where: { brandId, connectionId: connection.id, provider: "COMMERCE7", externalId: { in: productIds }, isAvailable: true }, select: { externalId: true, title: true, providerMetadata: true } });
    requireValue(new Set(products.map((p) => p.externalId)).size === productIds.length, "Select products from this Commerce7 connection's synchronized catalog.");
    requireValue(products.length === productIds.length, "Catalog product identity is ambiguous.");
    // Published terms and caps are immutable once any claim is, or ever was, economically or provider-active.
    // Only provably dead claims (see COMMERCE7_EDIT_SAFE_CLAIM) permit an edit; their frozen snapshots are never touched.
    // Disabling stays available separately and does not revoke issued rewards.
    if (existing) {
      const [total, safe] = await Promise.all([tx.commerceRewardRedemption.count({ where: { offerId } }), tx.commerceRewardRedemption.count({ where: { offerId, ...COMMERCE7_EDIT_SAFE_CLAIM } })]);
      if (!commerce7OfferEditable(existing.reservedClaimCount, total, safe)) throw new RewardClaimError("OFFER_HAS_CLAIMS", "This offer has issued, pending or unresolved claims. Disable it and create a new offer to change its terms.");
    }
    // Discount rewards are bearer coupons only. A legacy claimant-only discount record is never silently made public: the Brand
    // must re-save it as Anyone with the code AND confirm, and until then the stored record is left exactly as it was.
    if (!exclusive && eligibilityMode === "CLAIMANT_ONLY") throw new RewardClaimError("CLAIMANT_DISCOUNT_RETIRED", CLAIMANT_DISCOUNT_RETIRED_MESSAGE, 400);
    if (!exclusive && existing?.rewardMode === "DISCOUNT" && storedCommerce7Eligibility(existing.commerce7Config, existing.rewardMode) === "CLAIMANT_ONLY" && row?.confirmPublicEligibility !== true) throw new RewardClaimError("ELIGIBILITY_CHANGE_UNCONFIRMED", "This saved reward was restricted to the claiming customer. Confirm that its coupons may be redeemed by anyone with the code, then save again.", 400);
    // A branch the Coupon contract has no verified value for may only go live with a legacy offer's already-observed native template.
    // An exclusive offer's optional discount is a bearer coupon scoped to its one product.
    const couponEligibility = exclusive ? "ANYONE_WITH_CODE" : eligibilityMode;
    const supported = isCouponBranchSupported(couponEligibility, fields.appliesTo, contract);
    const retained = !exclusive && !supported && discountEnabled && existing ? retainLegacyTemplate(existing.commerce7Config, eligibilityMode, productIds) : null;
    // Every unverified option is reported, so a Brand fixing one (for example Claiming customer only) is not surprised by the next.
    const unverified = [
      ...(fields.isActive && discountEnabled && !supported && !retained ? [unverifiedBranchMessage(couponEligibility, fields.appliesTo, contract)] : []),
      ...(fields.isActive && discountEnabled && !isDiscountTypeSupported(fields.discountType, contract) ? [COMMERCE7_PERCENTAGE_UNVERIFIED_MESSAGE] : []),
    ];
    if (unverified.length) throw new RewardClaimError("COUPON_CONTRACT_UNVERIFIED", unverified.join(" "));
    // Exclusive offers freeze the one product and the ONE Customer Tag SQRATCH will grant (by UUID; the title is display-only),
    // re-checked here against the synchronized catalog. Nothing is written to Commerce7.
    let exclusiveAccess: { productId: string; securityAvailableTo: string; securityTagId: string; tagTitle: string } | null = null;
    if (exclusive) {
      requireValue(exclusiveTag && (exclusiveTagId === null || exclusiveTagId === exclusiveTag.id), "Choose the Customer Tag SQRATCH should grant.");
      const security = products.length === 1 ? commerce7ExclusiveSecurity(products[0].providerMetadata) : null;
      requireValue(security && security.tagIds.includes(exclusiveTag.id), "Choose a product secured to a Customer Tag in Commerce7, then sync products in SQRATCH.");
      if (fields.isActive && security.tagIds.length > 1 && !multiTagVerified(deps)) throw new RewardClaimError("MULTI_TAG_UNVERIFIED", EXCLUSIVE_STATUS_MESSAGES.MULTI_TAG_UNVERIFIED);
      exclusiveAccess = { productId: products[0].externalId, securityAvailableTo: COMMERCE7_EXCLUSIVE_SECURITY_AVAILABLE_TO, securityTagId: exclusiveTag.id, tagTitle: exclusiveTag.title };
    }
    const config = { eligibilityMode, discountEnabled, ...(retained ?? {}), ...(exclusiveAccess ? { exclusiveAccess } : {}) };
    const productRows = { create: products.map((p) => ({ externalProductId: p.externalId, title: p.title })) };
    if (existing) {
      await tx.brandRewardOfferProduct.deleteMany({ where: { offerId } });
      return tx.brandRewardOffer.update({ where: { id: offerId }, data: { ...fields, commerce7Config: config, products: productRows } });
    }
    return tx.brandRewardOffer.create({ data: { ...fields, brandId, provider: "COMMERCE7", connectionId: connection.id, sourceExternalAccountId: connection.externalAccountId, commerce7Config: config, products: productRows } });
  });
}
/** Offer columns that define what Enable validated. Capacity bookkeeping and updatedAt move with concurrent refunds and are excluded. */
function offerFingerprint(offer: BrandRewardOffer, productIds: string[]) {
  const terms = Object.fromEntries(Object.entries(offer).filter(([key]) => key !== "reservedClaimCount" && key !== "updatedAt"));
  return JSON.stringify({ terms, productIds: [...productIds].sort() });
}
type ConnectionRow = { id: string; brandId: string; externalAccountId: string | null; status: string; uninstalledAt: Date | null; providerMetadata: unknown };
function connectionFingerprint(row: ConnectionRow) {
  const metadata = row.providerMetadata;
  const currency = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? (metadata as Record<string, unknown>).currencyCode : null;
  return JSON.stringify({ id: row.id, brandId: row.brandId, externalAccountId: row.externalAccountId, status: row.status, uninstalledAt: row.uninstalledAt, currency });
}
/**
 * Brand enable/disable. Server-authoritative and explicit; never a blind flip. Neither action touches Commerce7, claims,
 * snapshots, points or capacity; only isActive changes.
 *
 * DISABLE is one conditional write. ENABLE validates OUTSIDE any transaction (connection resolution can be slow and must never
 * hold an interactive transaction open), then commits in one short transaction that re-reads the offer, its products and the
 * original connection row, fails closed if any of them changed since validation, and conditionally sets isActive=true.
 */
export async function setCommerce7OfferActive(brandId: string, offerId: string, action: unknown, deps = defaults) {
  if (action !== "ENABLE" && action !== "DISABLE") throw new RewardClaimError("INVALID_ACTION", "Choose Enable or Disable.", 400);
  const scope = { id: offerId, brandId, provider: "COMMERCE7" as const };
  const offer = await deps.db.brandRewardOffer.findFirst({ where: scope });
  if (!offer) throw new RewardClaimError("NOT_FOUND", "Reward offer not found.", 404);
  if (action === "DISABLE") {
    if (offer.isActive) await deps.db.brandRewardOffer.updateMany({ where: { ...scope, isActive: true }, data: { isActive: false } });
    return (await deps.db.brandRewardOffer.findFirst({ where: scope }))!;
  }
  if (offer.isActive) return offer;

  // Phase A: read-only validation, no transaction.
  const contract = deps.contract ?? COMMERCE7_COUPON_CONTRACT;
  if (!(deps.backendConfigured ?? (() => !!getCommerce7AppConfig()))()) throw new RewardClaimError("SETUP_INCOMPLETE", "Commerce7 rewards are not configured on the server. Contact SQRATCH support.");
  // The same original store a claim would require: Brand, connection, tenant identity and currency.
  const active = await getActiveCommerceConnection(brandId, "COMMERCE7");
  const unavailable = () => new RewardClaimError("CONNECTION_UNAVAILABLE", "Reconnect the original Commerce7 store before enabling this reward.");
  if (!active || !isConnectionUsable(active) || active.id !== offer.connectionId || active.externalAccountId !== offer.sourceExternalAccountId) throw unavailable();
  const connectionWhere = { id: offer.connectionId ?? "", brandId, provider: "COMMERCE7" as const, externalAccountId: offer.sourceExternalAccountId ?? "", status: "CONNECTED" as const, uninstalledAt: null };
  const stored = await deps.db.commerceConnection.findFirst({ where: connectionWhere });
  if (!stored) throw unavailable();
  const metadata = stored.providerMetadata;
  const storedCurrency = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata.currencyCode : null;
  if (active.currencyCode !== offer.currencyCode || storedCurrency !== offer.currencyCode) throw new RewardClaimError("CURRENCY_REVIEW_REQUIRED", "The store currency changed. Review this reward before enabling it.");
  const config = object(offer.commerce7Config);
  requireValue(config && storedCommerce7Eligibility(config, offer.rewardMode), "Reward configuration needs review.");
  if (offer.rewardMode === "DISCOUNT" && storedCommerce7Eligibility(config, offer.rewardMode) === "CLAIMANT_ONLY") throw new RewardClaimError("CLAIMANT_DISCOUNT_RETIRED", "This discount reward was saved as Claiming customer only, which is no longer offered. Edit it, confirm Anyone with the code, then enable it.");
  const productIds = (await deps.db.brandRewardOfferProduct.findMany({ where: { offerId }, select: { externalProductId: true } })).map((row) => row.externalProductId);
  // Limits, windows, discount, currency and draft-only modes: exactly the editor's validators, run on the stored terms.
  const input = parseCommerce7Offer(storedCommerce7OfferInput(offer, productIds), active.currencyCode);
  if (input.appliesTo === "SPECIFIC_PRODUCTS") {
    const products = await deps.db.connectedCommerceProduct.findMany({ where: { brandId, connectionId: offer.connectionId ?? "", provider: "COMMERCE7", externalId: { in: input.productIds }, isAvailable: true }, select: { externalId: true } });
    requireValue(new Set(products.map((product) => product.externalId)).size === input.productIds.length, "Select products from this Commerce7 connection's synchronized catalog.");
  }
  const snapshot = buildRewardSnapshot(offer, config, productIds, contract);
  if (!commerce7SnapshotIssuable(snapshot, contract)) {
    const discountBlocked = commerce7SnapshotDiscountBlocked(snapshot, contract);
    const branchBlocked = !commerce7SnapshotIssuable({ ...snapshot, discount: snapshot.discount && { ...snapshot.discount, type: "FIXED_AMOUNT" } }, contract);
    throw new RewardClaimError("COUPON_CONTRACT_UNVERIFIED", [...(branchBlocked ? [unverifiedBranchMessage(snapshot.exclusiveAccess ? "ANYONE_WITH_CODE" : snapshot.eligibilityMode, snapshot.appliesTo, contract)] : []), ...(discountBlocked ? [COMMERCE7_PERCENTAGE_UNVERIFIED_MESSAGE] : [])].join(" "));
  }
  // Exclusive access: the synchronized product must still match exactly, then live reads prove the tag and product security.
  const exclusiveProduct = (where: Pick<Prisma.TransactionClient, "connectedCommerceProduct">) => snapshot.exclusiveAccess ? where.connectedCommerceProduct.findFirst({ where: { brandId, connectionId: offer.connectionId ?? "", provider: "COMMERCE7", externalId: snapshot.exclusiveAccess.productId }, select: { externalId: true, isAvailable: true, providerMetadata: true } }) : Promise.resolve(null);
  const securityOf = (product: { isAvailable: boolean; providerMetadata: unknown } | null) => JSON.stringify(product ? { available: product.isAvailable, security: object(product.providerMetadata)?.security ?? null } : null);
  let validatedSecurity = securityOf(null);
  if (snapshot.exclusiveAccess) {
    const product = await exclusiveProduct(deps.db);
    const status = commerce7ExclusiveAccessStatus(config, product, multiTagVerified(deps));
    if (status !== "CONFIGURED") throw new RewardClaimError(status === "MULTI_TAG_UNVERIFIED" ? "MULTI_TAG_UNVERIFIED" : "EXCLUSIVE_REVIEW_REQUIRED", EXCLUSIVE_STATUS_MESSAGES[status]);
    const check = await verifyExclusiveProvider(deps.client(active.externalAccountId), snapshot.exclusiveAccess.productId, snapshot.exclusiveAccess.tagId, multiTagVerified(deps));
    if (!check.ok) throw new RewardClaimError(check.code, check.message);
    validatedSecurity = securityOf(product);
  }
  const validatedOffer = offerFingerprint(offer, productIds); const validatedConnection = connectionFingerprint(stored);

  // Phase B: short transaction. Database reads only, then one conditional write.
  const changed = () => new RewardClaimError("OFFER_CHANGED", "This reward or its Commerce7 store changed while it was being enabled. Reload and try again.");
  return rewardTransaction(deps.db, async (tx) => {
    const current = await tx.brandRewardOffer.findFirst({ where: scope });
    if (!current) throw new RewardClaimError("NOT_FOUND", "Reward offer not found.", 404);
    if (current.isActive) return current;
    const currentProducts = (await tx.brandRewardOfferProduct.findMany({ where: { offerId }, select: { externalProductId: true } })).map((row) => row.externalProductId);
    const connectionNow = await tx.commerceConnection.findFirst({ where: connectionWhere });
    if (offerFingerprint(current, currentProducts) !== validatedOffer || !connectionNow || connectionFingerprint(connectionNow) !== validatedConnection) throw changed();
    if (securityOf(await exclusiveProduct(tx)) !== validatedSecurity) throw changed();
    const enabled = await tx.brandRewardOffer.updateMany({ where: { ...scope, isActive: false }, data: { isActive: true } });
    if (enabled.count !== 1) throw changed();
    return (await tx.brandRewardOffer.findFirst({ where: scope }))!;
  });
}
/**
 * Exclusive Wine Access pre-check, before any debit or reservation and outside any transaction. Live, read-only: the frozen
 * tag and product security must still be valid, and the claimant's Commerce7 customer is resolved by exact verified email
 * and pinned for provisioning. It never decides the price: a voluntary claim always costs the Brand's configured points,
 * whatever tags the customer already holds (operator rule). Anything this cannot decide is left to reservation, which
 * repeats every database check and reports the precise refusal.
 */
export async function precheckCommerce7ExclusiveClaim(userId: string, offerId: string, requestKey: unknown, allowedBrandIds: string[], deps = defaults): Promise<{ providerCustomerId: string | null }> {
  const proceed = { providerCustomerId: null };
  const idempotencyKey = rewardIdempotencyKey(userId, offerId, requestKey);
  if (await deps.db.commerceRewardRedemption.findUnique({ where: { idempotencyKey } })) return proceed;
  const offer = await deps.db.brandRewardOffer.findFirst({ where: { id: offerId, provider: "COMMERCE7", brandId: { in: allowedBrandIds } } });
  const frozen = offer?.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" && offer.isActive ? frozenExclusiveAccess(offer.commerce7Config) : null;
  if (!offer || !frozen || !backendReady(deps)) return proceed;
  const connection = await deps.db.commerceConnection.findFirst({ where: { id: offer.connectionId ?? "", brandId: offer.brandId, provider: "COMMERCE7", externalAccountId: offer.sourceExternalAccountId ?? "", status: "CONNECTED", uninstalledAt: null } });
  const user = await deps.db.user.findUnique({ where: { id: userId }, select: { email: true, isActive: true, isEmailVerified: true, emailVerifiedAt: true } });
  if (!connection || !user?.isActive || !user.isEmailVerified || !user.emailVerifiedAt || !user.email) return proceed;
  // A closed, sold-out or per-user-exhausted offer is refused by reservation without any provider read.
  const userTotal = await deps.db.commerceRewardRedemption.count({ where: { offerId, userId, slotReleased: false } });
  if (commerce7OfferUnavailableReason(offer, offer.reservedClaimCount, userTotal, deps.now())) return proceed;
  const product = await deps.db.connectedCommerceProduct.findFirst({ where: { brandId: offer.brandId, connectionId: connection.id, provider: "COMMERCE7", externalId: frozen.productId }, select: { externalId: true, isAvailable: true, providerMetadata: true } });
  if (commerce7ExclusiveAccessStatus(offer.commerce7Config, product, multiTagVerified(deps)) !== "CONFIGURED") return proceed;
  const client = deps.client(connection.externalAccountId);
  const check = await verifyExclusiveProvider(client, frozen.productId, frozen.tagId, multiTagVerified(deps));
  if (!check.ok) throw new RewardClaimError(check.code, check.message);
  let customer: NativeCustomer | null;
  try { customer = await client.customer(user.email); }
  catch (error) {
    if (error instanceof Commerce7RewardError && error.code === "CUSTOMER_AMBIGUOUS") throw new RewardClaimError("CUSTOMER_AMBIGUOUS", "More than one Commerce7 customer uses your verified email. The store must resolve this before you can claim.");
    throw error;
  }
  if (!customer) return proceed; // reservation waits for a Commerce7 account with the same verified email
  return { providerCustomerId: customer.id };
}
/** The claim endpoint's whole flow: exclusive pre-check, then the unchanged reservation and provisioning saga. */
export async function claimCommerce7Reward(userId: string, offerId: string, requestKey: unknown, allowedBrandIds: string[], deps = defaults) {
  const precheck = await precheckCommerce7ExclusiveClaim(userId, offerId, requestKey, allowedBrandIds, deps);
  const claim = await reserveCommerce7Claim(userId, offerId, requestKey, allowedBrandIds, deps, { providerCustomerId: precheck.providerCustomerId });
  return { claim: (await provisionCommerce7Claim(claim.id, userId, deps)) ?? claim };
}
export async function reserveCommerce7Claim(userId: string, offerId: string, requestKey: unknown, allowedBrandIds: string[], deps = defaults, pinned: { providerCustomerId: string | null } = { providerCustomerId: null }) {
  const idempotencyKey = rewardIdempotencyKey(userId, offerId, requestKey);
  return rewardTransaction(deps.db, async (tx) => {
    const existing = await tx.commerceRewardRedemption.findUnique({ where: { idempotencyKey } });
    if (existing) return existing;
    const offer = await tx.brandRewardOffer.findFirst({ where: { id: offerId, provider: "COMMERCE7", brandId: { in: allowedBrandIds } } });
    if (!offer) throw new RewardClaimError("NOT_FOUND", "Reward offer is not available.", 404);
    const connection = await tx.commerceConnection.findFirst({ where: { id: offer.connectionId ?? "", brandId: offer.brandId, provider: "COMMERCE7", externalAccountId: offer.sourceExternalAccountId ?? "", status: "CONNECTED", uninstalledAt: null } });
    if (!connection) throw new RewardClaimError("CONNECTION_UNAVAILABLE", "The original Commerce7 store must be connected.");
    const user = await tx.user.findUnique({ where: { id: userId }, select: { email: true, isActive: true, isEmailVerified: true, emailVerifiedAt: true } });
    if (!user?.isActive) throw new RewardClaimError("ACCOUNT_UNAVAILABLE", "Your SQRATCH account is unavailable.", 403);
    const metadata = connection.providerMetadata;
    const currency = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata.currencyCode : null;
    if (currency !== offer.currencyCode) throw new RewardClaimError("CURRENCY_REVIEW_REQUIRED", "The store currency changed. The Brand must review this reward.");
    const total = offer.reservedClaimCount;
    const userTotal = await tx.commerceRewardRedemption.count({ where: { offerId, userId, slotReleased: false } });
    const now = deps.now();
    const unavailable = commerce7OfferUnavailableReason(offer, total, userTotal, now);
    if (unavailable) throw new RewardClaimError(unavailable.code, unavailable.message);
    const rawConfig = offer.commerce7Config;
    const config = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig) ? rawConfig : null;
    requireValue(config, "Reward configuration needs review.");
    const contract = deps.contract ?? COMMERCE7_COUPON_CONTRACT;
    // Everything the native coupon needs is frozen here, from this offer's own rows. No provider template is read at any stage.
    const offerProducts = offer.appliesTo === "SPECIFIC_PRODUCTS" ? await tx.brandRewardOfferProduct.findMany({ where: { offerId }, select: { externalProductId: true } }) : [];
    const snapshot = buildRewardSnapshot(offer, config, offerProducts.map((row) => row.externalProductId), contract);
    // Refuse before any debit, reservation or provider call when the coupon contract cannot express this reward.
    if (!commerce7SnapshotIssuable(snapshot, contract)) throw new RewardClaimError("COUPON_CONTRACT_UNVERIFIED", "This reward cannot be claimed yet. The store must finish setting it up.");
    if (snapshot.eligibilityMode === "CLAIMANT_ONLY" && (!user.isEmailVerified || !user.emailVerifiedAt || !user.email)) throw new RewardClaimError("EMAIL_VERIFICATION_REQUIRED", "Verify your SQRATCH email before claiming this reward.", 403);
    if (offer.appliesTo === "SPECIFIC_PRODUCTS") {
      const products = await tx.connectedCommerceProduct.findMany({ where: { brandId: offer.brandId, connectionId: connection.id, provider: "COMMERCE7", externalId: { in: snapshot.productIds }, isAvailable: true }, select: { externalId: true } });
      if (!snapshot.productIds.length || products.length !== snapshot.productIds.length || new Set(products.map((product) => product.externalId)).size !== snapshot.productIds.length) throw new RewardClaimError("PRODUCT_UNAVAILABLE", "A reward product is no longer available. The store must review this offer.");
    }
    const exclusiveTagId = snapshot.exclusiveAccess?.tagId ?? null;
    if (offer.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS") {
      const product = await tx.connectedCommerceProduct.findFirst({ where: { brandId: offer.brandId, connectionId: connection.id, provider: "COMMERCE7", externalId: snapshot.productIds[0] }, select: { externalId: true, isAvailable: true, providerMetadata: true } });
      const status = commerce7ExclusiveAccessStatus(config, product, multiTagVerified(deps));
      if (!exclusiveTagId || status !== "CONFIGURED") throw new RewardClaimError(status === "MULTI_TAG_UNVERIFIED" ? "MULTI_TAG_UNVERIFIED" : "EXCLUSIVE_UNAVAILABLE", "This exclusive reward is not available right now. The store must review it.");
      // One in-flight grant per user and Customer Tag: the native membership POST is not idempotent, so concurrent claims for
      // the same access must never race it. A finished claim does not block; its successor finds the membership present.
      const inFlight = await tx.commerceRewardRedemption.count({ where: { userId, provider: "COMMERCE7", connectionId: connection.id, providerTagId: exclusiveTagId, rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", status: "POINTS_DEBITED" } });
      if (inFlight) throw new RewardClaimError("CLAIM_IN_PROGRESS", "Another claim for this Commerce7 access is still being processed. Check that claim before claiming again.");
    }
    const capacity = await tx.brandRewardOffer.updateMany({ where: { id: offer.id, brandId: offer.brandId, provider: "COMMERCE7", isActive: true, reservedClaimCount: total }, data: { reservedClaimCount: { increment: 1 } } });
    if (capacity.count !== 1) throw new RewardClaimError("OFFER_CHANGED", "Reward availability changed. Reload and try again.");
    const claim = await tx.commerceRewardRedemption.create({ data: {
      userId, brandId: offer.brandId, offerId, provider: "COMMERCE7", connectionId: connection.id, externalAccountId: connection.externalAccountId,
      rewardMode: offer.rewardMode, idempotencyKey, code: `SQRA${randomBytes(16).toString("hex").toUpperCase()}`,
      status: "POINTS_DEBITED", provisioningState: snapshot.eligibilityMode === "CLAIMANT_ONLY" && !(exclusiveTagId && pinned.providerCustomerId) ? "AWAITING_CUSTOMER" : "PROVISIONING", verifiedEmailAt: snapshot.eligibilityMode === "CLAIMANT_ONLY" ? user.emailVerifiedAt : null,
      ...(exclusiveTagId ? { providerTagId: exclusiveTagId, providerCustomerId: pinned.providerCustomerId } : {}),
      pointsCost: offer.pointsCost, discountType: offer.discountType, discountAmountCents: offer.discountAmountCents,
      discountPercentageBasisPoints: offer.discountPercentageBasisPoints, currencyCode: offer.currencyCode,
      rewardConfigSnapshot: serializeRewardSnapshot(snapshot), expiresAt: floorToMinute(new Date(now.getTime() + offer.codeValidDays * 86400000)),
    } });
    const spent = await applyPointLedgerEvent({ userId, points: offer.pointsCost, type: "SPEND", reason: "COMMERCE_REWARD_REDEMPTION", sourceType: "COMMERCE_REWARD_REDEMPTION", sourceId: claim.id, commerceRewardRedemptionId: claim.id, idempotencyKey: `c7-reward-spend:${claim.id}`, db: tx });
    if (!spent.applied) throw new RewardClaimError("INSUFFICIENT_POINTS", "You do not have enough spendable points.");
    return claim;
  });
}
async function refundUnissuedClaim(tx: Prisma.TransactionClient, claim: CommerceRewardRedemption, message: string) {
  if (!commerce7ClaimRefundable(claim)) throw new RewardClaimError("MANUAL_REVIEW_REQUIRED", "Provider issuance may have occurred. The store must review this claim before any refund.");
  const result = await applyPointLedgerEvent({ userId: claim.userId, points: claim.pointsCost, type: "REFUND", reason: "COMMERCE_REWARD_REFUND", sourceType: "COMMERCE_REWARD_REFUND", sourceId: claim.id, commerceRewardRedemptionId: claim.id, idempotencyKey: `c7-reward-refund:${claim.id}`, db: tx });
  if (!result.applied && result.reason !== "DUPLICATE") throw new RewardClaimError("REFUND_FAILED", "The refund could not be recorded.");
  const released = await tx.brandRewardOffer.updateMany({ where: { id: claim.offerId, provider: "COMMERCE7", reservedClaimCount: { gt: 0 } }, data: { reservedClaimCount: { decrement: 1 } } });
  if (released.count !== 1) throw new RewardClaimError("CAPACITY_REVIEW_REQUIRED", "Reward capacity needs review before points can be returned.");
  return tx.commerceRewardRedemption.update({ where: { id: claim.id }, data: { status: "REFUNDED", provisioningState: "FAILED_FINAL", slotReleased: true, provisioningOwner: null, errorMessage: message } });
}
export async function cancelCommerce7Claim(userId: string, claimId: string, deps = defaults) {
  return rewardTransaction(deps.db, async (tx) => {
    const claim = await tx.commerceRewardRedemption.findFirst({ where: { id: claimId, userId, provider: "COMMERCE7" } });
    if (!claim) throw new RewardClaimError("NOT_FOUND", "Reward claim not found.", 404);
    if (claim.status === "REFUNDED") return claim;
    if (claim.provisioningOwner) throw new RewardClaimError("PROVISIONING", "This claim is being checked. Try again after it finishes.");
    return refundUnissuedClaim(tx, claim, "Claim cancelled; points returned.");
  });
}
type ProvisionStage = "SETUP" | "ACCESS_VERIFY" | "CUSTOMER_LOOKUP" | "TAG_CREATE" | "TAG_ASSIGN" | "MEMBERSHIP_VERIFY" | "COUPON_RECOVERY" | "COUPON_CREATE" | "COUPON_VERIFY";
/** Failures that mean a provider resource may exist or the frozen terms are inconsistent. Only an operator may resolve them. */
const MANUAL_REVIEW_CODES = ["TAG_RESULT_UNKNOWN", "COUPON_RESULT_UNKNOWN", "COUPON_CONFLICT", "CUSTOMER_CHANGED", "EXPIRED_PENDING_REVIEW", "SNAPSHOT_MISMATCH", "MEMBERSHIP_RESULT_UNKNOWN", "MEMBERSHIP_CHANGED"];
/** Live checks that withdrew an exclusive grant before anything was written: refundable while no write was ever attempted. */
const ACCESS_WITHDRAWN_CODES = ["TAG_UNAVAILABLE", "PRODUCT_SECURITY_CHANGED", "MULTI_TAG_UNVERIFIED"];
export async function provisionCommerce7Claim(claimId: string, userId?: string, deps = defaults) {
  const owner = randomUUID(); const now = deps.now(); const contract = deps.contract ?? COMMERCE7_COUPON_CONTRACT;
  // Owner is durable. A timed-out caller cannot release another process's work.
  // No age-based stealing: a crashed owner requires operator recovery.
  const won = await deps.db.commerceRewardRedemption.updateMany({ where: { id: claimId, provider: "COMMERCE7", ...(userId ? { userId } : {}), status: "POINTS_DEBITED", provisioningOwner: null, needsManualReview: false, OR: [{ providerLastCheckedAt: null }, { providerLastCheckedAt: { lt: new Date(now.getTime() - 30000) } }] }, data: { provisioningOwner: owner, provisioningStartedAt: now, providerLastCheckedAt: now, provisioningState: "PROVISIONING", reconcileAttempts: { increment: 1 } } });
  if (!won.count) return deps.db.commerceRewardRedemption.findFirst({ where: { id: claimId, provider: "COMMERCE7", ...(userId ? { userId } : {}) } });
  let claim = await deps.db.commerceRewardRedemption.findUniqueOrThrow({ where: { id: claimId } });
  const update = async (data: Prisma.CommerceRewardRedemptionUpdateManyMutationInput) => {
    const result = await deps.db.commerceRewardRedemption.updateMany({ where: { id: claimId, provisioningOwner: owner }, data });
    if (result.count !== 1) throw new RewardClaimError("OWNERSHIP_LOST", "Claim ownership needs review.");
    claim = await deps.db.commerceRewardRedemption.findUniqueOrThrow({ where: { id: claimId } });
  };
  let stage: ProvisionStage = "SETUP";
  const exclusive = claim.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS";
  try {
    await connectionForClaim(claim, deps.db);
    if (!exclusive && claim.rewardMode !== "DISCOUNT") throw new Commerce7RewardError("UNSUPPORTED_ACCESS");
    const snapshot = parseRewardSnapshot(claim.rewardConfigSnapshot);
    if (exclusive !== !!snapshot.exclusiveAccess || (snapshot.exclusiveAccess && claim.providerTagId !== snapshot.exclusiveAccess.tagId)) throw new RewardClaimError("SNAPSHOT_MISMATCH", "The reward's frozen terms differ from the claim. The store must review this claim.");
    // The gate precedes every provider read and write, so a refusal can never leave a provider resource behind.
    if (!commerce7SnapshotIssuable(snapshot, contract)) throw new RewardClaimError("COUPON_CONTRACT_UNVERIFIED", "This reward cannot be issued yet.");
    const terms = !exclusive || snapshot.discount ? couponTermsForClaim(snapshot, claim) : null;
    // A pre-refinement snapshot carries its discount kind only in the claim columns; gate it here, before any provider call.
    if (terms && !isDiscountTypeSupported(terms.discountType, contract)) throw new RewardClaimError("COUPON_CONTRACT_UNVERIFIED", "This reward cannot be issued yet.");
    const user = await deps.db.user.findUnique({ where: { id: claim.userId }, select: { email: true, isActive: true, isEmailVerified: true, emailVerifiedAt: true } });
    if (!user?.isActive) throw new RewardClaimError("ACCOUNT_UNAVAILABLE", "Your SQRATCH account is unavailable.", 403);
    if (snapshot.eligibilityMode === "CLAIMANT_ONLY" && (!user.isEmailVerified || !user.email || !user.emailVerifiedAt || user.emailVerifiedAt.getTime() !== claim.verifiedEmailAt?.getTime())) throw new RewardClaimError("EMAIL_CHANGED", "Your verified email changed. Contact the store or cancel this pending claim.");
    const expiresAt = claim.expiresAt;
    if (!expiresAt || expiresAt <= now) {
      if (commerce7ClaimRefundable(claim)) return await rewardTransaction(deps.db, async (tx) => refundUnissuedClaim(tx, await tx.commerceRewardRedemption.findUniqueOrThrow({ where: { id: claimId } }), "Reward expired before issuance; points returned."));
      throw new RewardClaimError("EXPIRED_PENDING_REVIEW", "The issuance window ended. The store must review the provider result.");
    }
    const client = deps.client(claim.externalAccountId);
    if (snapshot.exclusiveAccess) {
      // Exclusive Wine Access: grant the merchant's existing Manual Customer Tag at most once, verified by a fresh read.
      const access = snapshot.exclusiveAccess;
      const email = normalizeRewardEmail(user.email!);
      if (!claim.membershipWriteAttempted && !claim.membershipOwnership) {
        stage = "ACCESS_VERIFY";
        const check = await verifyExclusiveProvider(client, access.productId, access.tagId, multiTagVerified(deps));
        if (!check.ok) throw new RewardClaimError(check.code, check.message);
      }
      stage = "CUSTOMER_LOOKUP";
      let customer: NativeCustomer | null;
      if (claim.providerCustomerId) {
        try { customer = await client.customerById(claim.providerCustomerId); }
        catch (error) {
          if (error instanceof Commerce7RewardError && error.code === "NOT_FOUND") throw new RewardClaimError("CUSTOMER_CHANGED", "The Commerce7 customer for this claim no longer exists. The store must review this claim.");
          throw error;
        }
      } else customer = await client.customer(email);
      if (!customer) { await update({ provisioningState: "AWAITING_CUSTOMER", errorMessage: "Create or use a Commerce7 account with your verified SQRATCH email, then check again." }); return claim; }
      if (!customer.emails.includes(email) || (claim.providerCustomerId && claim.providerCustomerId !== customer.id)) throw new RewardClaimError("CUSTOMER_CHANGED", "Commerce7 customer identity changed. The store must review this claim.");
      if (!claim.providerCustomerId) await update({ providerCustomerId: customer.id });
      const held = customerTagCount(customer, access.tagId);
      stage = "MEMBERSHIP_VERIFY";
      if (claim.membershipOwnership) {
        // Ownership was recorded on an earlier pass. Finalize only while the membership is still present.
        if (!held) throw new RewardClaimError("MEMBERSHIP_CHANGED", "The Customer Tag was removed in Commerce7 before this claim finished. The store must review it.");
      } else if (held) {
        if (claim.membershipWriteAttempted) {
          // Present after SQRATCH's own attempt, which followed verified absence. Only the 201 relation ID proves SQRATCH wrote it.
          await update({ membershipOwnership: claim.providerMembershipId ? "SQRATCH_GRANTED" : "UNVERIFIED", membershipVerifiedAt: now, entitlementEverGranted: true, errorMessage: null });
        } else {
          // The customer already holds the chosen tag. SQRATCH writes nothing, never treats this membership as its own, and
          // still completes the voluntary claim at its configured points cost (operator rule): the claim settles below.
          await update({ membershipOwnership: "PRE_EXISTING", membershipVerifiedAt: now });
        }
      } else {
        // Absent. After an attempted write this is never retried blindly: a repeated POST creates a duplicate membership.
        if (claim.membershipWriteAttempted && claim.providerMembershipId) throw new RewardClaimError("MEMBERSHIP_NOT_CONFIRMED", "Commerce7 accepted the access grant but has not confirmed it yet. Check again shortly.");
        if (claim.membershipWriteAttempted) throw new RewardClaimError("MEMBERSHIP_RESULT_UNKNOWN", "A previous access request needs store review. No duplicate request will be sent.");
        stage = "TAG_ASSIGN";
        await update({ membershipWriteAttempted: true });
        let membership: { id: string };
        try { membership = await client.assignCustomerTag(customer.id, access.tagId); }
        catch (error) {
          // Only an explicit, non-ambiguous refusal proves nothing was written. Timeouts, 408/409 and 5xx keep the marker.
          if (error instanceof Commerce7RewardError && !error.uncertain) await update({ membershipWriteAttempted: false });
          throw error;
        }
        await update({ providerMembershipId: membership.id });
        stage = "MEMBERSHIP_VERIFY";
        const confirmed = await client.customerById(customer.id);
        if (!confirmed.emails.includes(email) || customerTagCount(confirmed, access.tagId) < 1) throw new RewardClaimError("MEMBERSHIP_NOT_CONFIRMED", "Commerce7 accepted the access grant but has not confirmed it yet. Check again shortly.");
        await update({ membershipOwnership: "SQRATCH_GRANTED", membershipVerifiedAt: now, entitlementEverGranted: true, errorMessage: null });
      }
    } else if (snapshot.eligibilityMode === "CLAIMANT_ONLY") {
      const email = user.email!;
      const hadTag = !!claim.providerTagId;
      stage = "CUSTOMER_LOOKUP";
      const customer = claim.providerCustomerId ? await client.customerById(claim.providerCustomerId) : await client.customer(email);
      if (!customer) { await update({ provisioningState: "AWAITING_CUSTOMER", errorMessage: "Create or use a Commerce7 account with your verified SQRATCH email, then retry." }); return claim; }
      if (!customer.emails.includes(normalizeRewardEmail(email)) || (claim.providerCustomerId && claim.providerCustomerId !== customer.id)) throw new RewardClaimError("CUSTOMER_CHANGED", "Commerce7 customer identity changed. The store must review this claim.");
      await update({ providerCustomerId: customer.id });
      if (!claim.providerTagId) {
        stage = "TAG_CREATE";
        let tag = await client.findTag(claim.id);
        if (!tag) {
          if (claim.tagCreateAttempted) throw new RewardClaimError("TAG_RESULT_UNKNOWN", "A previous tag request needs provider review. No duplicate tag will be created.");
          await update({ tagCreateAttempted: true });
          try { tag = await client.createTag(claim.id); }
          catch (error) { if (error instanceof Commerce7RewardError && !error.uncertain) await update({ tagCreateAttempted: false }); throw error; }
        }
        await update({ providerTagId: tag.id });
      }
      // Re-read a newly created/recovered tag's membership, using the proven
      // tag filter. Subsequent checks use the pinned customer ID, avoiding an
      // expensive full tenant email scan on every pending claim retry.
      stage = "MEMBERSHIP_VERIFY";
      const eligible = hadTag ? customer : await client.customerById(customer.id);
      const exclusiveMember = await client.tagOnlyForCustomer(claim.providerTagId!, customer.id);
      if (!eligible || eligible.id !== customer.id || !eligible.emails.includes(normalizeRewardEmail(email)) || !eligible.tagIds.includes(claim.providerTagId!) || !exclusiveMember) {
        await update({ provisioningState: "AWAITING_ELIGIBILITY", lastReconcileReason: "MANUAL_PROVIDER_SETUP_REQUIRED", errorMessage: "The store must assign this claim's Customer tag to your matching Commerce7 customer. Use the same email at checkout." }); return claim;
      }
    }
    let issuedCoupon: NativeCoupon | null = null;
    if (terms) {
      // The coupon is built from the frozen snapshot and this claim's own identifiers; no merchant-created provider object is involved.
      const scope = couponScopeForSnapshot(snapshot, claim.providerTagId, contract);
      if (!scope.ok) throw new RewardClaimError("COUPON_CONTRACT_UNVERIFIED", "This reward cannot be issued yet.");
      const payload = buildCommerce7RewardCoupon({ terms, scope: scope.scope, code: claim.code, claimId: claim.id, startsAt: claim.createdAt, endsAt: expiresAt }, contract);
      stage = "COUPON_RECOVERY";
      let coupon = await client.findCoupon(claim.code);
      if (!coupon) {
        if (claim.couponCreateAttempted) throw new RewardClaimError("COUPON_RESULT_UNKNOWN", "A previous coupon request needs provider review. Points remain reserved and no duplicate coupon will be created.");
        stage = "COUPON_CREATE";
        await update({ couponCreateAttempted: true });
        try { coupon = await client.createCoupon(payload); }
        catch (error) {
          // Only an explicit, non-ambiguous refusal proves this POST created
          // nothing. Transport errors, timeouts and 5xx keep the attempt marker.
          if (error instanceof Commerce7RewardError && !error.uncertain) await update({ couponCreateAttempted: false });
          throw error;
        }
      }
      stage = "COUPON_VERIFY";
      if (!couponMatches(coupon, payload)) throw new RewardClaimError("COUPON_CONFLICT", "Provider coupon terms differ from the reserved reward. Store review is required.");
      issuedCoupon = coupon;
    }
    await rewardTransaction(deps.db, async (tx) => {
      const issued = await tx.commerceRewardRedemption.updateMany({ where: { id: claimId, provisioningOwner: owner, status: "POINTS_DEBITED" }, data: { status: "ISSUED", provisioningState: "READY", externalDiscountId: issuedCoupon?.id ?? null, externalDiscountStatus: issuedCoupon?.status ?? null, issuedAt: now, entitlementEverGranted: true, errorMessage: null, lastReconcileReason: null } });
      if (issued.count !== 1) throw new RewardClaimError("OWNERSHIP_LOST", "Claim ownership needs review.");
    });
  } catch (error) {
    const known = error instanceof RewardClaimError || error instanceof Commerce7RewardError;
    const definitive = error instanceof Commerce7RewardError && !error.uncertain;
    // Once access was granted, a definitive coupon refusal can never succeed on retry, and the points are never refunded.
    const discountRefusedAfterAccess = exclusive && claim.entitlementEverGranted && definitive && stage === "COUPON_CREATE" && error.code === "WRITE_REJECTED";
    const manual = (error instanceof RewardClaimError && MANUAL_REVIEW_CODES.includes(error.code)) || discountRefusedAfterAccess;
    const ambiguous = error instanceof Commerce7RewardError && error.uncertain;
    const code = known ? error.code : "UNEXPECTED";
    // Closed vocabulary only: never a coupon code, provider body, header, email, customer, tag or credential.
    console.warn({ event: "commerce7_reward_provisioning_failed", stage, code, uncertain: ambiguous, provider: "COMMERCE7", connectionId: claim.connectionId, claimId: claim.id });
    const message = discountRefusedAfterAccess ? "Your Commerce7 access was granted, but the discount could not be issued. The store must review this claim." : known ? error.message : "Reward processing failed. Retry or contact the store.";
    await deps.db.commerceRewardRedemption.updateMany({ where: { id: claimId, provisioningOwner: owner, status: "POINTS_DEBITED" }, data: { provisioningState: manual || ambiguous ? "MANUAL_REVIEW" : "FAILED_RETRYABLE", needsManualReview: manual || ambiguous, lastReconcileReason: `${stage}:${code}`, errorMessage: message } });
    // A definitive refusal before any benefit existed returns the points. Anything that may have created a coupon or a
    // membership never does.
    const refused = definitive && (error.code === "SETUP_INCOMPLETE" || (error.code === "WRITE_REJECTED" && (stage === "COUPON_CREATE" || stage === "TAG_CREATE" || stage === "TAG_ASSIGN")) || (error.code === "NOT_FOUND" && stage === "TAG_ASSIGN"));
    const unissuable = error instanceof RewardClaimError && error.code === "COUPON_CONTRACT_UNVERIFIED";
    const withdrawn = error instanceof RewardClaimError && ACCESS_WITHDRAWN_CODES.includes(error.code);
    if ((refused || unissuable || withdrawn) && !discountRefusedAfterAccess && commerce7ClaimRefundable(claim)) {
      const refundMessage = unissuable ? "This reward cannot be issued yet; points returned."
        : withdrawn ? "This exclusive reward is no longer available in Commerce7; points returned."
        : error.message === "Commerce7 rewards setup is incomplete." ? "Commerce7 rejected reward authorization; points returned."
        : stage === "TAG_ASSIGN" ? "Commerce7 could not grant this access; points returned." : "Commerce7 could not accept this reward; points returned.";
      return await rewardTransaction(deps.db, async (tx) => refundUnissuedClaim(tx, await tx.commerceRewardRedemption.findUniqueOrThrow({ where: { id: claimId } }), refundMessage));
    }
  } finally {
    await deps.db.commerceRewardRedemption.updateMany({ where: { id: claimId, provisioningOwner: owner }, data: { provisioningOwner: null } });
  }
  return deps.db.commerceRewardRedemption.findUniqueOrThrow({ where: { id: claimId } });
}
export async function reconcileCommerce7Claims(deps = defaults) {
  // Expiry ends a coupon's validity. Access-only exclusive claims carry no coupon; their Commerce7 access is not expired here.
  const expired = await deps.db.commerceRewardRedemption.findMany({ where: { provider: "COMMERCE7", status: "ISSUED", expiresAt: { lte: deps.now() }, externalDiscountId: { not: null } }, take: 20, select: { id: true } });
  if (expired.length) await deps.db.commerceRewardRedemption.updateMany({ where: { id: { in: expired.map((row) => row.id) }, status: "ISSUED" }, data: { status: "EXPIRED" } });
  const rows = await deps.db.commerceRewardRedemption.findMany({ where: { provider: "COMMERCE7", status: "POINTS_DEBITED", provisioningOwner: null, needsManualReview: false, reconcileAttempts: { lt: 20 }, OR: [{ providerLastCheckedAt: null }, { providerLastCheckedAt: { lt: new Date(deps.now().getTime() - 300000) } }] }, orderBy: { providerLastCheckedAt: { sort: "asc", nulls: "first" } }, take: 1, select: { id: true } });
  let checked = 0; let failed = 0;
  for (const row of rows) { try { await provisionCommerce7Claim(row.id, undefined, deps); checked++; } catch { failed++; } }
  return { checked, failed };
}
export type { BrandRewardOffer };
