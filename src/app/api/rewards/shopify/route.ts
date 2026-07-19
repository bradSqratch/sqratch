import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { getRewardClaimContext } from "@/lib/reward-access";
import {
  CLAIM_COUNTED_REDEMPTION_STATUSES,
  getRewardOfferAvailability,
} from "@/lib/reward-offers";
import { getUserSpendablePointBalance } from "@/lib/points";
import { getShopifyRewardDisplayState } from "@/lib/shopify-reward-display";
import { computeShopifyRewardCompatibility } from "@/lib/shopify-reward-compatibility";

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();
    const searchParams = request.nextUrl.searchParams;
    const rewardContext = await getRewardClaimContext({
      request,
      userId: session.user.id,
      experienceSlug: searchParams.get("experienceSlug"),
      campaignId: searchParams.get("campaignId"),
    });

    if (!rewardContext.ok) {
      return NextResponse.json({
        data: [],
        reason: rewardContext.error,
      });
    }

    if (rewardContext.brandIds.length === 0) {
      return NextResponse.json({
        data: [],
        reason: "Unlock this experience before claiming rewards.",
      });
    }

    const userPointsBalance = await getUserSpendablePointBalance({
      userId: session.user.id,
    });

    const offers = await prisma.brandRewardOffer.findMany({
      where: {
        isActive: true,
        OR: [{ claimStartsAt: null }, { claimStartsAt: { lte: now } }],
        AND: [{ OR: [{ claimEndsAt: null }, { claimEndsAt: { gte: now } }] }],
        brand: {
          id: {
            in: rewardContext.brandIds,
          },
          shopifyConnectionStatus: "CONNECTED",
          shopifyShopDomain: {
            not: null,
          },
          shopifyAdminAccessTokenEncrypted: {
            not: null,
          },
        },
      },
      include: {
        brand: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            shopifyShopDomain: true,
            shopifyCurrencyCode: true,
          },
        },
        products: true,
      },
      orderBy: {
        pointsCost: "asc",
      },
    });

    // Filter incompatible offers (currency drift, stale/unknown product
    // source) before running any per-offer redemption-count queries below —
    // no Shopify API call is made here, only in-memory comparison against
    // the Brand fields already loaded above.
    const compatibleOffers = offers.filter((offer) => {
      const compatibility = computeShopifyRewardCompatibility({
        offer: {
          discountType: offer.discountType,
          minimumSubtotalCents: offer.minimumSubtotalCents,
          currencyCode: offer.currencyCode,
          appliesTo: offer.appliesTo,
          sourceShopDomain: offer.sourceShopDomain,
        },
        // The WHERE clause above already restricts to CONNECTED brands with
        // a domain and access token, so the connection itself is known-good
        // here — only currency/product-source compatibility remains to check.
        shopifyConnected: true,
        currentShopDomain: offer.brand.shopifyShopDomain,
        currentStoreCurrency: offer.brand.shopifyCurrencyCode,
      });

      return compatibility.compatible;
    });

    const data = await Promise.all(
      compatibleOffers.map(async (offer) => {
        const [totalRedemptions, userRedemptions] = await Promise.all([
          offer.maxTotalRedemptions
            ? prisma.shopifyRewardRedemption.count({
                where: {
                  offerId: offer.id,
                  status: {
                    in: [...CLAIM_COUNTED_REDEMPTION_STATUSES],
                  },
                },
              })
            : Promise.resolve(0),
          offer.maxRedemptionsPerUser
            ? prisma.shopifyRewardRedemption.count({
                where: {
                  offerId: offer.id,
                  userId: session.user.id,
                  status: {
                    in: [...CLAIM_COUNTED_REDEMPTION_STATUSES],
                  },
                },
              })
            : Promise.resolve(0),
        ]);
        const limitReached = Boolean(
          offer.maxTotalRedemptions &&
            totalRedemptions >= offer.maxTotalRedemptions,
        );
        const userLimitReached = Boolean(
          offer.maxRedemptionsPerUser &&
            userRedemptions >= offer.maxRedemptionsPerUser,
        );
        const hasEnoughPoints = userPointsBalance >= offer.pointsCost;
        const computedAvailability = getRewardOfferAvailability({
          offer,
          shopifyConnected: Boolean(offer.brand.shopifyShopDomain),
          totalRedemptions,
          userRedemptions,
          now,
        });

        const displayState = getShopifyRewardDisplayState({
          userPointsBalance,
          pointsCost: offer.pointsCost,
          availability: computedAvailability,
        });

        return {
          id: offer.id,
          title: offer.title,
          description: offer.description,
          brand: offer.brand,
          shopUrl: offer.brand.shopifyShopDomain
            ? `https://${offer.brand.shopifyShopDomain}`
            : null,
          pointsCost: offer.pointsCost,
          discountType: offer.discountType,
          discountAmountCents: offer.discountAmountCents,
          discountPercentageBasisPoints: offer.discountPercentageBasisPoints,
          currencyCode: offer.currencyCode,
          claimEndsAt: offer.claimEndsAt,
          codeValidDays: offer.codeValidDays,
          appliesTo: offer.appliesTo,
          minimumSubtotalCents: offer.minimumSubtotalCents,
          products: offer.products,
          userPointsBalance,
          ...displayState,
          computedAvailability,
          eligibility: {
            eligible: displayState.canRedeem,
            hasEnoughPoints,
            limitReached,
            userLimitReached,
          },
        };
      }),
    );

    return NextResponse.json({ data });
  } catch (error) {
    console.error("[rewards/shopify][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load Shopify rewards." },
      { status: 500 },
    );
  }
}
