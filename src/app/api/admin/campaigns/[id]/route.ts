import { NextRequest, NextResponse } from "next/server";
import { createUniqueSlug, getAdminContext } from "@/lib/admin-auth";
import {
  buildCampaignMetadataUpdate,
  CAMPAIGN_BRAND_IMMUTABLE,
  isCampaignBrandMutationAllowed,
} from "@/lib/campaign-ownership";
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
    const providedBrandId =
      typeof body?.brandId === "string" ? body.brandId.trim() : null;
    const isActive =
      typeof body?.isActive === "boolean" ? body.isActive : undefined;

    if (!name || isActive === undefined) {
      return NextResponse.json(
        { error: "Name and active state are required." },
        { status: 400 },
      );
    }

    const existingCampaign = await prisma.campaign.findUnique({
      where: { id },
      select: { id: true, brandId: true },
    });

    if (!existingCampaign) {
      return NextResponse.json(
        { error: "Campaign not found." },
        { status: 404 },
      );
    }

    // Older clients may echo the current owner. That remains compatible, but
    // ownership is never included in update data. Any distinct value is a
    // deliberate reassignment attempt and fails before Prisma/the DB trigger.
    if (!isCampaignBrandMutationAllowed(existingCampaign.brandId, providedBrandId)) {
      return NextResponse.json(
        {
          error: "Campaign brand ownership is immutable.",
          code: CAMPAIGN_BRAND_IMMUTABLE,
        },
        { status: 409 },
      );
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
      data: buildCampaignMetadataUpdate({
        name,
        slug,
        description,
        isActive,
      }),
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
