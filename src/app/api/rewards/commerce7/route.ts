import { storedCommerce7Eligibility } from "@/lib/commerce7-reward-eligibility";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { resolveSession } from "@/lib/auth-session";
import { getRewardClaimContext } from "@/lib/reward-access";
import { getUserSpendablePointBalance } from "@/lib/points";
import { getActiveCommerceConnection, isConnectionUsable } from "@/lib/commerce/connection-service";
import { commerce7OfferAvailable, commerce7OfferEligibility, commerce7OfferUnavailableReason, frozenExclusiveAccess, serializeCommerce7Claim } from "@/lib/commerce7-reward-domain";
import { rewardErrorResponse } from "@/lib/commerce7-reward-http";
import { commerce7RewardsApply, restrictedViewer } from "@/lib/commerce7-reward-viewer";
import { validateCommerce7StorefrontUrl } from "@/lib/commerce/providers/commerce7-connection-config";
import { object } from "@/lib/commerce/providers/commerce7-rewards-client";
function storefrontUrl(value: string | null) { const result = validateCommerce7StorefrontUrl(value ?? ""); return result.ok ? result.value : null; }
export async function GET(request: NextRequest) {
  try {
    const scope = { experienceSlug: request.nextUrl.searchParams.get("experienceSlug"), campaignId: request.nextUrl.searchParams.get("campaignId") };
    // Signed-out and locked viewers get a safe, explicit state instead of an error. Nothing private is read for them,
    // and the claim/cancel/retry routes keep enforcing authentication and unlock on their own.
    const session = await resolveSession();
    if (!session?.user.id) return NextResponse.json({ data: restrictedViewer("SIGNED_OUT", await commerce7RewardsApply(prisma, scope)) });
    const context = await getRewardClaimContext({ request, userId: session.user.id, ...scope });
    if (!context.ok) {
      if (context.status === 403) return NextResponse.json({ data: restrictedViewer("LOCKED", await commerce7RewardsApply(prisma, scope)) });
      return NextResponse.json({ error: context.error }, { status: context.status });
    }
    const [offers, claims, points] = await Promise.all([
      prisma.brandRewardOffer.findMany({ where: { provider: "COMMERCE7", brandId: { in: context.brandIds }, isActive: true }, include: { brand: { select: { name: true } }, products: { select: { title: true, externalProductId: true } } }, orderBy: { pointsCost: "asc" }, take: 100 }),
      prisma.commerceRewardRedemption.findMany({ where: { userId: session.user.id, provider: "COMMERCE7", ...(request.nextUrl.searchParams.has("experienceSlug") || request.nextUrl.searchParams.has("campaignId") ? { brandId: { in: context.brandIds } } : {}) }, include: { offer: { select: { title: true } } }, orderBy: { createdAt: "desc" }, take: 100 }),
      getUserSpendablePointBalance({ userId: session.user.id }),
    ]);
    // Exclusive offers stay listed only while their synchronized product still matches the frozen Customer Tag. No tag or
    // security detail is ever sent to a claimant.
    const exclusiveProductIds = offers.flatMap((offer) => offer.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS" ? [frozenExclusiveAccess(offer.commerce7Config)?.productId ?? ""] : []);
    const exclusiveProducts = exclusiveProductIds.length ? await prisma.connectedCommerceProduct.findMany({ where: { provider: "COMMERCE7", brandId: { in: context.brandIds }, externalId: { in: exclusiveProductIds } }, select: { brandId: true, connectionId: true, externalId: true, isAvailable: true, providerMetadata: true } }) : [];
    const claimConnections = await prisma.commerceConnection.findMany({ where: { id: { in: claims.flatMap((claim) => claim.connectionId ? [claim.connectionId] : []) }, provider: "COMMERCE7", status: "CONNECTED", uninstalledAt: null }, select: { id: true, brandId: true, externalAccountId: true, storefrontUrl: true } });
    const data = [];
    for (const offer of offers) {
      const connection = await getActiveCommerceConnection(offer.brandId, "COMMERCE7");
      if (!connection || !isConnectionUsable(connection) || connection.id !== offer.connectionId || connection.externalAccountId !== offer.sourceExternalAccountId || connection.currencyCode !== offer.currencyCode) continue;
      const eligibilityMode = storedCommerce7Eligibility(offer.commerce7Config, offer.rewardMode);
      if (!eligibilityMode) continue;
      const total = offer.reservedClaimCount;
      const userTotal = await prisma.commerceRewardRedemption.count({ where: { offerId: offer.id, userId: session.user.id, slotReleased: false } });
      const exclusive = offer.rewardMode === "EXCLUSIVE_PRODUCT_ACCESS";
      const exclusiveProduct = exclusive ? exclusiveProducts.find((product) => product.brandId === offer.brandId && product.connectionId === offer.connectionId && product.externalId === frozenExclusiveAccess(offer.commerce7Config)?.productId) ?? null : null;
      // The same blockers a claim enforces (unverified percentage or claimant-only coupon, changed or multi-tag exclusive
      // security). The claimant sees a generic reason only; no tag, security or contract detail is sent.
      const blocked = commerce7OfferEligibility(offer, { productIds: offer.products.map((product) => product.externalProductId), exclusiveProduct }).blockers.length > 0
        ? exclusive ? "This exclusive reward is not available right now. The store must review it." : "This reward is temporarily unavailable while the store finishes setting it up."
        : null;
      const unavailableReason = commerce7OfferUnavailableReason(offer, total, userTotal)?.message ?? blocked;
      data.push({ rewardMode: offer.rewardMode, accessOnly: exclusive && object(offer.commerce7Config)?.discountEnabled !== true, id: offer.id, title: offer.title, description: offer.description, brandName: offer.brand.name, productTitles: offer.products.flatMap((product) => product.title ? [product.title] : []), storefrontUrl: storefrontUrl(connection.storefrontUrl), pointsCost: offer.pointsCost, discountType: offer.discountType, discountAmountCents: offer.discountAmountCents, discountPercentageBasisPoints: offer.discountPercentageBasisPoints, currencyCode: offer.currencyCode, minimumSubtotalCents: offer.minimumSubtotalCents, codeValidDays: offer.codeValidDays, claimStartsAt: offer.claimStartsAt, claimEndsAt: offer.claimEndsAt, unavailableReason, remaining: Math.max(0, (offer.maxTotalRedemptions ?? 0) - total), claimable: commerce7OfferAvailable(offer, total, userTotal) && !blocked, eligibilityMode, requiresManualEligibility: eligibilityMode === "CLAIMANT_ONLY" && !exclusive });
    }
    return NextResponse.json({ data: { viewerState: "READY", offers: data, claims: claims.map((claim) => {
      const connection = claimConnections.find((row) => row.id === claim.connectionId && row.brandId === claim.brandId && row.externalAccountId === claim.externalAccountId);
      return { ...serializeCommerce7Claim(claim), title: claim.offer.title, storefrontUrl: storefrontUrl(connection?.storefrontUrl ?? null) };
    }), points } });
  } catch (error) { return rewardErrorResponse(error); }
}
