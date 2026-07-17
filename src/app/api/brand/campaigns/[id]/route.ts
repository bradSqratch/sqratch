import { NextRequest, NextResponse } from "next/server";
import {
  getBrandAdminContext,
  getBrandContextFailure,
  getOwnedBrandCampaign,
  slugifyValue,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const brand = await getBrandAdminContext();

    if (!brand?.membership?.brand) {
      const failure = getBrandContextFailure(brand);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    const { id } = await context.params;
    const campaign = await getOwnedBrandCampaign(id, brand.membership.brand.id);

    if (!campaign) {
      return NextResponse.json(
        { error: "Campaign not found." },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: campaign });
  } catch (error) {
    console.error("[brand/campaigns/[id]][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load campaign." },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const brand = await getBrandAdminContext();

    if (!brand?.membership?.brand) {
      const failure = getBrandContextFailure(brand);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    const { id } = await context.params;
    const existing = await getOwnedBrandCampaign(id, brand.membership.brand.id);

    if (!existing) {
      return NextResponse.json(
        { error: "Campaign not found." },
        { status: 404 },
      );
    }

    const body = await request.json();
    const name = String(body?.name || "").trim();
    const slug = slugifyValue(String(body?.slug || "").trim() || name || existing.slug);
    const description = String(body?.description || "").trim();
    const isActive = Boolean(body?.isActive);

    if (!name || !slug) {
      return NextResponse.json(
        { error: "Campaign name and slug are required." },
        { status: 400 },
      );
    }

    const conflicting = await prisma.campaign.findFirst({
      where: {
        id: {
          not: existing.id,
        },
        OR: [{ name }, { slug }],
      },
      select: { id: true },
    });

    if (conflicting) {
      return NextResponse.json(
        { error: "Campaign name or slug is already in use." },
        { status: 409 },
      );
    }

    const campaign = await prisma.campaign.update({
      where: { id: existing.id },
      data: {
        name,
        slug,
        description: description || null,
        isActive,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        isActive: true,
      },
    });

    return NextResponse.json({ data: campaign });
  } catch (error) {
    console.error("[brand/campaigns/[id]][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update campaign." },
      { status: 500 },
    );
  }
}
