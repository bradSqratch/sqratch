import { NextRequest, NextResponse } from "next/server";
import { encryptSecret } from "@/lib/crypto";
import prisma from "@/lib/prisma";
import {
  buildShopifyPendingInstallService,
  buildShopifyDashboardRedirect,
  buildShopifyHmac,
  safeHmacEqual,
  createOauthState,
  SHOPIFY_PENDING_INSTALL_TTL_MS,
  SHOPIFY_SCOPES,
  isValidShopDomain,
} from "@/lib/shopify";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";

export async function GET(request: NextRequest) {
  return oauthCallbackImpl(request, realAuthResolvers);
}

export async function oauthCallbackImpl(
  request: NextRequest,
  deps: AuthResolvers,
) {
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

    // (a) Timing-safe HMAC comparison
    if (!safeHmacEqual(expectedHmac, hmac)) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "invalid_hmac",
        }),
      );
    }

    // (b) Timestamp freshness — reject if |now - timestamp| > 60 s
    const timestampStr = request.nextUrl.searchParams.get("timestamp");
    const timestampSec = timestampStr ? parseInt(timestampStr, 10) : NaN;
    if (isNaN(timestampSec) || Math.abs(Date.now() / 1000 - timestampSec) > 60) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "stale_oauth_timestamp",
        }),
      );
    }

    // (d) Single-use state: read payload first, then consume atomically before
    // token exchange so a failed/replayed callback cannot reuse the same state.
    const stateRecord = await prisma.tokenStore.findUnique({
      where: { service: `shopify_oauth_state:${state}` },
    });

    if (!stateRecord || stateRecord.expiresAt < new Date()) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "expired_oauth_state",
        }),
      );
    }

    const payload = JSON.parse(stateRecord.token) as { shop: string };

    if (payload.shop !== shop) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "shop_mismatch",
        }),
      );
    }

    // Consume the record now — before token exchange — so any subsequent replay
    // of this callback (same state token) hits count === 0 and is rejected.
    const consumed = await prisma.tokenStore.deleteMany({
      where: {
        service: stateRecord.service,
        expiresAt: { gt: new Date() },
      },
    });

    if (consumed.count === 0) {
      // Race: another request already consumed it.
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "expired_oauth_state",
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

    // (c) Verify returned scopes include all required scopes
    const requiredScopes = SHOPIFY_SCOPES.split(",");
    const grantedScopes = (tokenJson.scope as string | undefined)?.split(",") ?? [];
    const missingScopes = requiredScopes.filter((s) => !grantedScopes.includes(s));
    if (missingScopes.length > 0) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "insufficient_scopes",
        }),
      );
    }

    const pendingInstallId = createOauthState();

    await prisma.tokenStore.create({
      data: {
        service: buildShopifyPendingInstallService(pendingInstallId),
        token: JSON.stringify({
          shop,
          encryptedToken: encryptSecret(tokenJson.access_token),
        }),
        expiresAt: new Date(Date.now() + SHOPIFY_PENDING_INSTALL_TTL_MS),
      },
    });

    const installPath = `/dashboard/brand/shopify/install?install=${encodeURIComponent(pendingInstallId)}`;
    const session = await deps.resolveSession();
    const redirectUrl = session?.user?.id
      ? new URL(installPath, request.nextUrl.origin)
      : new URL(
          `/login?next=${encodeURIComponent(installPath)}`,
          request.nextUrl.origin,
        );

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
