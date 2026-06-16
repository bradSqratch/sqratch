import { NextRequest, NextResponse } from "next/server";
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


// Re-export types for backward compatibility if needed elsewhere
export type { PendingInstallPayload };

async function getAuthorizedBrandMemberships(userId: string) {
  return prisma.brandMember.findMany({
    where: {
      userId,
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

    const memberships = await getAuthorizedBrandMemberships(userId);
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
  } catch (error) {
    console.error("[shopify/installations/[installId]][GET] Error:", error);
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

    const body = await request.json().catch(() => null);
    const requestedBrandId = String(body?.brandId || "").trim();
    const createBrand = body?.createBrand || null;
    const memberships = await getAuthorizedBrandMemberships(userId);
    const canCreateBrand =
      session.user.role === "BRAND_ADMIN" || session.user.role === "ADMIN";

    if (memberships.length === 0 && !canCreateBrand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const existingShopBrand = await prisma.brand.findFirst({
      where: {
        shopifyShopDomain: payload.shop,
        ...(requestedBrandId ? { id: { not: requestedBrandId } } : {}),
      },
      select: { id: true, shopifyConnectionStatus: true },
    });

    if (existingShopBrand) {
      if (existingShopBrand.shopifyConnectionStatus === "UNINSTALLED") {
        // Relink policy: if the existing brand holding the domain is UNINSTALLED,
        // release it (null its domain and clear its Shopify credential/token fields)
        // so the new brand can claim the domain. The release + new-link happen in
        // a single transaction so the @unique constraint is never violated.
        await prisma.$transaction(async (tx) => {
          await tx.brand.update({
            where: { id: existingShopBrand.id },
            data: {
              shopifyShopDomain: null,
              shopifyAdminAccessTokenEncrypted: null,
              shopifyRefreshTokenEncrypted: null,
              shopifyAccessTokenExpiresAt: null,
              shopifyRefreshTokenExpiresAt: null,
              shopifyGrantedScopes: null,
            },
          });
          // The domain is now free; the main brand.update below (outside this
          // tx) will claim it. We commit early here so the slot is released.
        });
      } else {
        // Brand is CONNECTED (or some other non-UNINSTALLED status) — conflict.
        return NextResponse.json(
          { error: "This Shopify store is already linked to another brand." },
          { status: 409 },
        );
      }
    }

    let brandId = requestedBrandId;

    if (brandId) {
      const allowed = memberships.some(
        (membership) => membership.brand.id === brandId,
      );

      if (!allowed) {
        return NextResponse.json(
          { error: "You are not authorized for this brand." },
          { status: 403 },
        );
      }
    } else {
      if (!canCreateBrand) {
        return NextResponse.json(
          { error: "Select an authorized brand." },
          { status: 400 },
        );
      }

      const name = String(createBrand?.name || "").trim();
      const slug = slugifyValue(String(createBrand?.slug || "").trim() || name);
      const websiteUrl = String(createBrand?.websiteUrl || "").trim();

      if (!name || !slug) {
        return NextResponse.json(
          { error: "Brand name and slug are required." },
          { status: 400 },
        );
      }

      const conflicting = await prisma.brand.findFirst({
        where: {
          OR: [{ name }, { slug }],
        },
        select: { id: true },
      });

      if (conflicting) {
        return NextResponse.json(
          { error: "Brand name or slug is already in use." },
          { status: 409 },
        );
      }

      const created = await prisma.$transaction(async (tx) => {
        const brand = await tx.brand.create({
          data: {
            name,
            slug,
            websiteUrl: websiteUrl || null,
          },
          select: { id: true },
        });

        await tx.brandMember.create({
          data: {
            brandId: brand.id,
            userId,
            role: "ADMIN",
          },
        });

        return brand;
      });

      brandId = created.id;
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
    } catch (err) {
      console.error("[shopify/installations/[installId]] Error querying currency:", err);
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
            shopifyAuthMode: "LEGACY_OFFLINE" as const,
          };

    const brand = await prisma.$transaction(async (tx) => {
      const updated = await tx.brand.update({
        where: { id: brandId },
        data: {
          ...sharedBrandData,
          ...tokenBrandData,
        },
        select: {
          id: true,
          name: true,
          slug: true,
        },
      });

      await tx.tokenStore.delete({
        where: {
          service: pendingInstall.service,
        },
      });

      return updated;
    });

    // Sanitized state-transition log — no tokens, no encrypted values.
    console.log("[shopify/installations]", {
      transition: "LINKED",
      authMode: payload.shape === "EXPIRING" ? "EXPIRING_OFFLINE" : "LEGACY_OFFLINE",
      shop: payload.shop,
    });

    // Webhook subscriptions are declared via shopify.app.toml config and managed
    // by Shopify — no runtime registration call is needed here.

    return NextResponse.json({
      data: {
        brand,
        redirectTo: "/dashboard/brand/shopify?connected=1",
      },
    });
  } catch (error) {
    console.error("[shopify/installations/[installId]][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to link Shopify install." },
      { status: 500 },
    );
  }
}
