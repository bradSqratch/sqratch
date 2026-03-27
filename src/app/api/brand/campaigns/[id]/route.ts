import { NextRequest, NextResponse } from "next/server";
import { getBrandAdminContext, getOwnedBrandCampaign, slugifyValue } from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { deleteStorageObjectByUrl } from "@/lib/storage-upload";

function normalizeVideoSource(value: unknown) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  if (normalized === "UPLOAD") {
    return "UPLOAD" as const;
  }

  if (normalized === "YOUTUBE") {
    return "YOUTUBE" as const;
  }

  return null;
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const brand = await getBrandAdminContext();

    if (!brand?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
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
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
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
    const whyVideoSource = normalizeVideoSource(body?.whyVideoSource);
    const whyYoutubeUrl = String(body?.whyYoutubeUrl || "").trim();
    const whyVideoAssetUrl = String(body?.whyVideoAssetUrl || "").trim();

    if (!name || !slug) {
      return NextResponse.json(
        { error: "Campaign name and slug are required." },
        { status: 400 },
      );
    }

    if (whyVideoSource === "YOUTUBE" && !whyYoutubeUrl) {
      return NextResponse.json(
        { error: "whyYoutubeUrl is required for YouTube campaign videos." },
        { status: 400 },
      );
    }

    if (whyVideoSource === "UPLOAD" && !whyVideoAssetUrl) {
      return NextResponse.json(
        { error: "whyVideoAssetUrl is required for uploaded campaign videos." },
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
        whyVideoSource,
        whyYoutubeUrl: whyVideoSource === "YOUTUBE" ? whyYoutubeUrl : null,
        whyVideoUploadUrl:
          whyVideoSource === "UPLOAD" ? whyVideoAssetUrl : null,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        isActive: true,
        whyVideoSource: true,
        whyYoutubeUrl: true,
        whyVideoUploadUrl: true,
      },
    });

    if (
      existing.whyVideoUploadUrl &&
      existing.whyVideoUploadUrl !== campaign.whyVideoUploadUrl
    ) {
      await deleteStorageObjectByUrl(existing.whyVideoUploadUrl);
    }

    return NextResponse.json({ data: campaign });
  } catch (error) {
    console.error("[brand/campaigns/[id]][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update campaign." },
      { status: 500 },
    );
  }
}
