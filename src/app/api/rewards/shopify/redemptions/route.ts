import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { deriveShopifyStorefrontUrl } from "@/lib/commerce/connection-service";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const redemptions = await prisma.commerceRewardRedemption.findMany({
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
        discountType: redemption.discountType,
        discountAmountCents: redemption.discountAmountCents,
        discountPercentageBasisPoints: redemption.discountPercentageBasisPoints,
        currencyCode: redemption.currencyCode,
        // Maintain the established Shopify endpoint contract. The fields are
        // mapped from provider-neutral persistence names above this boundary.
        shopifyDiscountStatus: redemption.externalDiscountStatus,
        shopifyAsyncUsageCount: redemption.externalUsageCount,
        shopifyLastCheckedAt: redemption.providerLastCheckedAt,
        // The redemption's OWN historical shop-domain snapshot (captured at
        // redemption time) — never the brand's current domain, which could
        // have relinked since. See src/lib/commerce/connection-service.ts's
        // deriveShopifyStorefrontUrl doc comment.
        shopUrl: deriveShopifyStorefrontUrl(redemption.externalAccountId),
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
