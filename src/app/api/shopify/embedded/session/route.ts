/**
 * POST /api/shopify/embedded/session
 *
 * Token-exchange endpoint for Shopify embedded public apps.
 * Verifies the App Bridge session token, exchanges it for an expiring offline
 * access token + refresh token, and stores an encrypted pending-install record.
 *
 * SECURITY:
 * - Shop is always sourced from the verified session token (dest claim), never
 *   from the request body or query string.
 * - Tokens are encrypted with encryptSecret() before storage and are never
 *   returned to the browser or logged.
 * - Only public app distribution supports this flow.
 */

import { NextResponse } from "next/server";
import { verifySessionTokenFromRequest } from "@/lib/shopify-session-token";
import {
  exchangeSessionTokenForOfflineToken,
  hasSufficientScopes,
} from "@/lib/shopify-token-manager";
import { encryptSecret } from "@/lib/crypto";
import {
  buildShopifyPendingInstallService,
  createOauthState,
  SHOPIFY_PENDING_INSTALL_TTL_MS,
} from "@/lib/shopify";
import prisma from "@/lib/prisma";
import { buildExpiringPendingInstall, serializeExpiringPendingInstall } from "@/lib/pending-install";

export async function POST(req: Request): Promise<NextResponse> {
  // ---------------------------------------------------------------------------
  // Step 1: Verify the Shopify App Bridge session token.
  // ---------------------------------------------------------------------------
  const verified = verifySessionTokenFromRequest(req);
  if (!verified.ok) {
    console.log("[shopify/embedded/session]", { outcome: "verify_failed", status: verified.status });
    return NextResponse.json({ error: verified.reason }, { status: verified.status });
  }

  // Sanitized log — shop sourced from verified token only, no raw token values.
  console.log("[shopify/embedded/session]", { outcome: "verified", shop: verified.shop });

  // ---------------------------------------------------------------------------
  // Step 2: Distribution guard — token exchange is only for public apps.
  // ---------------------------------------------------------------------------
  const distribution = process.env.SHOPIFY_APP_DISTRIBUTION ?? "public";
  if (distribution !== "public") {
    return NextResponse.json(
      { error: "Token exchange is not enabled for this distribution." },
      { status: 400 },
    );
  }

  // ---------------------------------------------------------------------------
  // Step 3: The authoritative shop comes exclusively from the verified token.
  // (verified.shop is the hostname extracted from the dest claim.)
  // ---------------------------------------------------------------------------
  const shop = verified.shop;

  // ---------------------------------------------------------------------------
  // Step 4: Re-read the raw bearer token from the Authorization header to use
  // as the subject_token in the exchange request. The verifier deliberately
  // does not return the raw token, so we read it again here.
  // ---------------------------------------------------------------------------
  const authHeader = req.headers.get("authorization") ?? "";
  const rawToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (!rawToken) {
    return NextResponse.json({ error: "missing token" }, { status: 401 });
  }

  // ---------------------------------------------------------------------------
  // Step 5: Ensure app credentials are present.
  // (The verifier already checked these, but guard defensively.)
  // ---------------------------------------------------------------------------
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;

  if (!apiKey || !apiSecret) {
    return NextResponse.json({ error: "authentication unavailable" }, { status: 401 });
  }

  // ---------------------------------------------------------------------------
  // Step 6: Exchange the session token for an expiring offline access token.
  // ---------------------------------------------------------------------------
  let result: Awaited<ReturnType<typeof exchangeSessionTokenForOfflineToken>>;
  try {
    result = await exchangeSessionTokenForOfflineToken({
      shop,
      sessionToken: rawToken,
      clientId: apiKey,
      clientSecret: apiSecret,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[shopify/embedded/session] Token exchange failed:", message);
    console.log("[shopify/embedded/session]", { outcome: "exchange_failed" });
    return NextResponse.json(
      { error: "Could not complete Shopify authorization. Please try again." },
      { status: 502 },
    );
  }

  console.log("[shopify/embedded/session]", { outcome: "exchanged" });

  // ---------------------------------------------------------------------------
  // Step 7: Scope check — do not store anything if scopes are insufficient.
  // ---------------------------------------------------------------------------
  if (!hasSufficientScopes(result.scope)) {
    return NextResponse.json(
      {
        error:
          "SQRATCH requires product, discount read and discount write permissions.",
      },
      { status: 403 },
    );
  }

  // ---------------------------------------------------------------------------
  // Step 8: Build the pending-install payload with encrypted tokens via the
  // shared pending-install module.  Neither token nor any encrypted value is
  // ever logged or returned.
  // ---------------------------------------------------------------------------
  const now = Date.now();
  const payload = buildExpiringPendingInstall({
    shop,
    clientId: apiKey,
    encryptedAccessToken: encryptSecret(result.accessToken),
    accessTokenExpiresAt: new Date(now + result.expiresIn * 1000).toISOString(),
    encryptedRefreshToken: encryptSecret(result.refreshToken),
    refreshTokenExpiresAt: new Date(
      now + result.refreshTokenExpiresIn * 1000,
    ).toISOString(),
    grantedScopes: result.scope,
  });

  // ---------------------------------------------------------------------------
  // Step 9: Persist a single-use pending-install record.
  // ---------------------------------------------------------------------------
  const installId = createOauthState();
  await prisma.tokenStore.create({
    data: {
      service: buildShopifyPendingInstallService(installId),
      token: serializeExpiringPendingInstall(payload),
      expiresAt: new Date(now + SHOPIFY_PENDING_INSTALL_TTL_MS),
    },
  });

  // ---------------------------------------------------------------------------
  // Step 10: Return only the installId — no token is ever sent to the browser.
  // ---------------------------------------------------------------------------
  return NextResponse.json({ data: { installId } });
}
