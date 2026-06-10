import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import {
  Prisma,
  type RewardAppliesTo,
  type ShopifyRewardRedemption,
} from "@prisma/client";
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

const redemptionErrorResponses: Record<
  string,
  { error: string; status: number }
> = {
  OFFER_NOT_AVAILABLE: {
    error: "Reward offer is not available.",
    status: 409,
  },
  SHOPIFY_DISCONNECTED: {
    error: "Shopify is not connected for this brand.",
    status: 400,
  },
  INSUFFICIENT_POINTS: {
    error: "Not enough SQRATCH points for this reward.",
    status: 409,
  },
  INACTIVE: {
    error: "Inactive",
    status: 409,
  },
  NOT_STARTED: {
    error: "Not started",
    status: 409,
  },
  CLAIM_WINDOW_ENDED: {
    error: "Claim window ended",
    status: 409,
  },
  LIMIT_REACHED: {
    error: "Limit reached",
    status: 409,
  },
  USER_LIMIT_REACHED: {
    error: "User limit reached",
    status: 409,
  },
};

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
    let reservation: {
      redemption: ShopifyRewardRedemption;
      discountConfig: {
        brandName: string;
        shopDomain: string;
        encryptedToken: string;
        title: string;
        codeValidDays: number;
        discountAmountCents: number;
        currencyCode: string;
        appliesTo: RewardAppliesTo;
        shopifyProductGids: string[];
        minimumSubtotalCents: number | null;
        pointsCost: number;
      };
    } | null = null;

    try {
      reservation = await prisma.$transaction(async (tx) => {
        const currentOffer = await tx.brandRewardOffer.findUnique({
          where: {
            id: offer.id,
          },
          include: {
            brand: {
              select: {
                name: true,
                shopifyConnectionStatus: true,
                shopifyShopDomain: true,
                shopifyAdminAccessTokenEncrypted: true,
              },
            },
            products: {
              select: {
                shopifyProductGid: true,
              },
            },
          },
        });

        if (!currentOffer || currentOffer.brandId !== offer.brandId) {
          throw new Error("OFFER_NOT_AVAILABLE");
        }

        const shopifyConnected =
          currentOffer.brand.shopifyConnectionStatus === "CONNECTED" &&
          Boolean(currentOffer.brand.shopifyShopDomain) &&
          Boolean(currentOffer.brand.shopifyAdminAccessTokenEncrypted);

        if (!shopifyConnected) {
          throw new Error("SHOPIFY_DISCONNECTED");
        }

        const [currentTotalRedemptions, currentUserRedemptions] =
          await Promise.all([
            currentOffer.maxTotalRedemptions
              ? tx.shopifyRewardRedemption.count({
                  where: {
                    offerId: currentOffer.id,
                    status: {
                      in: [...CLAIM_COUNTED_REDEMPTION_STATUSES],
                    },
                  },
                })
              : Promise.resolve(0),
            currentOffer.maxRedemptionsPerUser
              ? tx.shopifyRewardRedemption.count({
                  where: {
                    offerId: currentOffer.id,
                    userId: user.id,
                    status: {
                      in: [...CLAIM_COUNTED_REDEMPTION_STATUSES],
                    },
                  },
                })
              : Promise.resolve(0),
          ]);
        const currentAvailability = getRewardOfferAvailability({
          offer: currentOffer,
          shopifyConnected,
          totalRedemptions: currentTotalRedemptions,
          userRedemptions: currentUserRedemptions,
          now: issuedAt,
        });

        if (!currentAvailability.claimable) {
          throw new Error(currentAvailability.status);
        }

        const createdRedemption = await tx.shopifyRewardRedemption.create({
          data: {
            userId: user.id,
            brandId: currentOffer.brandId,
            offerId: currentOffer.id,
            idempotencyKey,
            code,
            status: "PENDING",
            pointsCost: currentOffer.pointsCost,
            discountAmountCents: currentOffer.discountAmountCents,
            currencyCode: currentOffer.currencyCode,
            shopifyShopDomain: currentOffer.brand.shopifyShopDomain!,
          },
        });

        const debit = await tx.user.updateMany({
          where: {
            id: user.id,
            points: {
              gte: currentOffer.pointsCost,
            },
          },
          data: {
            points: {
              decrement: currentOffer.pointsCost,
            },
          },
        });

        if (debit.count !== 1) {
          throw new Error("INSUFFICIENT_POINTS");
        }

        await tx.pointTransaction.create({
          data: {
            userId: user.id,
            points: -currentOffer.pointsCost,
            reason: "SHOPIFY_REWARD_REDEMPTION",
            shopifyRewardRedemptionId: createdRedemption.id,
          },
        });

        const debitedRedemption = await tx.shopifyRewardRedemption.update({
          where: {
            id: createdRedemption.id,
          },
          data: {
            status: "POINTS_DEBITED",
          },
        });

        return {
          redemption: debitedRedemption,
          discountConfig: {
            brandName: currentOffer.brand.name,
            shopDomain: currentOffer.brand.shopifyShopDomain!,
            encryptedToken:
              currentOffer.brand.shopifyAdminAccessTokenEncrypted!,
            title: currentOffer.title,
            codeValidDays: currentOffer.codeValidDays,
            discountAmountCents: currentOffer.discountAmountCents,
            currencyCode: currentOffer.currencyCode,
            appliesTo: currentOffer.appliesTo,
            shopifyProductGids: currentOffer.products.map(
              (product) => product.shopifyProductGid,
            ),
            minimumSubtotalCents: currentOffer.minimumSubtotalCents,
            pointsCost: currentOffer.pointsCost,
          },
        };
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (error) {
      const concurrentExisting =
        await prisma.shopifyRewardRedemption.findUnique({
          where: {
            idempotencyKey,
          },
        });

      if (concurrentExisting?.userId === user.id) {
        return NextResponse.json({
          data: serializeRedemption(concurrentExisting),
        });
      }

      const errorCode = error instanceof Error ? error.message : "";
      const knownError = redemptionErrorResponses[errorCode];

      if (knownError) {
        return NextResponse.json(
          { error: knownError.error },
          { status: knownError.status },
        );
      }

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034"
      ) {
        return NextResponse.json(
          { error: "Reward availability changed. Please try again." },
          { status: 409 },
        );
      }

      console.error("[rewards/shopify/redeem][reserve] Error:", error);
      return NextResponse.json(
        { error: "Failed to reserve this reward." },
        { status: 500 },
      );
    }

    if (!reservation) {
      return NextResponse.json(
        { error: "Failed to reserve this reward." },
        { status: 500 },
      );
    }

    const { redemption, discountConfig } = reservation;
    const discount = await createShopifyRewardDiscountCode({
      shopDomain: discountConfig.shopDomain,
      encryptedToken: discountConfig.encryptedToken,
      title: `${discountConfig.brandName} - ${discountConfig.title}`,
      code: redemption.code,
      issuedAt,
      codeValidDays: discountConfig.codeValidDays,
      discountAmountCents: discountConfig.discountAmountCents,
      currencyCode: discountConfig.currencyCode,
      appliesTo: discountConfig.appliesTo,
      shopifyProductGids: discountConfig.shopifyProductGids,
      minimumSubtotalCents: discountConfig.minimumSubtotalCents,
    });

    if (!discount.ok) {
      const refunded = await prisma.$transaction(async (tx) => {
        const current = await tx.shopifyRewardRedemption.findUnique({
          where: {
            id: redemption.id,
          },
          select: {
            status: true,
          },
        });

        if (current?.status !== "POINTS_DEBITED") {
          return tx.shopifyRewardRedemption.findUniqueOrThrow({
            where: {
              id: redemption.id,
            },
          });
        }

        await tx.user.update({
          where: {
            id: user.id,
          },
          data: {
            points: {
              increment: discountConfig.pointsCost,
            },
          },
        });

        await tx.pointTransaction.create({
          data: {
            userId: user.id,
            points: discountConfig.pointsCost,
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
