import { NextRequest, NextResponse } from "next/server";
import { getBrandManagementContext } from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { getShopifyShopCurrency } from "@/lib/shopify";
import {
  CLAIM_COUNTED_REDEMPTION_STATUSES,
  getRewardOfferAvailability,
  parseRewardOfferPayload,
  serializeRewardOffer,
} from "@/lib/reward-offers";

function canActivateShopifyOffer(brand: {
  shopifyConnectionStatus: string;
  shopifyShopDomain: string | null;
  shopifyAdminAccessTokenEncrypted: string | null;
}) {
  return (
    brand.shopifyConnectionStatus === "CONNECTED" &&
    Boolean(brand.shopifyShopDomain) &&
    Boolean(brand.shopifyAdminAccessTokenEncrypted)
  );
}

export async function GET() {
  try {
    const context = await getBrandManagementContext();

    if (!context?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const brand = context.membership.brand;
    const offers = await prisma.brandRewardOffer.findMany({
      where: {
        brandId: brand.id,
      },
      include: {
        products: true,
        _count: {
          select: {
            redemptions: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });
    const statusCounts = await prisma.shopifyRewardRedemption.groupBy({
      by: ["offerId", "status"],
      where: {
        brandId: brand.id,
      },
      _count: {
        _all: true,
      },
    });
    const countedStatuses = new Set<string>([
      ...CLAIM_COUNTED_REDEMPTION_STATUSES,
    ]);
    const countedRedemptionsByOffer = new Map<string, number>();
    const statsByOffer = new Map<
      string,
      { totalIssued: number; usedCount: number; expiredCount: number; failedCount: number }
    >();

    for (const count of statusCounts) {
      const stats =
        statsByOffer.get(count.offerId) ||
        {
          totalIssued: 0,
          usedCount: 0,
          expiredCount: 0,
          failedCount: 0,
        };

      if (["ISSUED", "USED", "EXPIRED"].includes(count.status)) {
        stats.totalIssued += count._count._all;
      }

      if (countedStatuses.has(count.status)) {
        countedRedemptionsByOffer.set(
          count.offerId,
          (countedRedemptionsByOffer.get(count.offerId) || 0) +
            count._count._all,
        );
      }

      if (count.status === "USED") {
        stats.usedCount += count._count._all;
      }

      if (count.status === "EXPIRED") {
        stats.expiredCount += count._count._all;
      }

      if (["FAILED", "REFUNDED"].includes(count.status)) {
        stats.failedCount += count._count._all;
      }

      statsByOffer.set(count.offerId, stats);
    }

    return NextResponse.json({
      data: offers.map((offer) => {
        const computedAvailability = getRewardOfferAvailability({
          offer,
          shopifyConnected: canActivateShopifyOffer(brand),
          totalRedemptions: countedRedemptionsByOffer.get(offer.id) || 0,
        });

        return {
          ...serializeRewardOffer(offer),
          redemptionCount: offer._count.redemptions,
          computedAvailability,
          stats: statsByOffer.get(offer.id) || {
            totalIssued: 0,
            usedCount: 0,
            expiredCount: 0,
            failedCount: 0,
          },
        };
      }),
    });
  } catch (error) {
    console.error("[brand/rewards/offers][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load reward offers." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await getBrandManagementContext();

    if (!context?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const brand = context.membership.brand;
    let shopCurrency = brand.shopifyCurrencyCode;

    if (!shopCurrency && brand.shopifyShopDomain && brand.shopifyAdminAccessTokenEncrypted) {
      try {
        const currencyResult = await getShopifyShopCurrency({
          shopDomain: brand.shopifyShopDomain,
          encryptedToken: brand.shopifyAdminAccessTokenEncrypted,
        });
        if (currencyResult.ok) {
          shopCurrency = currencyResult.currencyCode;
          await prisma.brand.update({
            where: { id: brand.id },
            data: { shopifyCurrencyCode: shopCurrency },
          });
        }
      } catch (err) {
        console.error("[brand/rewards/offers][POST] Error refreshing missing shop currency:", err);
      }
    }

    const body = await request.json().catch(() => null);
    const parsed = parseRewardOfferPayload(body, shopCurrency);

    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const data = parsed.data;

    if (data.isActive && !canActivateShopifyOffer(brand)) {
      return NextResponse.json(
        {
          error:
            "Reconnect Shopify before creating or enabling reward offers.",
        },
        { status: 400 },
      );
    }

    const offer = await prisma.brandRewardOffer.create({
      data: {
        brandId: brand.id,
        title: data.title,
        description: data.description,
        isActive: data.isActive,
        pointsCost: data.pointsCost,
        discountType: data.discountType,
        discountAmountCents: data.discountAmountCents,
        discountPercentageBasisPoints: data.discountPercentageBasisPoints,
        currencyCode: data.currencyCode,
        claimStartsAt: data.claimStartsAt,
        claimEndsAt: data.claimEndsAt,
        codeValidDays: data.codeValidDays,
        appliesTo: data.appliesTo,
        minimumSubtotalCents: data.minimumSubtotalCents,
        codePrefix: data.codePrefix,
        maxTotalRedemptions: data.maxTotalRedemptions,
        maxRedemptionsPerUser: data.maxRedemptionsPerUser,
        products: {
          create: data.products,
        },
      },
      include: {
        products: true,
      },
    });

    return NextResponse.json({ data: serializeRewardOffer(offer) }, { status: 201 });
  } catch (error) {
    console.error("[brand/rewards/offers][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create reward offer." },
      { status: 500 },
    );
  }
}
