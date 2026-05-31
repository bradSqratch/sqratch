import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  buildShopifyDashboardRedirect,
  createOauthState,
  getShopifyAppUrl,
  isValidShopDomain,
  SHOPIFY_SCOPES,
} from "@/lib/shopify";

export async function GET(request: NextRequest) {
  try {
    const apiKey = process.env.SHOPIFY_API_KEY;

    if (!apiKey) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "missing_shopify_api_key",
        }),
      );
    }

    const shop = String(
      request.nextUrl.searchParams.get("shop") || "",
    )
      .trim()
      .toLowerCase();

    if (!isValidShopDomain(shop)) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "invalid_shop_domain",
        }),
      );
    }

    const state = createOauthState();
    const redirectUri = new URL(
      "/api/shopify/oauth/callback",
      getShopifyAppUrl(request.nextUrl.origin),
    ).toString();

    await prisma.tokenStore.create({
      data: {
        service: `shopify_oauth_state:${state}`,
        token: JSON.stringify({
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
    return NextResponse.redirect(
      buildShopifyDashboardRedirect({
        origin: request.nextUrl.origin,
        error: "oauth_start_failed",
      }),
    );
  }
}
