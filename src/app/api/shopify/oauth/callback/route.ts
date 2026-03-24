import { NextRequest, NextResponse } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import prisma from "@/lib/prisma";
import {
  buildShopifyDashboardRedirect,
  buildShopifyHmac,
  isValidShopDomain,
} from "@/lib/shopify";

export async function GET(request: NextRequest) {
  try {
    const apiKey = process.env.SHOPIFY_API_KEY;
    const apiSecret = process.env.SHOPIFY_API_SECRET;

    if (!apiKey || !apiSecret) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "missing_shopify_credentials",
        }),
      );
    }

    const shop = String(request.nextUrl.searchParams.get("shop") || "")
      .trim()
      .toLowerCase();
    const code = String(request.nextUrl.searchParams.get("code") || "").trim();
    const state = String(request.nextUrl.searchParams.get("state") || "").trim();
    const hmac = String(request.nextUrl.searchParams.get("hmac") || "").trim();

    if (!shop || !code || !state || !hmac || !isValidShopDomain(shop)) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "invalid_callback_params",
        }),
      );
    }

    const expectedHmac = buildShopifyHmac(request.nextUrl.searchParams, apiSecret);

    if (expectedHmac !== hmac) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "invalid_hmac",
        }),
      );
    }

    const stateRecord = await prisma.tokenStore.findUnique({
      where: {
        service: `shopify_oauth_state:${state}`,
      },
    });

    if (!stateRecord || stateRecord.expiresAt < new Date()) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "expired_oauth_state",
        }),
      );
    }

    const payload = JSON.parse(stateRecord.token) as {
      brandId: string;
      userId: string;
      shop: string;
    };

    if (payload.shop !== shop) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "shop_mismatch",
        }),
      );
    }

    const tokenResponse = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: apiKey,
          client_secret: apiSecret,
          code,
        }),
      },
    );

    const tokenJson = await tokenResponse.json().catch(() => null);

    if (!tokenResponse.ok || !tokenJson?.access_token) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "token_exchange_failed",
        }),
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.brand.update({
        where: {
          id: payload.brandId,
        },
        data: {
          shopifyShopDomain: shop,
          shopifyAdminAccessTokenEncrypted: encryptSecret(
            tokenJson.access_token,
          ),
          shopifyInstalledAt: new Date(),
        },
      });

      await tx.tokenStore.delete({
        where: {
          service: stateRecord.service,
        },
      });
    });

    const redirectUrl = buildShopifyDashboardRedirect({
      origin: request.nextUrl.origin,
      connected: "1",
    });
    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    console.error("[shopify/oauth/callback][GET] Error:", error);
    return NextResponse.redirect(
      buildShopifyDashboardRedirect({
        origin: request.nextUrl.origin,
        error: "oauth_callback_failed",
      }),
    );
  }
}
