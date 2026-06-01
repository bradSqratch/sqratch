import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { ShopifyRewardRedemptionStatus } from "@prisma/client";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { getShopifyDiscountUsageStatus } from "@/lib/shopify-discounts";

export async function POST(
  _request: NextRequest,
  context: { params: Promise<{ redemptionId: string }> },
) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { redemptionId } = await context.params;
    const redemption = await prisma.shopifyRewardRedemption.findFirst({
      where: {
        id: redemptionId,
        userId: session.user.id,
      },
      include: {
        brand: {
          select: {
            shopifyShopDomain: true,
            shopifyAdminAccessTokenEncrypted: true,
            shopifyConnectionStatus: true,
          },
        },
      },
    });

    if (!redemption) {
      return NextResponse.json(
        { error: "Reward redemption not found." },
        { status: 404 },
      );
    }

    if (
      !redemption.shopifyDiscountNodeId ||
      redemption.brand.shopifyConnectionStatus !== "CONNECTED" ||
      !redemption.brand.shopifyShopDomain ||
      !redemption.brand.shopifyAdminAccessTokenEncrypted
    ) {
      return NextResponse.json(
        { error: "Shopify discount status cannot be refreshed right now." },
        { status: 400 },
      );
    }

    const status = await getShopifyDiscountUsageStatus({
      shopDomain: redemption.brand.shopifyShopDomain,
      encryptedToken: redemption.brand.shopifyAdminAccessTokenEncrypted,
      discountNodeId: redemption.shopifyDiscountNodeId,
    });

    if (!status.ok) {
      return NextResponse.json(
        { error: status.error },
        { status: status.status },
      );
    }

    const nextStatus =
      status.derivedStatus === "USED"
        ? ShopifyRewardRedemptionStatus.USED
        : status.derivedStatus === "EXPIRED"
          ? ShopifyRewardRedemptionStatus.EXPIRED
          : redemption.status;
    const updated = await prisma.shopifyRewardRedemption.update({
      where: {
        id: redemption.id,
      },
      data: {
        status: nextStatus,
        shopifyDiscountStatus: status.status,
        shopifyAsyncUsageCount: status.asyncUsageCount,
        shopifyLastCheckedAt: new Date(),
        expiresAt: status.endsAt || redemption.expiresAt,
        usedAt:
          status.derivedStatus === "USED" && !redemption.usedAt
            ? new Date()
            : redemption.usedAt,
      },
    });

    return NextResponse.json({
      data: {
        id: updated.id,
        code: updated.code,
        status: updated.status,
        issuedAt: updated.issuedAt,
        expiresAt: updated.expiresAt,
        usedAt: updated.usedAt,
        shopifyDiscountStatus: updated.shopifyDiscountStatus,
        shopifyAsyncUsageCount: updated.shopifyAsyncUsageCount,
        shopifyLastCheckedAt: updated.shopifyLastCheckedAt,
      },
    });
  } catch (error) {
    console.error(
      "[rewards/shopify/redemptions/[redemptionId]/refresh-status][POST] Error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to refresh Shopify reward status." },
      { status: 500 },
    );
  }
}
