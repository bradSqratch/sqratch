import { NextRequest, NextResponse } from "next/server";
import {
  Prisma,
  type RewardAppliesTo,
  type ShopifyRewardRedemption,
} from "@prisma/client";
import prisma from "@/lib/prisma";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";
import {
  debitShopifyRewardPoints,
  getUserSpendablePointBalance,
  refundShopifyRewardPoints,
} from "@/lib/points";
import { getRewardClaimContext } from "@/lib/reward-access";
import { createShopifyRewardDiscountCode } from "@/lib/shopify-discounts";
import { getValidAccessToken } from "@/lib/shopify-token-manager";
import {
  CLAIM_COUNTED_REDEMPTION_STATUSES,
  generateRewardCode,
  getRewardOfferAvailability,
} from "@/lib/reward-offers";
import {
  computeShopifyRewardCompatibility,
  type ShopifyRewardCompatibilityReason,
} from "@/lib/shopify-reward-compatibility";
import { idempotencyMatch } from "@/lib/redemption-idempotency";

function mapIncompatibilityToErrorCode(
  reasons: ShopifyRewardCompatibilityReason[],
): "CURRENCY_MISMATCH" | "PRODUCT_SOURCE_MISMATCH" {
  return reasons.includes("CURRENCY_REVIEW_REQUIRED")
    ? "CURRENCY_MISMATCH"
    : "PRODUCT_SOURCE_MISMATCH";
}

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
  CURRENCY_MISMATCH: {
    error: "Reward currency does not match the Shopify store currency. Please contact the brand.",
    status: 409,
  },
  PRODUCT_SOURCE_MISMATCH: {
    error: "This reward's products are not available for the connected Shopify store.",
    status: 409,
  },
};

function serializeRedemption(redemption: {
  id: string;
  code: string;
  status: string;
  pointsCost: number;
  discountType: "FIXED_AMOUNT" | "PERCENTAGE";
  discountAmountCents: number | null;
  discountPercentageBasisPoints: number | null;
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
    discountType: redemption.discountType,
    discountAmountCents: redemption.discountAmountCents,
    discountPercentageBasisPoints: redemption.discountPercentageBasisPoints,
    currencyCode: redemption.currencyCode,
    issuedAt: redemption.issuedAt,
    expiresAt: redemption.expiresAt,
    usedAt: redemption.usedAt,
    errorMessage: redemption.errorMessage || null,
  };
}

export async function POST(request: NextRequest) {
  return redeemImpl(request, realAuthResolvers);
}

