import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { CommerceProvider } from "@prisma/client";
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
import {
  getActiveCommerceConnectionsForBrands,
  isConnectionUsable,
} from "@/lib/commerce/connection-service";

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

    // PHASE 14B.4C: connectivity is no longer part of the DB filter — a
    // brand's canonical connection state can only be known by actually
    // resolving CommerceConnection, not by a Brand.shopify* WHERE clause.
    // Fetch every active, in-window offer for the unlocked brands, then
    // filter by canonical connectivity in-memory below.
    const offers = await prisma.brandRewardOffer.findMany({
      where: {
        isActive: true,
        OR: [{ claimStartsAt: null }, { claimStartsAt: { lte: now } }],
        AND: [{ OR: [{ claimEndsAt: null }, { claimEndsAt: { gte: now } }] }],
        brandId: {
          in: rewardContext.brandIds,
        },
      },
      include: {
        brand: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
          },
        },
        products: true,
      },
      orderBy: {
        pointsCost: "asc",
      },
    });

    // CANONICAL, BATCHED — exactly two queries total regardless of how many
    // distinct brands are represented among `offers` (see
    // `getActiveCommerceConnectionsForBrands`'s doc comment). This route
    // never decrypts or even reads a credential: `isConnectionUsable` checks
    // status + domain presence only, never `CommerceConnectionSecret` — this
    // route makes no Shopify API call, so credential presence is
    // deliberately not a display gate (see file header).
    const connectionsByBrand = await getActiveCommerceConnectionsForBrands(
      rewardContext.brandIds,
      CommerceProvider.SHOPIFY,
    );

    // Filter incompatible offers (not connected, currency drift,
    // stale/unknown product source) before running any per-offer
    // redemption-count queries below — no Shopify API call is made here,
    // only in-memory comparison against the CANONICAL connection resolved
    // above.
    const compatibleOffers = offers.filter((offer) => {
      const summary = connectionsByBrand.get(offer.brandId);
      if (!summary || !isConnectionUsable(summary)) {
        return false;
      }

      const compatibility = computeShopifyRewardCompatibility({
        offer: {
          discountType: offer.discountType,
          minimumSubtotalCents: offer.minimumSubtotalCents,
          currencyCode: offer.currencyCode,
          appliesTo: offer.appliesTo,
          sourceShopDomain: offer.sourceShopDomain,
        },
        shopifyConnected: true,
        currentShopDomain: summary.externalAccountId,
        currentStoreCurrency: summary.currencyCode,
      });

      return compatibility.compatible;
    });

    const data = await Promise.all(
      compatibleOffers.map(async (offer) => {
        // Already proven usable by the filter above — resolved once more
        // here only to read its fields, never re-queried.
        const summary = connectionsByBrand.get(offer.brandId)!;
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
          // Already proven usable by the canonical `isConnectionUsable`
          // filter above — this offer would not have reached `.map()`
          // otherwise, so re-deriving from Brand here would just be a
          // second, redundant (and legacy-authoritative) connectivity check.
          shopifyConnected: true,
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
          shopUrl: summary.storefrontUrl,
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
