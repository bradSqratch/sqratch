import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  buildShopifyPendingInstallService,
  getShopifyShopCurrency,
  normalizeShopDomain,
} from "@/lib/shopify";
import { getBrandContextFailure } from "@/lib/brand-auth";
import {
  parsePendingInstall,
  type PendingInstallPayload,
} from "@/lib/pending-install";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";
import { ACTIVE_BRAND_COOKIE } from "@/lib/brand-context";
import {
  recordShopifyConnectionInstall,
  recordShopifyConnectionLoss,
  resolveInstallConnectionEventType,
  resolveLastKnownShopDomain,
} from "@/lib/shopify-connection-transitions";
import { applyShopifyConnectionSyncFromInstall } from "@/lib/commerce/connection-sync";
import { extractCurrencyCodeFromProviderMetadata } from "@/lib/commerce/connection-resolver";
import { decryptSecret } from "@/lib/crypto";


// Re-export types for backward compatibility if needed elsewhere
export type { PendingInstallPayload };

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ installId: string }> },
) {
  return installationsGetImpl(request, context, realAuthResolvers);
}

export async function installationsGetImpl(
  _request: NextRequest,
  context: { params: Promise<{ installId: string }> },
  deps: AuthResolvers,
) {
  try {
    const session = await deps.resolveSession();

    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const { installId } = await context.params;
    const pendingInstall = await prisma.tokenStore.findUnique({
      where: {
        service: buildShopifyPendingInstallService(installId),
      },
    });
    const payload = pendingInstall
      ? parsePendingInstall(pendingInstall.token)
      : null;

    if (!pendingInstall || !payload || pendingInstall.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "Shopify install session expired." },
        { status: 404 },
      );
    }

    // Brand/Shopify-management eligibility uses the same shared policy as
    // every other Brand-management surface: global role BRAND_ADMIN/ADMIN,
    // plus an ADMIN/MANAGER BrandMember row on an active Brand (or, for a
    // global ADMIN, an explicitly selected active Brand). A stray BrandMember
    // row never grants access to a USER or CREATOR account.
    const brandContext = await deps.resolveBrandAdminContext();

    if (!brandContext || brandContext.brands.length === 0) {
      const failure = getBrandContextFailure(brandContext);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    return NextResponse.json({
      data: {
        shop: payload.shop,
        activeBrandId: brandContext.membership?.brand.id ?? null,
        brands: brandContext.brands.map((brand) => ({
          id: brand.id,
          name: brand.name,
          slug: brand.slug,
        })),
      },
    });
  } catch {
    console.error("[shopify/installations/[installId]][GET] Error", {
      outcome: "load_failed",
    });
    return NextResponse.json(
      { error: "Failed to load Shopify install." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ installId: string }> },
) {
  return installationsPostImpl(request, context, realAuthResolvers);
}

