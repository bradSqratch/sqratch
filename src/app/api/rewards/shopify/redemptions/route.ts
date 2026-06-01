import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const redemptions = await prisma.shopifyRewardRedemption.findMany({
      where: {
        userId: session.user.id,
      },
      include: {
        brand: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
          },
        },
        offer: {
          select: {
            id: true,
            title: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return NextResponse.json({
      data: redemptions.map((redemption) => ({
        id: redemption.id,
        code: redemption.code,
        status: redemption.status,
        brand: redemption.brand,
        offer: redemption.offer,
        issuedAt: redemption.issuedAt,
        expiresAt: redemption.expiresAt,
        usedAt: redemption.usedAt,
        pointsCost: redemption.pointsCost,
        discountAmountCents: redemption.discountAmountCents,
        currencyCode: redemption.currencyCode,
        shopifyDiscountStatus: redemption.shopifyDiscountStatus,
        shopifyAsyncUsageCount: redemption.shopifyAsyncUsageCount,
        shopifyLastCheckedAt: redemption.shopifyLastCheckedAt,
      })),
    });
  } catch (error) {
    console.error("[rewards/shopify/redemptions][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load reward redemptions." },
      { status: 500 },
    );
  }
}
