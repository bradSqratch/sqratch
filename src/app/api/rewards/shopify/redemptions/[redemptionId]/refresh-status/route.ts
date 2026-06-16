import { NextRequest, NextResponse } from "next/server";
import { ShopifyRewardRedemptionStatus } from "@prisma/client";
import prisma from "@/lib/prisma";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";

import { getShopifyDiscountUsageStatus } from "@/lib/shopify-discounts";
import { getValidAccessToken } from "@/lib/shopify-token-manager";
import { canRefresh, assertTransition } from "@/lib/reward-redemption-state";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ redemptionId: string }> },
) {
  return refreshStatusImpl(request, context, realAuthResolvers);
}

export async function refreshStatusImpl(
  _request: NextRequest,
  context: { params: Promise<{ redemptionId: string }> },
  deps: AuthResolvers,
) {
  try {
    const session = await deps.resolveSession();

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

    // State-machine guard: only ISSUED redemptions may be refreshed.
    if (!canRefresh(redemption.status)) {
      // USED and EXPIRED are already terminal "success" states — return current
      // state as a 200 idempotent no-op so the client can display them.
      if (
        redemption.status === ShopifyRewardRedemptionStatus.USED ||
        redemption.status === ShopifyRewardRedemptionStatus.EXPIRED
      ) {
        return NextResponse.json({
          data: {
            id: redemption.id,
            code: redemption.code,
            status: redemption.status,
            issuedAt: redemption.issuedAt,
            expiresAt: redemption.expiresAt,
            usedAt: redemption.usedAt,
            shopifyDiscountStatus: redemption.shopifyDiscountStatus,
            shopifyAsyncUsageCount: redemption.shopifyAsyncUsageCount,
            shopifyLastCheckedAt: redemption.shopifyLastCheckedAt,
          },
        });
      }

      // All other non-refreshable statuses (PENDING, POINTS_DEBITED, REFUNDED,
      // FAILED, CANCELLED) → conflict.
      return NextResponse.json(
        { error: "Redemption is not in a refreshable state." },
        { status: 409 },
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

    const tokenResult = await getValidAccessToken(redemption.brandId);
    if (!tokenResult.ok) {
      return NextResponse.json(
        { error: "Shopify discount status cannot be refreshed right now." },
        { status: 400 },
      );
    }

    const status = await getShopifyDiscountUsageStatus({
      shopDomain: redemption.brand.shopifyShopDomain,
      accessToken: tokenResult.accessToken,
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

    // Validate the transition before writing.  Allows ISSUED→USED, ISSUED→EXPIRED,
    // and ISSUED→ISSUED (unchanged / idempotent).
    assertTransition(redemption.status, nextStatus);

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