export async function installationsPostImpl(
  request: NextRequest,
  context: { params: Promise<{ installId: string }> },
  deps: AuthResolvers,
) {
  try {
    const session = await deps.resolveSession();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const { installId } = await context.params;
    const pendingService = buildShopifyPendingInstallService(installId);
    const pendingInstall = await prisma.tokenStore.findUnique({
      where: {
        service: pendingService,
      },
    });
    const payload = pendingInstall
      ? parsePendingInstall(pendingInstall.token)
      : null;

    if (!pendingInstall || !payload || pendingInstall.expiresAt < new Date()) {
      return NextResponse.json(
        { error: "Shopify install session expired." },
        { status: 404 },
      );
    }

    const body = await request.json().catch(() => null);
    const requestedBrandId = String(body?.brandId || "").trim();

    // The installation flow only ever links to an existing, eligible active
    // Brand — Brand creation remains part of the normal approval/admin
    // workflow. A `createBrand` payload is a defunct client contract and is
    // rejected outright rather than silently ignored.
    if (body?.createBrand) {
      return NextResponse.json(
        {
          error:
            "Creating a Brand during Shopify installation is not supported. Select an existing eligible Brand.",
        },
        { status: 400 },
      );
    }

    if (!requestedBrandId) {
      return NextResponse.json(
        { error: "Select an authorized brand." },
        { status: 400 },
      );
    }

    const brandContext = await deps.resolveBrandAdminContext();
    if (!brandContext || brandContext.brands.length === 0) {
      const failure = getBrandContextFailure(brandContext);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    // ---------------------------------------------------------------------------
    // Query currency — resolve the encrypted access token for the API call
    // regardless of which token shape is in use.
    // ---------------------------------------------------------------------------
    const encryptedTokenForCurrency =
      payload.shape === "EXPIRING"
        ? payload.encryptedAccessToken
        : payload.encryptedToken;

    let shopifyCurrencyCode: string | null = null;
    try {
      const currencyResult = await getShopifyShopCurrency({
        shopDomain: payload.shop,
        encryptedToken: encryptedTokenForCurrency,
      });
      if (currencyResult.ok) {
        shopifyCurrencyCode = currencyResult.currencyCode;
      } else {
        console.warn("[shopify/installations/[installId]] Failed to query currency:", currencyResult.error);
      }
    } catch {
      console.error("[shopify/installations/[installId]] Error querying currency", {
        outcome: "currency_lookup_failed",
      });
    }

    // The canonical credential, decrypted once from the authenticated pending
    // install. This is what establishes runtime authority below — no legacy
    // `Brand` write exists anymore for it to compete with. Never logged.
    const canonicalCredential =
      payload.shape === "EXPIRING"
        ? {
            authMode: "EXPIRING_OFFLINE" as const,
            accessToken: decryptSecret(payload.encryptedAccessToken),
            accessTokenExpiresAt: new Date(payload.accessTokenExpiresAt),
            refreshToken: decryptSecret(payload.encryptedRefreshToken),
            refreshTokenExpiresAt: new Date(payload.refreshTokenExpiresAt),
          }
        : {
            authMode: "LEGACY_OFFLINE" as const,
            accessToken: decryptSecret(payload.encryptedToken),
            accessTokenExpiresAt: null,
            refreshToken: null,
            refreshTokenExpiresAt: null,
          };

    const brand = await prisma.$transaction(async (tx) => {
      const currentPending = await tx.tokenStore.findUnique({
        where: { service: pendingService },
      });
      const currentPayload = currentPending
        ? parsePendingInstall(currentPending.token)
        : null;
      const now = new Date();

      if (
        !currentPending ||
        !currentPayload ||
        currentPending.expiresAt <= now ||
        currentPayload.shop !== payload.shop
      ) {
        throw new Error("PENDING_INSTALL_UNAVAILABLE");
      }

      // Installation links only to an existing, eligible active Brand — Brand
      // creation is never performed as part of this transaction. Access is
      // re-verified here (not just earlier via resolveBrandAdminContext) so a
      // membership change between the initial check and this transaction
      // can't grant access to a Brand the caller no longer has rights to.
      const destinationBrandId = requestedBrandId;
      const hasDestinationAccess =
        session.user.role === "ADMIN"
          ? Boolean(
              await tx.brand.findUnique({
                where: { id: destinationBrandId, isActive: true },
                select: { id: true },
              }),
            )
          : (
              await tx.brandMember.findMany({
                where: {
                  userId,
                  brandId: destinationBrandId,
                  brand: { isActive: true },
                  role: { in: ["ADMIN", "MANAGER"] },
                },
                select: { id: true },
              })
            ).length > 0;
      if (!hasDestinationAccess) {
        throw new Error("UNAUTHORIZED_BRAND");
      }

      const newShopDomain = normalizeShopDomain(payload.shop) ?? payload.shop;

      // PHASE 14C-A: CANONICAL-ONLY conflict detection — no legacy `Brand`
      // read. Every live Shopify install already has a canonical
      // `CommerceConnection` (operator-verified), so the shop-ownership
      // conflict check must compare against the canonical row, not a Brand
      // mirror that is no longer written on every lifecycle event.
      const owner = await tx.commerceConnection.findFirst({
        where: { provider: "SHOPIFY", externalAccountId: newShopDomain },
        select: {
          id: true,
          brandId: true,
          status: true,
          providerClientId: true,
          providerMetadata: true,
        },
      });

      if (owner && owner.brandId !== destinationBrandId) {
        if (owner.status !== "UNINSTALLED") {
          throw new Error("SHOP_ALREADY_LINKED");
        }

        // The owner brand is losing its Shopify connection to make room for
        // this relink — the row itself is reassigned to the destination
        // brand by the canonical sync upsert below (keyed on
        // externalAccountId, see connection-sync.ts). Deactivate the owner's
        // offers and record the loss just like any other disconnect, even
        // though it was already UNINSTALLED.
        await recordShopifyConnectionLoss(tx, {
          brandId: owner.brandId,
          eventType: "DISCONNECTED",
          snapshot: {
            shopDomain: newShopDomain,
            currencyCode: extractCurrencyCodeFromProviderMetadata(owner.providerMetadata),
            shopifyClientId: owner.providerClientId,
          },
        });
      }

      // `name`/`slug` are read for the connection's cosmetic display name and
      // the response payload only — neither contributes to credential or
      // status authority. `findUniqueOrThrow` matches the prior behavior of
      // throwing (caught by the generic 500 below) if the brand vanished
      // between the access check above and here.
      const destination = await tx.brand.findUniqueOrThrow({
        where: { id: destinationBrandId },
        select: { name: true, slug: true },
      });

      // PHASE 14C-A: the destination brand's PREVIOUS Shopify state (if any)
      // is read from its OWN canonical connection, not `Brand`.
      const destinationConnection = await tx.commerceConnection.findFirst({
        where: { brandId: destinationBrandId, provider: "SHOPIFY" },
        orderBy: [{ isPrimary: "desc" }, { installedAt: "desc" }, { createdAt: "desc" }],
        select: { externalAccountId: true, providerMetadata: true },
      });

      let previousShopDomain = normalizeShopDomain(
        destinationConnection?.externalAccountId ?? null,
      );
      if (!previousShopDomain) {
        previousShopDomain = await resolveLastKnownShopDomain(
          tx,
          destinationBrandId,
        );
      }

      const connectionEventType = resolveInstallConnectionEventType(
        previousShopDomain,
        newShopDomain,
      );
      const finalShopifyClientId =
        payload.shape === "EXPIRING" ? payload.clientId : null;

      // ---------------------------------------------------------------------
      // PHASE 14C-A — CANONICAL CREDENTIAL IS THE ONLY WRITE.
      // ---------------------------------------------------------------------
      // The canonical `CommerceConnection` + `CommerceConnectionSecret` are
      // written from the AUTHENTICATED PENDING-INSTALL PAYLOAD, inside this
      // same Serializable transaction. No circular derivation (nothing here
      // re-reads `Brand.shopify*` to build this write), and no window: if
      // this write fails, the install fails, which is correct — an install
      // that cannot establish a canonical credential has not connected
      // anything. `Brand.shopify*` is not written anywhere in this handler.
      await applyShopifyConnectionSyncFromInstall(tx, destinationBrandId, {
        shopDomain: newShopDomain,
        brandDisplayName: destination.name,
        providerClientId: finalShopifyClientId,
        authMode: canonicalCredential.authMode,
        currencyCode: shopifyCurrencyCode,
        grantedScopes:
          payload.shape === "EXPIRING" ? payload.grantedScopes : null,
        installedAt: now,
        lastProductSyncAt: null,
        accessToken: canonicalCredential.accessToken,
        accessTokenExpiresAt: canonicalCredential.accessTokenExpiresAt,
        refreshToken: canonicalCredential.refreshToken,
        refreshTokenExpiresAt: canonicalCredential.refreshTokenExpiresAt,
      });

      // Reward offers stay inactive through every install/reconnect/relink —
      // a Brand Admin must always explicitly review and reactivate them.
      await recordShopifyConnectionInstall(tx, {
        brandId: destinationBrandId,
        eventType: connectionEventType,
        shopDomain: newShopDomain,
        previousShopDomain,
        currencyCode: shopifyCurrencyCode,
        previousCurrencyCode: extractCurrencyCodeFromProviderMetadata(
          destinationConnection?.providerMetadata ?? null,
        ),
        shopifyClientId: finalShopifyClientId,
      });

      try {
        await tx.tokenStore.delete({ where: { service: pendingService } });
      } catch {
        throw new Error("PENDING_INSTALL_UNAVAILABLE");
      }

      return { id: destinationBrandId, name: destination.name, slug: destination.slug };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    // Sanitized state-transition log — no tokens, no encrypted values.
    console.log("[shopify/installations]", {
      transition: "LINKED",
      authMode: payload.shape === "EXPIRING" ? "EXPIRING_OFFLINE" : "LEGACY_OFFLINE",
      shop: payload.shop,
    });

    // Webhook subscriptions are declared via shopify.app.toml config and managed
    // by Shopify — no runtime registration call is needed here.

    const response = NextResponse.json({
      data: {
        brand,
        redirectTo: "/dashboard/brand/shopify?connected=1",
      },
    });
    response.cookies.set(ACTIVE_BRAND_COOKIE, brand.id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
    return response;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === "UNAUTHORIZED_BRAND") {
        return NextResponse.json({ error: "You are not authorized for this brand." }, { status: 403 });
      }
      if (error.message === "SHOP_ALREADY_LINKED") {
        return NextResponse.json({ error: "This Shopify store is already linked to another brand." }, { status: 409 });
      }
      if (error.message === "PENDING_INSTALL_UNAVAILABLE") {
        return NextResponse.json({ error: "Shopify install session expired or already used." }, { status: 409 });
      }
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2034") {
        return NextResponse.json(
          { error: "Shopify install changed or was already claimed." },
          { status: 409 },
        );
      }
      if (error.code === "P2002") {
        return NextResponse.json(
          { error: "This Shopify store or brand is already linked." },
          { status: 409 },
        );
      }
    }
    console.error("[shopify/installations/[installId]][POST] Error", {
      outcome: "link_failed",
    });
    return NextResponse.json(
      { error: "Failed to link Shopify install." },
      { status: 500 },
    );
  }
}
