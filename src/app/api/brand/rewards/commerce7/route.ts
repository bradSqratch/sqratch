import { storedCommerce7Eligibility } from "@/lib/commerce7-reward-eligibility";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getBrandManagementContext, getBrandContextFailure } from "@/lib/brand-auth";
import { getActiveCommerceConnection, isConnectionUsable } from "@/lib/commerce/connection-service";
import { COMMERCE7_REWARD_CAPABILITIES, commerce7RewardReadiness, safeClaimDiagnostic, serializeBrandCommerce7Config } from "@/lib/commerce7-reward-domain";
import { getCommerce7AppConfig } from "@/lib/commerce/providers/commerce7";
import { claimTagTitle } from "@/lib/commerce/providers/commerce7-rewards-client";
import { rewardErrorResponse } from "@/lib/commerce7-reward-http";
export async function GET() {
  try {
    const context = await getBrandManagementContext();
    if (!context?.membership?.brand) { const failure = getBrandContextFailure(context); return NextResponse.json({ error: failure.error }, { status: failure.status }); }
    const brandId = context.membership.brand.id;
    const [commerce7, shopify] = await Promise.all([getActiveCommerceConnection(brandId, "COMMERCE7"), getActiveCommerceConnection(brandId, "SHOPIFY")]);
    const [offers, claims, products, counts] = await Promise.all([
      prisma.brandRewardOffer.findMany({ where: { brandId, provider: "COMMERCE7" }, include: { products: true, _count: { select: { redemptions: true } } }, orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.commerceRewardRedemption.findMany({ where: { brandId, provider: "COMMERCE7" }, include: { offer: { select: { title: true } } }, orderBy: { createdAt: "desc" }, take: 100 }),
      commerce7 ? prisma.connectedCommerceProduct.findMany({ where: { brandId, connectionId: commerce7.id, provider: "COMMERCE7", isAvailable: true }, select: { externalId: true, title: true }, orderBy: { title: "asc" }, take: 500 }) : [],
      prisma.commerceRewardRedemption.groupBy({ by: ["offerId", "slotReleased", "entitlementEverGranted"], where: { brandId, provider: "COMMERCE7" }, _count: { _all: true } }),
    ]);
    return NextResponse.json({ providers: { SHOPIFY: !!shopify && isConnectionUsable(shopify), COMMERCE7: !!commerce7 && isConnectionUsable(commerce7) }, connection: commerce7 ? { id: commerce7.id, displayName: commerce7.displayName, currencyCode: commerce7.currencyCode, status: commerce7.status } : null, capabilities: COMMERCE7_REWARD_CAPABILITIES,
      readiness: commerce7RewardReadiness(!!getCommerce7AppConfig()),
      offers: offers.map((offer) => ({ ...offer, commerce7Config: serializeBrandCommerce7Config(offer.commerce7Config, offer.rewardMode), totalClaims: offer.reservedClaimCount, issuedCount: counts.filter((count) => count.offerId === offer.id && count.entitlementEverGranted).reduce((sum, count) => sum + count._count._all, 0) })),
      claims: claims.map((claim) => ({ eligibilityMode: storedCommerce7Eligibility(claim.rewardConfigSnapshot, claim.rewardMode), id: claim.id, title: claim.offer.title, status: claim.status, provisioningState: claim.provisioningState, providerCustomerId: claim.providerCustomerId, providerTagId: claim.providerTagId, tagTitle: storedCommerce7Eligibility(claim.rewardConfigSnapshot, claim.rewardMode) === "CLAIMANT_ONLY" ? claimTagTitle(claim.id) : null, message: claim.errorMessage, diagnostic: safeClaimDiagnostic(claim.lastReconcileReason), needsManualReview: claim.needsManualReview, ownerActive: !!claim.provisioningOwner, canRevoke: claim.status === "ISSUED" && !!claim.externalDiscountId, canonicalOrderId: claim.canonicalOrderId, createdAt: claim.createdAt })), products });
  } catch (error) { return rewardErrorResponse(error); }
}
