import { randomBytes, randomUUID } from "node:crypto";
import { Prisma, type BrandRewardOffer, type CommerceRewardRedemption } from "@prisma/client";
import prisma from "./prisma";
import { storedCommerce7Eligibility, type Commerce7RewardEligibility } from "./commerce7-reward-eligibility";
import { COMMERCE7_COUPON_CONTRACT, isCouponBranchSupported, type Commerce7CouponAppliesTo, type CouponContract } from "./commerce7-coupon-contract";
import { applyPointLedgerEvent } from "./points";
import { getActiveCommerceConnection, isConnectionUsable } from "./commerce/connection-service";
import { Commerce7RewardsClient, Commerce7RewardError, buildCommerce7RewardCoupon, couponMatches, floorToMinute, normalizeRewardEmail, object } from "./commerce/providers/commerce7-rewards-client";
import { buildRewardSnapshot, commerce7OfferUnavailableReason, commerce7SnapshotIssuable, couponScopeForSnapshot, couponTermsForClaim, parseCommerce7Offer, parseRewardSnapshot, requireValue, retainLegacyTemplate, RewardClaimError, rewardIdempotencyKey, serializeRewardSnapshot } from "./commerce7-reward-domain";

type Db = typeof prisma;
/** `contract` defaults to the verified production Coupon contract; only tests inject another. */
export type Commerce7RewardDeps = { db: Db; client: (tenant: string) => Commerce7RewardsClient; now: () => Date; contract?: CouponContract };
const defaults: Commerce7RewardDeps = { db: prisma, client: (tenant) => new Commerce7RewardsClient(tenant), now: () => new Date() };
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
function unverifiedBranchMessage(eligibilityMode: Commerce7RewardEligibility, appliesTo: Commerce7CouponAppliesTo, contract: CouponContract) {
  if (!isCouponBranchSupported(eligibilityMode, "ALL_PRODUCTS", contract)) return "Claiming-customer-only rewards can be saved as drafts but cannot be activated yet. Choose Anyone with the code to go live.";
  return appliesTo === "SPECIFIC_PRODUCTS" ? "Selected-product rewards can be saved as drafts but cannot be activated yet. Choose All products to go live." : "This reward option cannot be activated yet.";
}
/** Stores and validates SQRATCH configuration only. Offers own no provider resources, so a save never touches Commerce7. */
export async function saveCommerce7Offer(brandId: string, body: unknown, offerId?: string, deps = defaults) {
  const connection = await getActiveCommerceConnection(brandId, "COMMERCE7");
  if (!connection || !isConnectionUsable(connection)) throw new RewardClaimError("CONNECTION_UNAVAILABLE", "Connect Commerce7 before configuring rewards.");
  const contract = deps.contract ?? COMMERCE7_COUPON_CONTRACT;
  const row = object(body);
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
    const { productIds, discountEnabled, eligibilityMode, ...fields } = parseCommerce7Offer(inputBody, connection.currencyCode);
    const products = await tx.connectedCommerceProduct.findMany({ where: { brandId, connectionId: connection.id, provider: "COMMERCE7", externalId: { in: productIds }, isAvailable: true }, select: { externalId: true, title: true } });
    requireValue(new Set(products.map((p) => p.externalId)).size === productIds.length, "Select products from this Commerce7 connection's synchronized catalog.");
    requireValue(products.length === productIds.length, "Catalog product identity is ambiguous.");
    // Published terms and caps are immutable once any reservation exists.
    // Disabling stays available separately and does not revoke issued rewards.
    if (existing && (existing.reservedClaimCount > 0 || await tx.commerceRewardRedemption.count({ where: { offerId } }))) throw new RewardClaimError("OFFER_HAS_CLAIMS", "This offer has claims. Disable it and create a new offer to change its terms.");
    // A branch the Coupon contract has no verified value for may only go live with a legacy offer's already-observed native template.
    const supported = isCouponBranchSupported(eligibilityMode, fields.appliesTo, contract);
    const retained = !supported && discountEnabled && existing ? retainLegacyTemplate(existing.commerce7Config, eligibilityMode, productIds) : null;
    if (fields.isActive && discountEnabled && !supported && !retained) throw new RewardClaimError("COUPON_CONTRACT_UNVERIFIED", unverifiedBranchMessage(eligibilityMode, fields.appliesTo, contract));
    const config = { eligibilityMode, discountEnabled, ...(retained ?? {}) };
    const productRows = { create: products.map((p) => ({ externalProductId: p.externalId, title: p.title })) };
    if (existing) {
      await tx.brandRewardOfferProduct.deleteMany({ where: { offerId } });
      return tx.brandRewardOffer.update({ where: { id: offerId }, data: { ...fields, commerce7Config: config, products: productRows } });
    }
    return tx.brandRewardOffer.create({ data: { ...fields, brandId, provider: "COMMERCE7", connectionId: connection.id, sourceExternalAccountId: connection.externalAccountId, commerce7Config: config, products: productRows } });
  });
}
export async function reserveCommerce7Claim(userId: string, offerId: string, requestKey: unknown, allowedBrandIds: string[], deps = defaults) {
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
    const capacity = await tx.brandRewardOffer.updateMany({ where: { id: offer.id, brandId: offer.brandId, provider: "COMMERCE7", isActive: true, reservedClaimCount: total }, data: { reservedClaimCount: { increment: 1 } } });
    if (capacity.count !== 1) throw new RewardClaimError("OFFER_CHANGED", "Reward availability changed. Reload and try again.");
    const claim = await tx.commerceRewardRedemption.create({ data: {
      userId, brandId: offer.brandId, offerId, provider: "COMMERCE7", connectionId: connection.id, externalAccountId: connection.externalAccountId,
      rewardMode: offer.rewardMode, idempotencyKey, code: `SQRA${randomBytes(16).toString("hex").toUpperCase()}`,
      status: "POINTS_DEBITED", provisioningState: snapshot.eligibilityMode === "CLAIMANT_ONLY" ? "AWAITING_CUSTOMER" : "PROVISIONING", verifiedEmailAt: snapshot.eligibilityMode === "CLAIMANT_ONLY" ? user.emailVerifiedAt : null,
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
  if (claim.couponCreateAttempted || claim.entitlementEverGranted || claim.status !== "POINTS_DEBITED") throw new RewardClaimError("MANUAL_REVIEW_REQUIRED", "Provider issuance may have occurred. The store must review this claim before any refund.");
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
type ProvisionStage = "SETUP" | "CUSTOMER_LOOKUP" | "TAG_CREATE" | "MEMBERSHIP_VERIFY" | "COUPON_RECOVERY" | "COUPON_CREATE" | "COUPON_VERIFY";
/** Failures that mean a provider resource may exist or the frozen terms are inconsistent. Only an operator may resolve them. */
const MANUAL_REVIEW_CODES = ["TAG_RESULT_UNKNOWN", "COUPON_RESULT_UNKNOWN", "COUPON_CONFLICT", "CUSTOMER_CHANGED", "EXPIRED_PENDING_REVIEW", "SNAPSHOT_MISMATCH"];
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
  try {
    await connectionForClaim(claim, deps.db);
    if (claim.rewardMode !== "DISCOUNT") throw new Commerce7RewardError("UNSUPPORTED_ACCESS");
    const snapshot = parseRewardSnapshot(claim.rewardConfigSnapshot);
    // The gate precedes every provider read and write, so a refusal can never leave a provider resource behind.
    if (!commerce7SnapshotIssuable(snapshot, contract)) throw new RewardClaimError("COUPON_CONTRACT_UNVERIFIED", "This reward cannot be issued yet.");
    const terms = couponTermsForClaim(snapshot, claim);
    const user = await deps.db.user.findUnique({ where: { id: claim.userId }, select: { email: true, isActive: true, isEmailVerified: true, emailVerifiedAt: true } });
    if (!user?.isActive) throw new RewardClaimError("ACCOUNT_UNAVAILABLE", "Your SQRATCH account is unavailable.", 403);
    if (snapshot.eligibilityMode === "CLAIMANT_ONLY" && (!user.isEmailVerified || !user.email || !user.emailVerifiedAt || user.emailVerifiedAt.getTime() !== claim.verifiedEmailAt?.getTime())) throw new RewardClaimError("EMAIL_CHANGED", "Your verified email changed. Contact the store or cancel this pending claim.");
    const expiresAt = claim.expiresAt;
    if (!expiresAt || expiresAt <= now) {
      if (!claim.couponCreateAttempted) return await rewardTransaction(deps.db, async (tx) => refundUnissuedClaim(tx, await tx.commerceRewardRedemption.findUniqueOrThrow({ where: { id: claimId } }), "Reward expired before issuance; points returned."));
      throw new RewardClaimError("EXPIRED_PENDING_REVIEW", "The issuance window ended. The store must review the provider result.");
    }
    const client = deps.client(claim.externalAccountId);
    if (snapshot.eligibilityMode === "CLAIMANT_ONLY") {
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
    const issuedCoupon = coupon;
    await rewardTransaction(deps.db, async (tx) => {
      const issued = await tx.commerceRewardRedemption.updateMany({ where: { id: claimId, provisioningOwner: owner, status: "POINTS_DEBITED" }, data: { status: "ISSUED", provisioningState: "READY", externalDiscountId: issuedCoupon.id, externalDiscountStatus: issuedCoupon.status, issuedAt: now, entitlementEverGranted: true, errorMessage: null, lastReconcileReason: null } });
      if (issued.count !== 1) throw new RewardClaimError("OWNERSHIP_LOST", "Claim ownership needs review.");
    });
  } catch (error) {
    const known = error instanceof RewardClaimError || error instanceof Commerce7RewardError;
    const manual = error instanceof RewardClaimError && MANUAL_REVIEW_CODES.includes(error.code);
    const ambiguous = error instanceof Commerce7RewardError && error.uncertain;
    const code = known ? error.code : "UNEXPECTED";
    // Closed vocabulary only: never a coupon code, provider body, header, email or credential.
    console.warn({ event: "commerce7_reward_provisioning_failed", stage, code, uncertain: ambiguous, provider: "COMMERCE7", connectionId: claim.connectionId, claimId: claim.id });
    await deps.db.commerceRewardRedemption.updateMany({ where: { id: claimId, provisioningOwner: owner, status: "POINTS_DEBITED" }, data: { provisioningState: manual || ambiguous ? "MANUAL_REVIEW" : "FAILED_RETRYABLE", needsManualReview: manual || ambiguous, lastReconcileReason: `${stage}:${code}`, errorMessage: known ? error.message : "Reward processing failed. Retry or contact the store." } });
    // A definitive refusal before any benefit existed returns the points. Anything that may have created a coupon never does.
    const refused = error instanceof Commerce7RewardError && !error.uncertain && (error.code === "SETUP_INCOMPLETE" || (error.code === "WRITE_REJECTED" && (stage === "COUPON_CREATE" || stage === "TAG_CREATE")));
    const unissuable = error instanceof RewardClaimError && error.code === "COUPON_CONTRACT_UNVERIFIED";
    if ((refused || unissuable) && !claim.couponCreateAttempted) {
      const message = unissuable ? "This reward cannot be issued yet; points returned." : error.message === "Commerce7 rewards setup is incomplete." ? "Commerce7 rejected reward authorization; points returned." : "Commerce7 could not accept this reward; points returned.";
      return await rewardTransaction(deps.db, async (tx) => refundUnissuedClaim(tx, await tx.commerceRewardRedemption.findUniqueOrThrow({ where: { id: claimId } }), message));
    }
  } finally {
    await deps.db.commerceRewardRedemption.updateMany({ where: { id: claimId, provisioningOwner: owner }, data: { provisioningOwner: null } });
  }
  return deps.db.commerceRewardRedemption.findUniqueOrThrow({ where: { id: claimId } });
}
export async function reconcileCommerce7Claims(deps = defaults) {
  const expired = await deps.db.commerceRewardRedemption.findMany({ where: { provider: "COMMERCE7", status: "ISSUED", expiresAt: { lte: deps.now() } }, take: 20, select: { id: true } });
  if (expired.length) await deps.db.commerceRewardRedemption.updateMany({ where: { id: { in: expired.map((row) => row.id) }, status: "ISSUED" }, data: { status: "EXPIRED" } });
  const rows = await deps.db.commerceRewardRedemption.findMany({ where: { provider: "COMMERCE7", status: "POINTS_DEBITED", provisioningOwner: null, needsManualReview: false, reconcileAttempts: { lt: 20 }, OR: [{ providerLastCheckedAt: null }, { providerLastCheckedAt: { lt: new Date(deps.now().getTime() - 300000) } }] }, orderBy: { providerLastCheckedAt: { sort: "asc", nulls: "first" } }, take: 1, select: { id: true } });
  let checked = 0; let failed = 0;
  for (const row of rows) { try { await provisionCommerce7Claim(row.id, undefined, deps); checked++; } catch { failed++; } }
  return { checked, failed };
}
export type { BrandRewardOffer };
