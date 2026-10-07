import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { resolveSession } from "@/lib/auth-session";
import { getRewardClaimContext } from "@/lib/reward-access";
import { getUserSpendablePointBalance } from "@/lib/points";
import { getActiveCommerceConnection, isConnectionUsable } from "@/lib/commerce/connection-service";
import { commerce7OfferAvailable, commerce7OfferUnavailableReason, serializeCommerce7Claim } from "@/lib/commerce7-reward-domain";
import { rewardErrorResponse } from "@/lib/commerce7-reward-http";
import { validateCommerce7StorefrontUrl } from "@/lib/commerce/providers/commerce7-connection-config";
function storefrontUrl(value: string | null) { const result = validateCommerce7StorefrontUrl(value ?? ""); return result.ok ? result.value : null; }
export async function GET(request: NextRequest) {
  try {
    const session = await resolveSession();
    if (!session?.user.id) return NextResponse.json({ error: "Sign in to view rewards." }, { status: 401 });
    const context = await getRewardClaimContext({ request, userId: session.user.id, experienceSlug: request.nextUrl.searchParams.get("experienceSlug"), campaignId: request.nextUrl.searchParams.get("campaignId") });
    if (!context.ok) return NextResponse.json({ error: context.error }, { status: context.status });
    const [offers, claims, points] = await Promise.all([
      prisma.brandRewardOffer.findMany({ where: { provider: "COMMERCE7", brandId: { in: context.brandIds }, isActive: true }, include: { brand: { select: { name: true } }, products: { select: { title: true } } }, orderBy: { pointsCost: "asc" }, take: 100 }),
      prisma.commerceRewardRedemption.findMany({ where: { userId: session.user.id, provider: "COMMERCE7", ...(request.nextUrl.searchParams.has("experienceSlug") || request.nextUrl.searchParams.has("campaignId") ? { brandId: { in: context.brandIds } } : {}) }, include: { offer: { select: { title: true } } }, orderBy: { createdAt: "desc" }, take: 100 }),
      getUserSpendablePointBalance({ userId: session.user.id }),
    ]);
    const claimConnections = await prisma.commerceConnection.findMany({ where: { id: { in: claims.flatMap((claim) => claim.connectionId ? [claim.connectionId] : []) }, provider: "COMMERCE7", status: "CONNECTED", uninstalledAt: null }, select: { id: true, brandId: true, externalAccountId: true, storefrontUrl: true } });
    const data = [];
    for (const offer of offers) {
      const connection = await getActiveCommerceConnection(offer.brandId, "COMMERCE7");
      if (!connection || !isConnectionUsable(connection) || connection.id !== offer.connectionId || connection.externalAccountId !== offer.sourceExternalAccountId || connection.currencyCode !== offer.currencyCode) continue;
      const total = offer.reservedClaimCount;
      const userTotal = await prisma.commerceRewardRedemption.count({ where: { offerId: offer.id, userId: session.user.id, slotReleased: false } });
      data.push({ id: offer.id, title: offer.title, description: offer.description, brandName: offer.brand.name, productTitles: offer.products.flatMap((product) => product.title ? [product.title] : []), storefrontUrl: storefrontUrl(connection.storefrontUrl), pointsCost: offer.pointsCost, discountType: offer.discountType, discountAmountCents: offer.discountAmountCents, discountPercentageBasisPoints: offer.discountPercentageBasisPoints, currencyCode: offer.currencyCode, minimumSubtotalCents: offer.minimumSubtotalCents, codeValidDays: offer.codeValidDays, claimStartsAt: offer.claimStartsAt, claimEndsAt: offer.claimEndsAt, unavailableReason: commerce7OfferUnavailableReason(offer, total, userTotal)?.message ?? null, remaining: Math.max(0, (offer.maxTotalRedemptions ?? 0) - total), claimable: commerce7OfferAvailable(offer, total, userTotal), requiresManualEligibility: true });
    }
    return NextResponse.json({ data: { offers: data, claims: claims.map((claim) => {
      const connection = claimConnections.find((row) => row.id === claim.connectionId && row.brandId === claim.brandId && row.externalAccountId === claim.externalAccountId);
      return { ...serializeCommerce7Claim(claim), title: claim.offer.title, storefrontUrl: storefrontUrl(connection?.storefrontUrl ?? null) };
    }), points } });
  } catch (error) { return rewardErrorResponse(error); }
}
