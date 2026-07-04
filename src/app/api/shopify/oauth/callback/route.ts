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
import {
  buildExpiringPendingInstall,
  serializeExpiringPendingInstall,
} from "@/lib/pending-install";

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
    const state = String(
      request.nextUrl.searchParams.get("state") || "",
    ).trim();
    const hmac = String(request.nextUrl.searchParams.get("hmac") || "").trim();

    if (!shop || !code || !state || !hmac || !isValidShopDomain(shop)) {
      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "invalid_callback_params",
        }),
      );
    }

    const expectedHmac = buildShopifyHmac(
      request.nextUrl.searchParams,
      apiSecret,
    );

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
    if (
      isNaN(timestampSec) ||
      Math.abs(Date.now() / 1000 - timestampSec) > 60
    ) {
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

    const statePayload = JSON.parse(stateRecord.token) as { shop: string };

    if (statePayload.shop !== shop) {
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
          expiring: 1,
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

    if (
      !tokenJson.expires_in ||
      !tokenJson.refresh_token ||
      !tokenJson.refresh_token_expires_in
    ) {
      console.warn(
        "[shopify/oauth/callback] expiring offline token fields missing",
        {
          shop,
          hasExpiresIn: Boolean(tokenJson.expires_in),
          hasRefreshToken: Boolean(tokenJson.refresh_token),
          hasRefreshTokenExpiresIn: Boolean(tokenJson.refresh_token_expires_in),
        },
      );

      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: "expiring_token_fields_missing",
        }),
      );
    }

    // (c) Verify returned scopes include all required scopes
    const requiredScopes = SHOPIFY_SCOPES.split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);

    const grantedScopes = String(tokenJson.scope || "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean);

    const grantedScopeSet = new Set(grantedScopes);

    function isScopeSatisfied(scope: string) {
      if (grantedScopeSet.has(scope)) {
        return true;
      }

      // Shopify may return only write_discounts even when discount read/write access
      // is configured. Treat write_discounts as satisfying read_discounts.
      if (
        scope === "read_discounts" &&
        grantedScopeSet.has("write_discounts")
      ) {
        return true;
      }

      return false;
    }

    const missingScopes = requiredScopes.filter(
      (scope) => !isScopeSatisfied(scope),
    );

    if (missingScopes.length > 0) {
      console.warn("[shopify/oauth/callback] insufficient scopes", {
        shop,
        requiredScopes,
        grantedScopes,
        missingScopes,
      });

      return NextResponse.redirect(
        buildShopifyDashboardRedirect({
          origin: request.nextUrl.origin,
          error: `insufficient_scopes_${missingScopes.join("_")}`,
        }),
      );
    }

    const pendingInstallId = createOauthState();

    const now = Date.now();

    const pendingInstallPayload = buildExpiringPendingInstall({
      shop,
      clientId: apiKey,
      encryptedAccessToken: encryptSecret(tokenJson.access_token),
      accessTokenExpiresAt: new Date(
        now + Number(tokenJson.expires_in || 3600) * 1000,
      ).toISOString(),
      encryptedRefreshToken: encryptSecret(tokenJson.refresh_token),
      refreshTokenExpiresAt: new Date(
        now + Number(tokenJson.refresh_token_expires_in || 7776000) * 1000,
      ).toISOString(),
      grantedScopes: String(tokenJson.scope || ""),
    });

    await prisma.tokenStore.create({
      data: {
        service: buildShopifyPendingInstallService(pendingInstallId),
        token: serializeExpiringPendingInstall(pendingInstallPayload),
        expiresAt: new Date(now + SHOPIFY_PENDING_INSTALL_TTL_MS),
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
