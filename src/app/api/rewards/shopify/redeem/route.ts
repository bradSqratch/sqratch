import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { getRewardClaimContext } from "@/lib/reward-access";
import { createShopifyRewardDiscountCode } from "@/lib/shopify-discounts";
import {
  CLAIM_COUNTED_REDEMPTION_STATUSES,
  generateRewardCode,
  getRewardOfferAvailability,
} from "@/lib/reward-offers";

function cleanIdempotencyKey(value: unknown) {
  const key = String(value || "").trim();
  return key.length > 0 && key.length <= 160 ? key : null;
}

function serializeRedemption(redemption: {
  id: string;
  code: string;
  status: string;
  pointsCost: number;
  discountAmountCents: number;
  currencyCode: string;
  issuedAt: Date | null;
  expiresAt: Date | null;
  usedAt: Date | null;
  errorMessage?: string | null;
}) {
  return {
    id: redemption.id,
    code: redemption.code,
    status: redemption.status,
    pointsCost: redemption.pointsCost,
    discountAmountCents: redemption.discountAmountCents,
    currencyCode: redemption.currencyCode,
    issuedAt: redemption.issuedAt,
    expiresAt: redemption.expiresAt,
    usedAt: redemption.usedAt,
    errorMessage: redemption.errorMessage || null,
  };
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const offerId = String(body?.offerId || "").trim();
    const idempotencyKey = cleanIdempotencyKey(body?.idempotencyKey);
    const experienceSlug = body?.experienceSlug
      ? String(body.experienceSlug).trim()
      : null;
    const campaignId = body?.campaignId ? String(body.campaignId).trim() : null;

    if (!offerId || !idempotencyKey) {
      return NextResponse.json(
        { error: "offerId and idempotencyKey are required." },
        { status: 400 },
      );
    }

    const existing = await prisma.shopifyRewardRedemption.findUnique({
      where: {
        idempotencyKey,
      },
    });

    if (existing) {
      if (existing.userId !== session.user.id) {
        return NextResponse.json(
          { error: "Idempotency key is already in use." },
          { status: 409 },
        );
      }

      return NextResponse.json({ data: serializeRedemption(existing) });
    }

    const offer = await prisma.brandRewardOffer.findUnique({
      where: {
        id: offerId,
      },
      include: {
        brand: {
          select: {
            id: true,
            name: true,
            shopifyShopDomain: true,
            shopifyAdminAccessTokenEncrypted: true,
            shopifyConnectionStatus: true,
          },
        },
        products: true,
      },
    });

    if (!offer) {
      return NextResponse.json(
        { error: "Reward offer is not available." },
        { status: 404 },
      );
    }

    const rewardContext = await getRewardClaimContext({
      request,
      userId: session.user.id,
      experienceSlug,
      campaignId,
    });

    if (!rewardContext.ok) {
      return NextResponse.json(
        { error: rewardContext.error },
        { status: rewardContext.status },
      );
    }

    if (!rewardContext.brandIds.includes(offer.brandId)) {
      return NextResponse.json(
        { error: "Unlock this experience before claiming rewards." },
        { status: 403 },
      );
    }

    if (
      offer.brand.shopifyConnectionStatus !== "CONNECTED" ||
      !offer.brand.shopifyShopDomain ||
      !offer.brand.shopifyAdminAccessTokenEncrypted
    ) {
      return NextResponse.json(
        { error: "Shopify is not connected for this brand." },
        { status: 400 },
      );
    }

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
    const availability = getRewardOfferAvailability({
      offer,
      shopifyConnected: true,
      totalRedemptions,
      userRedemptions,
    });

    if (!availability.claimable) {
      return NextResponse.json(
        { error: availability.label },
        { status: 409 },
      );
    }

    if (user.points < offer.pointsCost) {
      return NextResponse.json(
        { error: "Not enough SQRATCH points for this reward." },
        { status: 409 },
      );
    }

    const issuedAt = new Date();
    const code = generateRewardCode(offer.codePrefix);
    let redemption = await prisma.shopifyRewardRedemption.create({
      data: {
        userId: user.id,
        brandId: offer.brandId,
        offerId: offer.id,
        idempotencyKey,
        code,
        status: "PENDING",
        pointsCost: offer.pointsCost,
        discountAmountCents: offer.discountAmountCents,
        currencyCode: offer.currencyCode,
        shopifyShopDomain: offer.brand.shopifyShopDomain,
      },
    });

    try {
      redemption = await prisma.$transaction(async (tx) => {
        const debit = await tx.user.updateMany({
          where: {
            id: user.id,
            points: {
              gte: offer.pointsCost,
            },
          },
          data: {
            points: {
              decrement: offer.pointsCost,
            },
          },
        });

        if (debit.count !== 1) {
          throw new Error("INSUFFICIENT_POINTS");
        }

        await tx.pointTransaction.create({
          data: {
            userId: user.id,
            points: -offer.pointsCost,
            reason: "SHOPIFY_REWARD_REDEMPTION",
            shopifyRewardRedemptionId: redemption.id,
          },
        });

        return tx.shopifyRewardRedemption.update({
          where: {
            id: redemption.id,
          },
          data: {
            status: "POINTS_DEBITED",
          },
        });
      });
    } catch (error) {
      const isInsufficientPoints =
        error instanceof Error && error.message === "INSUFFICIENT_POINTS";

      await prisma.shopifyRewardRedemption.update({
        where: {
          id: redemption.id,
        },
        data: {
          status: "CANCELLED",
          errorMessage: isInsufficientPoints
            ? "Not enough SQRATCH points for this reward."
            : "Failed to debit points.",
        },
      });

      return NextResponse.json(
        {
          error: isInsufficientPoints
            ? "Not enough SQRATCH points for this reward."
            : "Failed to debit points for this reward.",
        },
        { status: isInsufficientPoints ? 409 : 500 },
      );
    }

    const discount = await createShopifyRewardDiscountCode({
      shopDomain: offer.brand.shopifyShopDomain,
      encryptedToken: offer.brand.shopifyAdminAccessTokenEncrypted,
      title: `${offer.brand.name} - ${offer.title}`,
      code,
      issuedAt,
      codeValidDays: offer.codeValidDays,
      discountAmountCents: offer.discountAmountCents,
      currencyCode: offer.currencyCode,
      appliesTo: offer.appliesTo,
      shopifyProductGids: offer.products.map(
        (product) => product.shopifyProductGid,
      ),
      minimumSubtotalCents: offer.minimumSubtotalCents,
    });

    if (!discount.ok) {
      const refunded = await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: {
            id: user.id,
          },
          data: {
            points: {
              increment: offer.pointsCost,
            },
          },
        });

        await tx.pointTransaction.create({
          data: {
            userId: user.id,
            points: offer.pointsCost,
            reason: "SHOPIFY_REWARD_REFUND",
            shopifyRewardRedemptionId: redemption.id,
          },
        });

        return tx.shopifyRewardRedemption.update({
          where: {
            id: redemption.id,
          },
          data: {
            status: "REFUNDED",
            errorMessage: discount.error,
            shopifyUserErrors: discount.userErrors || undefined,
          },
        });
      });

      return NextResponse.json(
        {
          error:
            "Could not create the Shopify discount code. Points were refunded.",
          data: serializeRedemption(refunded),
        },
        { status: discount.status || 502 },
      );
    }

    const issued = await prisma.shopifyRewardRedemption.update({
      where: {
        id: redemption.id,
      },
      data: {
        status: "ISSUED",
        shopifyDiscountNodeId: discount.discountNodeId,
        shopifyDiscountStatus: "ACTIVE",
        shopifyAsyncUsageCount: 0,
        issuedAt: discount.startsAt,
        expiresAt: discount.endsAt,
        shopifyUserErrors: discount.userErrors,
      },
    });

    return NextResponse.json({ data: serializeRedemption(issued) });
  } catch (error) {
    console.error("[rewards/shopify/redeem][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to redeem Shopify reward." },
      { status: 500 },
    );
  }
}
