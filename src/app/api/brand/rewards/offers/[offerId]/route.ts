import { NextRequest, NextResponse } from "next/server";
import { CommerceProvider } from "@prisma/client";
import {
  getBrandContextFailure,
  getBrandManagementContext,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { getShopifyShopCurrencyWithAccessToken, normalizeShopDomain } from "@/lib/shopify";
import { getValidAccessToken } from "@/lib/shopify-token-manager";
import {
  getActiveCommerceConnection,
  isConnectionUsable,
  recordCommerceConnectionCurrencyCode,
} from "@/lib/commerce/connection-service";
import {
  resolveRewardOfferUpdate,
  serializeRewardOffer,
  validateProductsBelongToConnectedStore,
} from "@/lib/reward-offers";
import { normalizeCurrency } from "@/lib/shopify-reward-compatibility";

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
      sourceExternalAccountId: true,
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

    // CANONICAL — `isConnected` and every domain/currency comparison below
    // come from the SAME resolved connection (see AGENTS.md Commerce
    // Invariants: current canonical connection is the only authority here).
    const connectionSummary = await getActiveCommerceConnection(
      brand.id,
      CommerceProvider.SHOPIFY,
    );
    const isConnected =
      connectionSummary !== null && isConnectionUsable(connectionSummary);
    let shopCurrency = connectionSummary?.currencyCode ?? null;

    if (!shopCurrency && isConnected && connectionSummary) {
      try {
        const tokenResult = await getValidAccessToken(brand.id, {
          connectionId: connectionSummary.id,
          expectedExternalAccountId: connectionSummary.externalAccountId,
        });
        if (tokenResult.ok) {
          const currencyResult = await getShopifyShopCurrencyWithAccessToken({
            shopDomain: connectionSummary.externalAccountId,
            accessToken: tokenResult.accessToken,
          });
          if (currencyResult.ok) {
            shopCurrency = currencyResult.currencyCode;
            await recordCommerceConnectionCurrencyCode(
              connectionSummary.id,
              shopCurrency,
            );
          }
        }
      } catch (err) {
        console.error("[brand/rewards/offers/[offerId]][PUT] Error refreshing missing shop currency:", err);
      }
    }

    const currentShopDomain = normalizeShopDomain(
      connectionSummary?.externalAccountId ?? null,
    );
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
          connectionId: connectionSummary!.id,
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

    const { data, sourceExternalAccountId } = resolution;

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
          sourceExternalAccountId,
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
