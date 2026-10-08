import { storedCommerce7Eligibility } from "@/lib/commerce7-reward-eligibility";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getBrandManagementContext, getBrandContextFailure } from "@/lib/brand-auth";
import { getActiveCommerceConnection, isConnectionUsable } from "@/lib/commerce/connection-service";
import { COMMERCE7_EDIT_SAFE_CLAIM, COMMERCE7_REWARD_CAPABILITIES, commerce7ClaimAccessState, commerce7ExclusiveAccessStatus, commerce7ExclusiveSecurity, commerce7MembershipGuidance, commerce7OfferEditable, commerce7RewardReadiness, frozenExclusiveAccess, safeClaimDiagnostic, serializeBrandCommerce7Config } from "@/lib/commerce7-reward-domain";
import { getCommerce7AppConfig } from "@/lib/commerce/providers/commerce7";
import { claimTagTitle } from "@/lib/commerce/providers/commerce7-rewards-client";
import { rewardErrorResponse } from "@/lib/commerce7-reward-http";
const LIVE_ACCESS_STATUSES = ["POINTS_DEBITED", "ISSUED", "USED", "EXPIRED"] as const;
export async function GET() {
  try {
    const context = await getBrandManagementContext();
    if (!context?.membership?.brand) { const failure = getBrandContextFailure(context); return NextResponse.json({ error: failure.error }, { status: failure.status }); }
    const brandId = context.membership.brand.id;
    const [commerce7, shopify] = await Promise.all([getActiveCommerceConnection(brandId, "COMMERCE7"), getActiveCommerceConnection(brandId, "SHOPIFY")]);
    const [offers, claims, catalog, counts, safeClaims, memberships] = await Promise.all([
      prisma.brandRewardOffer.findMany({ where: { brandId, provider: "COMMERCE7" }, include: { products: true, _count: { select: { redemptions: true } } }, orderBy: { createdAt: "desc" }, take: 100 }),
      prisma.commerceRewardRedemption.findMany({ where: { brandId, provider: "COMMERCE7" }, include: { offer: { select: { title: true } } }, orderBy: { createdAt: "desc" }, take: 100 }),
      commerce7 ? prisma.connectedCommerceProduct.findMany({ where: { brandId, connectionId: commerce7.id, provider: "COMMERCE7", isAvailable: true }, select: { externalId: true, title: true, isAvailable: true, providerMetadata: true }, orderBy: { title: "asc" }, take: 500 }) : [],
      prisma.commerceRewardRedemption.groupBy({ by: ["offerId", "slotReleased", "entitlementEverGranted"], where: { brandId, provider: "COMMERCE7" }, _count: { _all: true } }),
      prisma.commerceRewardRedemption.groupBy({ by: ["offerId"], where: { brandId, provider: "COMMERCE7", ...COMMERCE7_EDIT_SAFE_CLAIM }, _count: { _all: true } }),
      // Live exclusive memberships per customer and tag, so the Brand can see when several rewards rely on one membership.
      prisma.commerceRewardRedemption.groupBy({ by: ["connectionId", "providerCustomerId", "providerTagId"], where: { brandId, provider: "COMMERCE7", rewardMode: "EXCLUSIVE_PRODUCT_ACCESS", status: { in: [...LIVE_ACCESS_STATUSES] }, membershipOwnership: { not: null } }, _count: { _all: true } }),
    ]);
    // Security metadata stays on the server: the browser gets titles and IDs, and only an eligibility verdict per offer.
    const products = catalog.map((product) => ({ externalId: product.externalId, title: product.title }));
    // Exclusive-eligible: Tag-secured with one or more tags. The tag count is shown; the tags themselves are never sent here.
    const tagsOf = (metadata: unknown) => commerce7ExclusiveSecurity(metadata)?.tagIds ?? [];
    const exclusiveProducts = catalog.filter((product) => tagsOf(product.providerMetadata).length).map((product) => ({ externalId: product.externalId, title: product.title, tagCount: tagsOf(product.providerMetadata).length }));
    // Products whose Product Security has never been read (a catalog list may omit it): a count only, so the picker can say
    // "sync products" instead of "no eligible products".
    const securityUnknownCount = catalog.filter((product) => { const metadata = product.providerMetadata; return !metadata || typeof metadata !== "object" || Array.isArray(metadata) || !("security" in metadata); }).length;
    const exclusiveDetails = (offer: { rewardMode: string; commerce7Config: unknown; products: { externalProductId: string }[] }) => {
      if (offer.rewardMode !== "EXCLUSIVE_PRODUCT_ACCESS") return { exclusiveAccessStatus: null };
      const product = catalog.find((row) => row.externalId === offer.products[0]?.externalProductId) ?? null;
      const frozen = frozenExclusiveAccess(offer.commerce7Config);
      return {
        exclusiveAccessStatus: commerce7ExclusiveAccessStatus(offer.commerce7Config, product),
        exclusiveTagCount: product ? tagsOf(product.providerMetadata).length : 0,
        // Other synchronized products secured by the same tag: granting it may unlock them too.
        exclusiveSharedProductCount: frozen ? catalog.filter((row) => row.externalId !== frozen.productId && tagsOf(row.providerMetadata).includes(frozen.tagId)).length : 0,
      };
    };
    const otherLiveClaims = (claim: { connectionId: string | null; providerCustomerId: string | null; providerTagId: string | null; membershipOwnership: string | null; status: string }) => {
      const group = memberships.find((row) => row.connectionId === claim.connectionId && row.providerCustomerId === claim.providerCustomerId && row.providerTagId === claim.providerTagId)?._count._all ?? 0;
      return Math.max(0, group - (claim.membershipOwnership && LIVE_ACCESS_STATUSES.includes(claim.status as never) ? 1 : 0));
    };
    return NextResponse.json({ providers: { SHOPIFY: !!shopify && isConnectionUsable(shopify), COMMERCE7: !!commerce7 && isConnectionUsable(commerce7) }, connection: commerce7 ? { id: commerce7.id, displayName: commerce7.displayName, currencyCode: commerce7.currencyCode, status: commerce7.status } : null, capabilities: COMMERCE7_REWARD_CAPABILITIES,
      readiness: commerce7RewardReadiness(!!getCommerce7AppConfig()),
      offers: offers.map((offer) => ({ ...offer, commerce7Config: serializeBrandCommerce7Config(offer.commerce7Config, offer.rewardMode), ...exclusiveDetails(offer), editable: commerce7OfferEditable(offer.reservedClaimCount, offer._count.redemptions, safeClaims.find((row) => row.offerId === offer.id)?._count._all ?? 0), totalClaims: offer.reservedClaimCount, issuedCount: counts.filter((count) => count.offerId === offer.id && count.entitlementEverGranted).reduce((sum, count) => sum + count._count._all, 0) })),
      claims: claims.map((claim) => {
        const eligibilityMode = storedCommerce7Eligibility(claim.rewardConfigSnapshot, claim.rewardMode);
        const exclusive = claim.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS";
        // Exclusive claims grant the merchant's own tag: its UUID is never sent, and SQRATCH never revokes the membership.
        return { eligibilityMode, rewardMode: claim.rewardMode, id: claim.id, title: claim.offer.title, status: claim.status, provisioningState: claim.provisioningState, providerCustomerId: claim.providerCustomerId, providerTagId: exclusive ? null : claim.providerTagId, tagTitle: !exclusive && eligibilityMode === "CLAIMANT_ONLY" ? claimTagTitle(claim.id) : null,
          accessState: commerce7ClaimAccessState(claim), membershipOwnership: exclusive ? claim.membershipOwnership : null, membershipGuidance: exclusive ? commerce7MembershipGuidance(claim.membershipOwnership, otherLiveClaims(claim)) : null,
          message: claim.errorMessage, diagnostic: safeClaimDiagnostic(claim.lastReconcileReason), purchaseCheckedAt: claim.rewardOrderCheckedAt, needsManualReview: claim.needsManualReview, ownerActive: !!claim.provisioningOwner, canRevoke: !exclusive && claim.status === "ISSUED" && !!claim.externalDiscountId, canonicalOrderId: claim.canonicalOrderId, createdAt: claim.createdAt };
      }), products, exclusiveProducts, exclusiveDiagnostics: { securityUnknownCount, lastProductSyncAt: commerce7?.lastProductSyncAt ?? null } });
  } catch (error) { return rewardErrorResponse(error); }
}
