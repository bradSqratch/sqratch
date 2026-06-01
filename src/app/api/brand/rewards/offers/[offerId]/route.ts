import { NextRequest, NextResponse } from "next/server";
import { getBrandManagementContext } from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import {
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

async function getOwnedOffer(offerId: string, brandId: string) {
  return prisma.brandRewardOffer.findFirst({
    where: {
      id: offerId,
      brandId,
    },
    select: {
      id: true,
    },
  });
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ offerId: string }> },
) {
  try {
    const auth = await getBrandManagementContext();

    if (!auth?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const { offerId } = await context.params;
    const existing = await getOwnedOffer(offerId, auth.membership.brand.id);

    if (!existing) {
      return NextResponse.json(
        { error: "Reward offer not found." },
        { status: 404 },
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = parseRewardOfferPayload(body);

    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    }

    const brand = auth.membership.brand;
    const data = parsed.data;

    if (data.isActive && !canActivateShopifyOffer(brand)) {
      return NextResponse.json(
        {
          error:
            "Connect Shopify before activating a Shopify reward offer.",
        },
        { status: 400 },
      );
    }

    const offer = await prisma.$transaction(async (tx) => {
      await tx.brandRewardOfferProduct.deleteMany({
        where: {
          offerId,
        },
      });

      return tx.brandRewardOffer.update({
        where: {
          id: offerId,
        },
        data: {
          title: data.title,
          description: data.description,
          isActive: data.isActive,
          pointsCost: data.pointsCost,
          discountAmountCents: data.discountAmountCents,
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
    });

    return NextResponse.json({ data: serializeRewardOffer(offer) });
  } catch (error) {
    console.error("[brand/rewards/offers/[offerId]][PUT] Error:", error);
    return NextResponse.json(
      { error: "Failed to update reward offer." },
      { status: 500 },
    );
  }
}

export async function PATCH(
  _request: NextRequest,
  context: { params: Promise<{ offerId: string }> },
) {
  try {
    const auth = await getBrandManagementContext();

    if (!auth?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const { offerId } = await context.params;
    const existing = await getOwnedOffer(offerId, auth.membership.brand.id);

    if (!existing) {
      return NextResponse.json(
        { error: "Reward offer not found." },
        { status: 404 },
      );
    }

    const offer = await prisma.brandRewardOffer.update({
      where: {
        id: offerId,
      },
      data: {
        isActive: false,
      },
      include: {
        products: true,
      },
    });

    return NextResponse.json({ data: serializeRewardOffer(offer) });
  } catch (error) {
    console.error("[brand/rewards/offers/[offerId]][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to disable reward offer." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  context: { params: Promise<{ offerId: string }> },
) {
  return PATCH(_request, context);
}
