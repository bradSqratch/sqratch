import { NextRequest, NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { getShopifyShopCurrency, normalizeShopDomain } from "@/lib/shopify";
import {
  resolveRewardOfferUpdate,
  serializeRewardOffer,
  validateProductsBelongToConnectedStore,
} from "@/lib/reward-offers";
import { normalizeCurrency } from "@/lib/shopify-reward-compatibility";

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
      discountType: true,
      minimumSubtotalCents: true,
      currencyCode: true,
      appliesTo: true,
      sourceShopDomain: true,
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
      const failure = getBrandContextFailure(auth);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
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

    const brand = auth.membership.brand;
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
        console.error("[brand/rewards/offers/[offerId]][PUT] Error refreshing missing shop currency:", err);
      }
    }

    const isConnected = canActivateShopifyOffer(brand);
    const currentShopDomain = normalizeShopDomain(brand.shopifyShopDomain);
    const currentStoreCurrency = normalizeCurrency(shopCurrency);

    const body = await request.json().catch(() => null);

    const resolution = await resolveRewardOfferUpdate({
      existing,
      body,
      isConnected,
      currentShopDomain,
      currentStoreCurrency,
      validateProducts: (products) =>
        validateProductsBelongToConnectedStore({
          shopDomain: currentShopDomain!,
          brandId: brand.id,
          products,
        }),
    });

    if (!resolution.ok) {
      return NextResponse.json(
        {
          error: resolution.error,
          code: resolution.code,
          ...(resolution.details || {}),
        },
        { status: resolution.status },
      );
    }

    const { data, sourceShopDomain } = resolution;

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
          sourceShopDomain,
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
      const failure = getBrandContextFailure(auth);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
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
