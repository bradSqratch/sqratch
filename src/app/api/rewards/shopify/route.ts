import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import {
  CLAIM_COUNTED_REDEMPTION_STATUSES,
  getRewardOfferAvailability,
} from "@/lib/reward-offers";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();
    const user = await prisma.user.findUnique({
      where: {
        id: session.user.id,
      },
      select: {
        id: true,
        points: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    const offers = await prisma.brandRewardOffer.findMany({
      where: {
        isActive: true,
        OR: [{ claimStartsAt: null }, { claimStartsAt: { lte: now } }],
        AND: [{ OR: [{ claimEndsAt: null }, { claimEndsAt: { gte: now } }] }],
        brand: {
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
          },
        },
        products: true,
      },
      orderBy: {
        pointsCost: "asc",
      },
    });

    const data = await Promise.all(
      offers.map(async (offer) => {
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
                  userId: user.id,
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
        const hasEnoughPoints = user.points >= offer.pointsCost;
        const computedAvailability = getRewardOfferAvailability({
          offer,
          shopifyConnected: Boolean(offer.brand.shopifyShopDomain),
          totalRedemptions,
          userRedemptions,
          now,
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
          discountAmountCents: offer.discountAmountCents,
          currencyCode: offer.currencyCode,
          claimEndsAt: offer.claimEndsAt,
          codeValidDays: offer.codeValidDays,
          appliesTo: offer.appliesTo,
          minimumSubtotalCents: offer.minimumSubtotalCents,
          products: offer.products,
          userPointsBalance: user.points,
          computedAvailability,
          eligibility: {
            eligible: computedAvailability.claimable && hasEnoughPoints,
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
