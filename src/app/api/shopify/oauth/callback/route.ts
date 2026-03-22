import { NextRequest, NextResponse } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import prisma from "@/lib/prisma";
import { buildShopifyHmac, isValidShopDomain } from "@/lib/shopify";

export async function GET(request: NextRequest) {
  try {
    const apiKey = process.env.SHOPIFY_API_KEY;
    const apiSecret = process.env.SHOPIFY_API_SECRET;

    if (!apiKey || !apiSecret) {
      return NextResponse.json(
        { error: "Missing Shopify OAuth credentials." },
        { status: 500 },
      );
    }

    const shop = String(request.nextUrl.searchParams.get("shop") || "")
      .trim()
      .toLowerCase();
    const code = String(request.nextUrl.searchParams.get("code") || "").trim();
    const state = String(request.nextUrl.searchParams.get("state") || "").trim();
    const hmac = String(request.nextUrl.searchParams.get("hmac") || "").trim();

    if (!shop || !code || !state || !hmac || !isValidShopDomain(shop)) {
      return NextResponse.json(
        { error: "Invalid Shopify callback parameters." },
        { status: 400 },
      );
    }

    const expectedHmac = buildShopifyHmac(request.nextUrl.searchParams, apiSecret);

    if (expectedHmac !== hmac) {
      return NextResponse.json(
        { error: "Invalid Shopify HMAC." },
        { status: 400 },
      );
    }

    const stateRecord = await prisma.tokenStore.findUnique({
      where: {
        service: `shopify_oauth_state:${state}`,
      },
    });

    if (!stateRecord || stateRecord.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "Expired or missing OAuth state." },
        { status: 400 },
      );
    }

    const payload = JSON.parse(stateRecord.token) as {
      brandId: string;
      userId: string;
      shop: string;
    };

    if (payload.shop !== shop) {
      return NextResponse.json(
        { error: "OAuth state does not match shop domain." },
        { status: 400 },
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
      return NextResponse.json(
        { error: tokenJson?.error || "Failed to exchange Shopify token." },
        { status: 500 },
      );
    }

    await prisma.$transaction(async (tx) => {
      await tx.brand.update({
        where: {
          id: payload.brandId,
        },
        data: {
          shopifyShopDomain: shop,
          shopifyStorefrontAccessTokenEncrypted: encryptSecret(
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

    const redirectUrl = new URL(
      "/dashboard/brand/shopify?connected=1",
      request.nextUrl.origin,
    );
    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    console.error("[shopify/oauth/callback][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to complete Shopify OAuth." },
      { status: 500 },
    );
  }
}
