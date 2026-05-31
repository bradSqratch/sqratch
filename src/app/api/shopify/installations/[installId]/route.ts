import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { decryptSecret } from "@/lib/crypto";
import prisma from "@/lib/prisma";
import {
  buildShopifyPendingInstallService,
  registerShopifyWebhooks,
} from "@/lib/shopify";
import { slugifyValue } from "@/lib/brand-auth";

type PendingInstallPayload = {
  shop: string;
  encryptedToken: string;
};

function parsePendingInstall(token: string): PendingInstallPayload | null {
  try {
    const payload = JSON.parse(token) as PendingInstallPayload;

    if (!payload.shop || !payload.encryptedToken) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

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
  _request: NextRequest,
  context: { params: Promise<{ installId: string }> },
) {
  try {
    const session = await getServerSession(authOptions);
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
  try {
    const session = await getServerSession(authOptions);
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
      select: { id: true },
    });

    if (existingShopBrand) {
      return NextResponse.json(
        { error: "This Shopify store is already linked to another brand." },
        { status: 409 },
      );
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

    const brand = await prisma.$transaction(async (tx) => {
      const updated = await tx.brand.update({
        where: { id: brandId },
        data: {
          shopifyShopDomain: payload.shop,
          shopifyAdminAccessTokenEncrypted: payload.encryptedToken,
          shopifyInstalledAt: new Date(),
          shopifyDisconnectedAt: null,
          shopifyUninstalledAt: null,
          shopifyConnectionStatus: "CONNECTED",
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

    await registerShopifyWebhooks({
      shop: payload.shop,
      accessToken: decryptSecret(payload.encryptedToken),
      origin: request.nextUrl.origin,
    });

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
