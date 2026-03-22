import { NextRequest, NextResponse } from "next/server";
import { createUniqueSlug, getAdminContext } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const context = await getAdminContext();

    if (!context) {
      return NextResponse.json({ error: "Admins only." }, { status: 403 });
    }

    const { id } = await params;
    const body = await request.json().catch(() => null);
    const name = String(body?.name || "").trim();
    const providedSlug = String(body?.slug || "").trim();
    const description = String(body?.description || "").trim() || null;
    const brandId = String(body?.brandId || "").trim();
    const isActive =
      typeof body?.isActive === "boolean" ? body.isActive : undefined;

    if (!name || !brandId || isActive === undefined) {
      return NextResponse.json(
        { error: "Name, brand, and active state are required." },
        { status: 400 },
      );
    }

    const existingCampaign = await prisma.campaign.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!existingCampaign) {
      return NextResponse.json(
        { error: "Campaign not found." },
        { status: 404 },
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
      where: {
        id: { not: id },
        name,
      },
      select: { id: true },
    });

    if (existingName) {
      return NextResponse.json(
        { error: "Campaign name is already in use." },
        { status: 409 },
      );
    }

    const slug = await createUniqueSlug(
      providedSlug || name,
      async (candidate) =>
        Boolean(
          await prisma.campaign.findFirst({
            where: {
              id: { not: id },
              slug: candidate,
            },
            select: { id: true },
          }),
        ),
      "campaign",
    );

    const campaign = await prisma.campaign.update({
      where: { id },
      data: {
        name,
        slug,
        description,
        brandId,
        isActive,
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

    return NextResponse.json({ data: campaign });
  } catch (error) {
    console.error("[admin/campaigns/:id][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update campaign." },
      { status: 500 },
    );
  }
}
