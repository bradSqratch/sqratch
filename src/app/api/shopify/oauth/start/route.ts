import { NextRequest, NextResponse } from "next/server";
import { getBrandAdminContext } from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import {
  createOauthState,
  isValidShopDomain,
  SHOPIFY_SCOPES,
} from "@/lib/shopify";

export async function GET(request: NextRequest) {
  try {
    const context = await getBrandAdminContext();

    if (!context?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const apiKey = process.env.SHOPIFY_API_KEY;

    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing SHOPIFY_API_KEY." },
        { status: 500 },
      );
    }

    const shop = String(
      request.nextUrl.searchParams.get("shop") ||
        context.membership.brand.shopifyShopDomain ||
        "",
    )
      .trim()
      .toLowerCase();

    if (!isValidShopDomain(shop)) {
      return NextResponse.json(
        { error: "A valid .myshopify.com domain is required." },
        { status: 400 },
      );
    }

    const state = createOauthState();
    const redirectUri = `${
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      request.nextUrl.origin
    }/api/shopify/oauth/callback`;

    await prisma.tokenStore.create({
      data: {
        service: `shopify_oauth_state:${state}`,
        token: JSON.stringify({
          brandId: context.membership.brand.id,
          userId: context.userId,
          shop,
        }),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const url = new URL(`https://${shop}/admin/oauth/authorize`);
    url.searchParams.set("client_id", apiKey);
    url.searchParams.set("scope", SHOPIFY_SCOPES);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);

    return NextResponse.redirect(url);
  } catch (error) {
    console.error("[shopify/oauth/start][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to start Shopify OAuth." },
      { status: 500 },
    );
  }
}