export async function redeemImpl(request: NextRequest, deps: AuthResolvers) {
  try {
    const session = await deps.resolveSession();

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
      // NOTE: experienceSlug / campaignId are request-time routing context that
      // is NOT persisted on the redemption row.  offerId is the authoritative
      // binding identity for idempotency purposes.
      const matchResult = idempotencyMatch(
        { userId: existing.userId, offerId: existing.offerId },
        { userId: session.user.id, offerId },
      );
      if (matchResult === "USER_MISMATCH") {
        return NextResponse.json(
          { error: "Idempotency key is already in use." },
          { status: 409 },
        );
      }
      if (matchResult === "OFFER_MISMATCH") {
        return NextResponse.json(
          { error: "Idempotency key was already used for a different reward." },
          { status: 409 },
        );
      }
      // MATCH — safe to return the cached redemption
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
            shopifyCurrencyCode: true,
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

    // Recorded on the ledger (via metadata) only when the claim request
    // resolved to exactly one unlocked campaign — never guessed from a list
    // of several (a user can have multiple unlocks, and an experience can be
    // attached to multiple campaigns).
    const deterministicCampaignId =
      rewardContext.campaignIds.length === 1
        ? rewardContext.campaignIds[0]
        : null;

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

    // Compute compatibility before beginning the reservation — repeated
    // again with freshly loaded data inside the Serializable transaction
    // below as defense in depth against a change that races this check.
    const initialCompatibility = computeShopifyRewardCompatibility({
      offer: {
        discountType: offer.discountType,
        minimumSubtotalCents: offer.minimumSubtotalCents,
        currencyCode: offer.currencyCode,
        appliesTo: offer.appliesTo,
        sourceShopDomain: offer.sourceShopDomain,
      },
      shopifyConnected: true,
      currentShopDomain: offer.brand.shopifyShopDomain,
      currentStoreCurrency: offer.brand.shopifyCurrencyCode,
    });

    if (!initialCompatibility.compatible) {
      const mapped =
        redemptionErrorResponses[
          mapIncompatibilityToErrorCode(initialCompatibility.reasons)
        ];
      return NextResponse.json({ error: mapped.error }, { status: mapped.status });
    }

    const user = await prisma.user.findUnique({
      where: {
        id: session.user.id,
      },
      select: {
        id: true,
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

    const userPointsBalance = await getUserSpendablePointBalance({
      userId: user.id,
    });

    if (userPointsBalance < offer.pointsCost) {
      return NextResponse.json(
        { error: "Not enough SQRATCH points for this reward." },
        { status: 409 },
      );
    }

    const issuedAt = new Date();
    let reservation: {
      redemption: ShopifyRewardRedemption;
      discountConfig: {
        brandName: string;
        shopDomain: string;
        brandId: string;
        title: string;
        codeValidDays: number;
        discountType: "FIXED_AMOUNT" | "PERCENTAGE";
        discountAmountCents: number | null;
        discountPercentageBasisPoints: number | null;
        currencyCode: string;
        appliesTo: RewardAppliesTo;
        shopifyProductGids: string[];
        minimumSubtotalCents: number | null;
        pointsCost: number;
      };
    } | null = null;

    // Bounded retry loop: up to 3 attempts to handle the rare case where the
    // generated `code` collides with an existing unique value (P2002 on `code`).
    // Because the Serializable transaction rolls back atomically on any error —
    // including a P2002 — the debit and PointTransaction writes are fully
    // unwound before we ever reach the catch block, so retrying with a freshly
    // generated code cannot double-debit the user.
    // A P2002 on `idempotencyKey` (concurrent same-key request) is NOT retried
    // here — it falls through to the concurrent-existing lookup below so that
    // the already-committed row can be returned to the caller.
    const MAX_CODE_COLLISION_RETRIES = 3;
    let lastError: unknown;

    for (let attempt = 0; attempt < MAX_CODE_COLLISION_RETRIES; attempt++) {
      // Regenerate the code on every attempt so a collision gets a fresh value.
      const code = generateRewardCode(offer.codePrefix);

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
                  shopifyCurrencyCode: true,
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

          // Re-checked here with data freshly loaded inside the Serializable
          // transaction — defense in depth against a currency/product-source
          // change that raced the pre-transaction check above. Currency
          // validation only applies to currency-dependent offers (FIXED_AMOUNT,
          // or a set minimumSubtotalCents); a percentage reward with no
          // minimum subtotal is never blocked merely for a stored currency
          // difference.
          const currentCompatibility = computeShopifyRewardCompatibility({
            offer: {
              discountType: currentOffer.discountType,
              minimumSubtotalCents: currentOffer.minimumSubtotalCents,
              currencyCode: currentOffer.currencyCode,
              appliesTo: currentOffer.appliesTo,
              sourceShopDomain: currentOffer.sourceShopDomain,
            },
            shopifyConnected,
            currentShopDomain: currentOffer.brand.shopifyShopDomain,
            currentStoreCurrency: currentOffer.brand.shopifyCurrencyCode,
          });

          if (!currentCompatibility.compatible) {
            throw new Error(
              mapIncompatibilityToErrorCode(currentCompatibility.reasons),
            );
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
              discountType: currentOffer.discountType,
              discountAmountCents: currentOffer.discountAmountCents,
              discountPercentageBasisPoints: currentOffer.discountPercentageBasisPoints,
              currencyCode: currentOffer.currencyCode,
              shopifyShopDomain: currentOffer.brand.shopifyShopDomain!,
            },
          });

          // Central ledger debit: decrements spendable points (conditional, so
          // the balance can never go negative), records lifetime spent, and
          // writes the negative PointTransaction — all inside this Serializable
          // transaction. Lifetime earned is NOT reduced. Idempotency is
          // enforced by the ledger's unique constraints.
          const debit = await debitShopifyRewardPoints({
            userId: user.id,
            pointsCost: currentOffer.pointsCost,
            shopifyRewardRedemptionId: createdRedemption.id,
            campaignId: deterministicCampaignId,
            db: tx,
          });

          if (!debit.applied) {
            if (debit.reason === "INSUFFICIENT_POINTS") {
              throw new Error("INSUFFICIENT_POINTS");
            }
            // DUPLICATE / INVALID here would be a genuine anomaly for a freshly
            // created redemption id — roll the reservation back.
            throw new Error("OFFER_NOT_AVAILABLE");
          }

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
              brandId: currentOffer.brandId,
              title: currentOffer.title,
              codeValidDays: currentOffer.codeValidDays,
              discountType: currentOffer.discountType,
              discountAmountCents: currentOffer.discountAmountCents,
              discountPercentageBasisPoints: currentOffer.discountPercentageBasisPoints,
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

        // Transaction succeeded — exit the retry loop.
        break;
      } catch (error) {
        // Retry ONLY for a P2002 unique violation on the `code` field.
        // A P2002 on `idempotencyKey` means a concurrent request already
        // committed a row for this key — do NOT retry; fall through to the
        // concurrent-existing lookup so that row can be returned to the caller.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          const target = (error.meta?.target as string[] | undefined) ?? [];
          if (target.includes("code") && !target.includes("idempotencyKey")) {
            // Code collision — safe to retry because the Serializable TX rolled
            // back fully: no debit or PointTransaction was persisted.
            lastError = error;
            continue;
          }
        }

        // For every other error (known domain errors, P2034 serialization
        // failure, idempotencyKey P2002, etc.) drop out of the loop and handle
        // below.
        lastError = error;
        break;
      }
    }

    if (!reservation) {
      const error = lastError;

      const concurrentExisting =
        await prisma.shopifyRewardRedemption.findUnique({
          where: {
            idempotencyKey,
          },
        });

      if (concurrentExisting) {
        // Apply the same user+offer match check as the upfront existing-key
        // branch to guard against returning a row for the wrong offer.
        const concurrentMatch = idempotencyMatch(
          { userId: concurrentExisting.userId, offerId: concurrentExisting.offerId },
          { userId: user.id, offerId },
        );
        if (concurrentMatch === "MATCH") {
          return NextResponse.json({
            data: serializeRedemption(concurrentExisting),
          });
        }
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

    const { redemption, discountConfig } = reservation;

    const tokenResult = await getValidAccessToken(discountConfig.brandId);
    if (!tokenResult.ok) {
      const refunded = await prisma.$transaction(async (tx) => {
        const current = await tx.shopifyRewardRedemption.findUnique({
          where: { id: redemption.id },
          select: { status: true },
        });
        if (current?.status !== "POINTS_DEBITED") {
          return tx.shopifyRewardRedemption.findUniqueOrThrow({
            where: { id: redemption.id },
          });
        }
        // Restore spendable points + lifetime refunded (never lifetime earned).
        await refundShopifyRewardPoints({
          userId: user.id,
          points: discountConfig.pointsCost,
          shopifyRewardRedemptionId: redemption.id,
          campaignId: deterministicCampaignId,
          db: tx,
        });
        return tx.shopifyRewardRedemption.update({
          where: { id: redemption.id },
          data: {
            status: "REFUNDED",
            errorMessage: "Shopify token unavailable: " + tokenResult.reason,
          },
        });
      });
      return NextResponse.json(
        {
          error: "Could not create the Shopify discount code. Points were refunded.",
          data: serializeRedemption(refunded),
        },
        { status: 502 },
      );
    }

    const discount = await createShopifyRewardDiscountCode({
      shopDomain: discountConfig.shopDomain,
      accessToken: tokenResult.accessToken,
      title: `${discountConfig.brandName} - ${discountConfig.title}`,
      code: redemption.code,
      issuedAt,
      codeValidDays: discountConfig.codeValidDays,
      discountType: discountConfig.discountType,
      discountAmountCents: discountConfig.discountAmountCents,
      discountPercentageBasisPoints: discountConfig.discountPercentageBasisPoints,
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

        // Restore spendable points + lifetime refunded (never lifetime earned).
        await refundShopifyRewardPoints({
          userId: user.id,
          points: discountConfig.pointsCost,
          shopifyRewardRedemptionId: redemption.id,
          campaignId: deterministicCampaignId,
          db: tx,
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
