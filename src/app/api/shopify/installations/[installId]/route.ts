import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  buildShopifyPendingInstallService,
  getShopifyShopCurrency,
} from "@/lib/shopify";
import { slugifyValue } from "@/lib/brand-auth";
import {
  parsePendingInstall,
  type PendingInstallPayload,
} from "@/lib/pending-install";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";
import { ACTIVE_BRAND_COOKIE } from "@/lib/brand-context";


// Re-export types for backward compatibility if needed elsewhere
export type { PendingInstallPayload };

async function getAuthorizedBrandMemberships(userId: string) {
  return prisma.brandMember.findMany({
    where: {
      userId,
      brand: { isActive: true },
      role: {
        in: ["ADMIN", "MANAGER"],
      },
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      role: true,
      brand: {
        select: {
          id: true,
          name: true,
          slug: true,
          shopifyShopDomain: true,
          shopifyConnectionStatus: true,
        },
      },
    },
  });
}

async function getAllBrandsForGlobalAdmin() {
  return prisma.brand.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      slug: true,
      shopifyShopDomain: true,
      shopifyConnectionStatus: true,
    },
  });
}

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
    const userId = session?.user?.id;

    if (!userId) {
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

    const memberships =
      session.user.role === "ADMIN"
        ? (await getAllBrandsForGlobalAdmin()).map((brand) => ({
            id: brand.id,
            role: "ADMIN" as const,
            brand,
          }))
        : await getAuthorizedBrandMemberships(userId);
    const canCreateBrand =
      session.user.role === "BRAND_ADMIN" || session.user.role === "ADMIN";

    if (memberships.length === 0 && !canCreateBrand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    return NextResponse.json({
      data: {
        shop: payload.shop,
        canCreateBrand,
        brands: memberships.map((membership) => membership.brand),
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
    const createBrand = body?.createBrand || null;
    const canCreateBrand =
      session.user.role === "BRAND_ADMIN" || session.user.role === "ADMIN";

    const name = String(createBrand?.name || "").trim();
    const slug = slugifyValue(String(createBrand?.slug || "").trim() || name);
    const websiteUrl = String(createBrand?.websiteUrl || "").trim();

    if (!requestedBrandId && (!canCreateBrand || !name || !slug)) {
      return NextResponse.json(
        { error: canCreateBrand ? "Brand name and slug are required." : "Select an authorized brand." },
        { status: canCreateBrand ? 400 : 403 },
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

    // ---------------------------------------------------------------------------
    // Build the brand update data object branched by token shape.
    // ---------------------------------------------------------------------------
  const sharedBrandData = {
    shopifyShopDomain: payload.shop,
    shopifyInstalledAt: new Date(),
    shopifyDisconnectedAt: null,
    shopifyUninstalledAt: null,
    shopifyConnectionStatus: "CONNECTED" as const,
    shopifyCurrencyCode,
    shopifyClientId: null,
    shopifyTokenRefreshLockedUntil: null,
    shopifyTokenRefreshLockId: null,
  };

    const tokenBrandData =
      payload.shape === "EXPIRING"
        ? {
            shopifyAdminAccessTokenEncrypted: payload.encryptedAccessToken,
            shopifyAccessTokenExpiresAt: new Date(payload.accessTokenExpiresAt),
            shopifyRefreshTokenEncrypted: payload.encryptedRefreshToken,
            shopifyRefreshTokenExpiresAt: new Date(payload.refreshTokenExpiresAt),
            shopifyGrantedScopes: payload.grantedScopes,
            shopifyClientId: payload.clientId,
            shopifyAuthMode: "EXPIRING_OFFLINE" as const,
          }
        : {
            shopifyAdminAccessTokenEncrypted: payload.encryptedToken,
            shopifyRefreshTokenEncrypted: null,
            shopifyAccessTokenExpiresAt: null,
            shopifyRefreshTokenExpiresAt: null,
            shopifyGrantedScopes: null,
            shopifyAuthMode: "LEGACY_OFFLINE" as const,
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

      let destinationBrandId = requestedBrandId;
      if (destinationBrandId) {
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
      } else {
        const created = await tx.brand.create({
          data: {
            name,
            slug,
            websiteUrl: websiteUrl || null,
          },
          select: { id: true },
        });
        await tx.brandMember.create({
          data: { brandId: created.id, userId, role: "ADMIN" },
        });
        destinationBrandId = created.id;
      }

      const owner = await tx.brand.findFirst({
        where: { shopifyShopDomain: currentPayload.shop },
        select: { id: true, shopifyConnectionStatus: true },
      });

      if (owner && owner.id !== destinationBrandId) {
        if (owner.shopifyConnectionStatus !== "UNINSTALLED") {
          throw new Error("SHOP_ALREADY_LINKED");
        }
        await tx.brand.update({
          where: { id: owner.id },
          data: {
            shopifyShopDomain: null,
            shopifyAdminAccessTokenEncrypted: null,
            shopifyRefreshTokenEncrypted: null,
            shopifyAccessTokenExpiresAt: null,
            shopifyRefreshTokenExpiresAt: null,
            shopifyGrantedScopes: null,
            shopifyClientId: null,
            shopifyTokenRefreshLockedUntil: null,
            shopifyTokenRefreshLockId: null,
            shopifyDisconnectedAt: now,
            shopifyUninstalledAt: null,
            shopifyConnectionStatus: "DISCONNECTED",
          },
        });
      }

      const updated = await tx.brand.update({
        where: { id: destinationBrandId },
        data: {
          ...sharedBrandData,
          ...tokenBrandData,
        },
        select: { id: true, name: true, slug: true },
      });

      try {
        await tx.tokenStore.delete({ where: { service: pendingService } });
      } catch {
        throw new Error("PENDING_INSTALL_UNAVAILABLE");
      }

      return updated;
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
