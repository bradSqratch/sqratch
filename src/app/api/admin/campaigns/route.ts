import { NextRequest, NextResponse } from "next/server";
import { createUniqueSlug, getAdminContext } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";

export async function GET() {
  try {
    const context = await getAdminContext();

    if (!context) {
      return NextResponse.json({ error: "Admins only." }, { status: 403 });
    }

    const [campaigns, brands] = await Promise.all([
      prisma.campaign.findMany({
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          brand: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
          _count: {
            select: {
              qrBatches: true,
              experiences: true,
              unlocks: true,
            },
          },
        },
      }),
      prisma.brand.findMany({
        orderBy: [{ name: "asc" }],
        select: {
          id: true,
          name: true,
          slug: true,
        },
      }),
    ]);

    return NextResponse.json({
      data: {
        campaigns: campaigns.map((campaign) => ({
          ...campaign,
          counts: {
            qrBatches: campaign._count.qrBatches,
            experiences: campaign._count.experiences,
            unlocks: campaign._count.unlocks,
          },
        })),
        brands,
      },
    });
  } catch (error) {
    console.error("[admin/campaigns][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load campaigns." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await getAdminContext();

    if (!context) {
      return NextResponse.json({ error: "Admins only." }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const name = String(body?.name || "").trim();
    const description = String(body?.description || "").trim() || null;
    const isActive = Boolean(body?.isActive);
    const brandId = String(body?.brandId || "").trim();

    if (!name || !brandId) {
      return NextResponse.json(
        { error: "Campaign name and brand are required." },
        { status: 400 },
      );
    }

    const brand = await prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true },
    });

    if (!brand) {
      return NextResponse.json({ error: "Brand not found." }, { status: 404 });
    }

    const existingName = await prisma.campaign.findFirst({
      where: { name },
      select: { id: true },
    });

    if (existingName) {
      return NextResponse.json(
        { error: "Campaign name is already in use." },
        { status: 409 },
      );
    }

    const slug = await createUniqueSlug(
      String(body?.slug || "").trim() || name,
      async (candidate) =>
        Boolean(
          await prisma.campaign.findFirst({
            where: { slug: candidate },
            select: { id: true },
          }),
        ),
      "campaign",
    );

    const campaign = await prisma.campaign.create({
      data: {
        name,
        slug,
        description,
        isActive,
        brandId,
        createdById: context.userId,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        isActive: true,
        brand: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

    return NextResponse.json({ data: campaign }, { status: 201 });
  } catch (error) {
    console.error("[admin/campaigns][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create campaign." },
      { status: 500 },
    );
  }
}
