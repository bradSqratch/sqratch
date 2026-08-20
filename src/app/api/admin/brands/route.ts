import { NextResponse } from "next/server";
import { CommerceProvider } from "@prisma/client";
import { getAdminContext } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";
import { getActiveCommerceConnectionsForBrands } from "@/lib/commerce/connection-service";

export async function GET() {
  try {
    const context = await getAdminContext();

    if (!context) {
      return NextResponse.json({ error: "Admins only." }, { status: 403 });
    }

    const brands = await prisma.brand.findMany({
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        name: true,
        slug: true,
        bio: true,
        websiteUrl: true,
        logoUrl: true,
        isActive: true,
        createdAt: true,
        members: {
          orderBy: {
            createdAt: "asc",
          },
          select: {
            id: true,
            role: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                role: true,
                isActive: true,
              },
            },
          },
        },
        campaigns: {
          orderBy: {
            updatedAt: "desc",
          },
          select: {
            id: true,
            name: true,
            slug: true,
            isActive: true,
          },
        },
      },
    });

    // CANONICAL — one batched CommerceConnection query for every brand in
    // this list, never one query per brand (see connection-service.ts).
    const connectionsByBrand = await getActiveCommerceConnectionsForBrands(
      brands.map((brand) => brand.id),
      CommerceProvider.SHOPIFY,
    );

    return NextResponse.json({
      data: brands.map((brand) => ({
        ...brand,
        shopifyShopDomain: connectionsByBrand.get(brand.id)?.externalAccountId ?? null,
      })),
    });
  } catch (error) {
    console.error("[admin/brands][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load brands." },
      { status: 500 },
    );
  }
}
