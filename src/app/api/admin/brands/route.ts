import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";

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
        shopifyShopDomain: true,
        shopifyInstalledAt: true,
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

    return NextResponse.json({ data: brands });
  } catch (error) {
    console.error("[admin/brands][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load brands." },
      { status: 500 },
    );
  }
}
