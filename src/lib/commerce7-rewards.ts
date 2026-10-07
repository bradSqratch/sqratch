import { randomBytes, randomUUID } from "node:crypto";
import { Prisma, type BrandRewardOffer, type CommerceRewardRedemption } from "@prisma/client";
import prisma from "./prisma";
import { applyPointLedgerEvent } from "./points";
import { getActiveCommerceConnection, isConnectionUsable } from "./commerce/connection-service";
import { Commerce7RewardsClient, Commerce7RewardError, buildCommerce7RewardCoupon, couponMatches, normalizeRewardEmail } from "./commerce/providers/commerce7-rewards-client";
import { commerce7OfferUnavailableReason, parseCommerce7Offer, parseRewardSnapshot, requireValue, RewardClaimError, rewardIdempotencyKey, validateNativeTemplate } from "./commerce7-reward-domain";

type Db = typeof prisma;
export type Commerce7RewardDeps = { db: Db; client: (tenant: string) => Commerce7RewardsClient; now: () => Date };
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
export async function saveCommerce7Offer(brandId: string, body: unknown, offerId?: string, deps = defaults) {
  const connection = await getActiveCommerceConnection(brandId, "COMMERCE7");
  if (!connection || !isConnectionUsable(connection)) throw new RewardClaimError("CONNECTION_UNAVAILABLE", "Connect Commerce7 before configuring rewards.");
  const input = parseCommerce7Offer(body, connection.currencyCode);
  const client = deps.client(connection.externalAccountId);
  const template = input.templateCouponId ? await client.coupon(input.templateCouponId) : null;
  if (template) {
    const templateTagId = template.availableToObjectIds?.[0];
    requireValue(templateTagId, "Create a coupon template restricted to one manual Customer tag.");
    await client.tag(templateTagId);
    validateNativeTemplate(template, input.productIds, templateTagId);
  }
  const products = await deps.db.connectedCommerceProduct.findMany({ where: { brandId, connectionId: connection.id, provider: "COMMERCE7", externalId: { in: input.productIds }, isAvailable: true }, select: { externalId: true, title: true } });
  requireValue(new Set(products.map((p) => p.externalId)).size === input.productIds.length, "Select products from this Commerce7 connection's synchronized catalog.");
  const { productIds, templateCouponId, discountEnabled, ...fields } = input;
  requireValue(products.length === productIds.length, "Catalog product identity is ambiguous.");
  const config = { templateCouponId, template, discountEnabled };
  return rewardTransaction(deps.db, async (tx) => {
    const current = await tx.commerceConnection.findFirst({ where: { id: connection.id, brandId, provider: "COMMERCE7", externalAccountId: connection.externalAccountId, status: "CONNECTED", uninstalledAt: null } });
    if (!current) throw new RewardClaimError("CONNECTION_UNAVAILABLE", "Commerce7 connection changed. Reload and review the offer.");
    if (offerId) {
      const existing = await tx.brandRewardOffer.findFirst({ where: { id: offerId, brandId, provider: "COMMERCE7", connectionId: connection.id, sourceExternalAccountId: connection.externalAccountId } });
      if (!existing) throw new RewardClaimError("NOT_FOUND", "Reward offer not found for this connection.", 404);
      // Published terms and caps are immutable once any reservation exists.
      // Disabling stays available separately and does not revoke issued rewards.
      if (existing.reservedClaimCount > 0 || await tx.commerceRewardRedemption.count({ where: { offerId } })) throw new RewardClaimError("OFFER_HAS_CLAIMS", "This offer has claims. Disable it and create a new offer to change its terms.");
      await tx.brandRewardOfferProduct.deleteMany({ where: { offerId } });
      return tx.brandRewardOffer.update({ where: { id: offerId }, data: { ...fields, commerce7Config: config, products: { create: products.map((p) => ({ externalProductId: p.externalId, title: p.title })) } } });
    }
    return tx.brandRewardOffer.create({ data: { ...fields, brandId, provider: "COMMERCE7", connectionId: connection.id, sourceExternalAccountId: connection.externalAccountId, commerce7Config: config, products: { create: products.map((p) => ({ externalProductId: p.externalId, title: p.title })) } } });
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
    if (!user?.isActive || !user.isEmailVerified || !user.emailVerifiedAt || !user.email) throw new RewardClaimError("EMAIL_VERIFICATION_REQUIRED", "Verify your SQRATCH email before claiming this reward.", 403);
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
    const snapshot = parseRewardSnapshot({ ...config, title: offer.title, minimumSubtotalCents: offer.minimumSubtotalCents });
    const productIds = snapshot.template.appliesToObjectIds ?? [];
    if (offer.appliesTo === "SPECIFIC_PRODUCTS") {
      const products = await tx.connectedCommerceProduct.findMany({ where: { brandId: offer.brandId, connectionId: connection.id, provider: "COMMERCE7", externalId: { in: productIds }, isAvailable: true }, select: { externalId: true } });
      if (!productIds.length || products.length !== productIds.length || new Set(products.map((product) => product.externalId)).size !== productIds.length) throw new RewardClaimError("PRODUCT_UNAVAILABLE", "A reward product is no longer available. The store must review this offer.");
    }
    const capacity = await tx.brandRewardOffer.updateMany({ where: { id: offer.id, brandId: offer.brandId, provider: "COMMERCE7", isActive: true, reservedClaimCount: total }, data: { reservedClaimCount: { increment: 1 } } });
    if (capacity.count !== 1) throw new RewardClaimError("OFFER_CHANGED", "Reward availability changed. Reload and try again.");
    const claim = await tx.commerceRewardRedemption.create({ data: {
      userId, brandId: offer.brandId, offerId, provider: "COMMERCE7", connectionId: connection.id, externalAccountId: connection.externalAccountId,
      rewardMode: offer.rewardMode, idempotencyKey, code: `SQRA${randomBytes(16).toString("hex").toUpperCase()}`,
      status: "POINTS_DEBITED", provisioningState: "AWAITING_CUSTOMER", verifiedEmailAt: user.emailVerifiedAt,
      pointsCost: offer.pointsCost, discountType: offer.discountType, discountAmountCents: offer.discountAmountCents,
      discountPercentageBasisPoints: offer.discountPercentageBasisPoints, currencyCode: offer.currencyCode,
      rewardConfigSnapshot: snapshot, expiresAt: new Date(now.getTime() + offer.codeValidDays * 86400000),
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
export async function provisionCommerce7Claim(claimId: string, userId?: string, deps = defaults) {
  const owner = randomUUID(); const now = deps.now();
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
  try {
    await connectionForClaim(claim, deps.db);
    if (claim.rewardMode !== "DISCOUNT") throw new Commerce7RewardError("UNSUPPORTED_ACCESS");
    const user = await deps.db.user.findUnique({ where: { id: claim.userId }, select: { email: true, isActive: true, isEmailVerified: true, emailVerifiedAt: true } });
    if (!user?.isActive || !user.isEmailVerified || !user.email || !user.emailVerifiedAt || user.emailVerifiedAt.getTime() !== claim.verifiedEmailAt?.getTime()) throw new RewardClaimError("EMAIL_CHANGED", "Your verified email changed. Contact the store or cancel this pending claim.");
    if (!claim.expiresAt || claim.expiresAt <= now) {
      if (!claim.couponCreateAttempted) return await rewardTransaction(deps.db, async (tx) => refundUnissuedClaim(tx, await tx.commerceRewardRedemption.findUniqueOrThrow({ where: { id: claimId } }), "Reward expired before issuance; points returned."));
      throw new RewardClaimError("EXPIRED_PENDING_REVIEW", "The issuance window ended. The store must review the provider result.");
    }
    const client = deps.client(claim.externalAccountId);
    const hadTag = !!claim.providerTagId;
    const customer = claim.providerCustomerId ? await client.customerById(claim.providerCustomerId) : await client.customer(user.email);
    if (!customer) { await update({ provisioningState: "AWAITING_CUSTOMER", errorMessage: "Create or use a Commerce7 account with your verified SQRATCH email, then retry." }); return claim; }
    if (!customer.emails.includes(normalizeRewardEmail(user.email)) || (claim.providerCustomerId && claim.providerCustomerId !== customer.id)) throw new RewardClaimError("CUSTOMER_CHANGED", "Commerce7 customer identity changed. The store must review this claim.");
    await update({ providerCustomerId: customer.id });
    if (!claim.providerTagId) {
      let tag = await client.findTag(claim.id);
      if (!tag) {
        if (claim.tagCreateAttempted) throw new RewardClaimError("TAG_RESULT_UNKNOWN", "A previous tag request needs provider review. No duplicate tag will be created.");
        await update({ tagCreateAttempted: true });
        tag = await client.createTag(claim.id);
      }
      await update({ providerTagId: tag.id });
    }
    // Re-read a newly created/recovered tag's membership, using the proven
    // tag filter. Subsequent checks use the pinned customer ID, avoiding an
    // expensive full tenant email scan on every pending claim retry.
    const eligible = hadTag ? customer : await client.customerById(customer.id);
    const exclusiveMember = await client.tagOnlyForCustomer(claim.providerTagId!, customer.id);
    if (!eligible || eligible.id !== customer.id || !eligible.emails.includes(normalizeRewardEmail(user.email)) || !eligible.tagIds.includes(claim.providerTagId!) || !exclusiveMember) {
      await update({ provisioningState: "AWAITING_ELIGIBILITY", lastReconcileReason: "MANUAL_PROVIDER_SETUP_REQUIRED", errorMessage: "The store must assign this claim's Customer tag to your matching Commerce7 customer. Use the same email at checkout." }); return claim;
    }
    const snapshot = parseRewardSnapshot(claim.rewardConfigSnapshot);
    const payload = buildCommerce7RewardCoupon(snapshot.template, { ...claim, title: snapshot.title, minimumSubtotalCents: snapshot.minimumSubtotalCents }, claim.code, claim.providerTagId!, claim.createdAt, claim.expiresAt);
    let coupon = await client.findCoupon(claim.code);
    if (!coupon) {
      if (claim.couponCreateAttempted) throw new RewardClaimError("COUPON_RESULT_UNKNOWN", "A previous coupon request needs provider review. Points remain reserved and no duplicate coupon will be created.");
      await update({ couponCreateAttempted: true });
      try { coupon = await client.createCoupon(payload); }
      catch (error) {
        // Only an explicit non-ambiguous rejection can prove this POST had
        // no benefit. Transport errors retain the attempt marker forever.
        if (error instanceof Commerce7RewardError && !error.uncertain && error.code === "SETUP_INCOMPLETE") await update({ couponCreateAttempted: false });
        throw error;
      }
    }
    if (!couponMatches(coupon, payload)) throw new RewardClaimError("COUPON_CONFLICT", "Provider coupon terms differ from the reserved reward. Store review is required.");
    const issuedCoupon = coupon;
    await rewardTransaction(deps.db, async (tx) => {
      const issued = await tx.commerceRewardRedemption.updateMany({ where: { id: claimId, provisioningOwner: owner, status: "POINTS_DEBITED" }, data: { status: "ISSUED", provisioningState: "READY", externalDiscountId: issuedCoupon.id, externalDiscountStatus: issuedCoupon.status, issuedAt: now, entitlementEverGranted: true, errorMessage: null } });
      if (issued.count !== 1) throw new RewardClaimError("OWNERSHIP_LOST", "Claim ownership needs review.");
    });
  } catch (error) {
    const manual = error instanceof RewardClaimError && ["TAG_RESULT_UNKNOWN", "COUPON_RESULT_UNKNOWN", "COUPON_CONFLICT", "CUSTOMER_CHANGED", "EXPIRED_PENDING_REVIEW"].includes(error.code);
    const ambiguous = error instanceof Commerce7RewardError && error.uncertain;
    await deps.db.commerceRewardRedemption.updateMany({ where: { id: claimId, provisioningOwner: owner, status: "POINTS_DEBITED" }, data: { provisioningState: manual || ambiguous ? "MANUAL_REVIEW" : "FAILED_RETRYABLE", needsManualReview: manual || ambiguous, errorMessage: error instanceof RewardClaimError || error instanceof Commerce7RewardError ? error.message : "Reward processing failed. Retry or contact the store." } });
    if (error instanceof Commerce7RewardError && error.code === "SETUP_INCOMPLETE" && !claim.couponCreateAttempted) {
      return await rewardTransaction(deps.db, async (tx) => refundUnissuedClaim(tx, await tx.commerceRewardRedemption.findUniqueOrThrow({ where: { id: claimId } }), "Commerce7 rejected reward authorization; points returned."));
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
