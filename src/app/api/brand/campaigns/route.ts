import { NextRequest, NextResponse } from "next/server";
import { getBrandAdminContext, slugifyValue } from "@/lib/brand-auth";
import prisma from "@/lib/prisma";

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

export async function GET() {
  try {
    const context = await getBrandAdminContext();

    if (!context?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const campaigns = await prisma.campaign.findMany({
      where: {
        brandId: context.membership.brand.id,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            qrBatches: true,
            experiences: true,
          },
        },
      },
    });

    return NextResponse.json({
      data: campaigns.map((campaign) => ({
        id: campaign.id,
        name: campaign.name,
        slug: campaign.slug,
        description: campaign.description,
        isActive: campaign.isActive,
        createdAt: campaign.createdAt,
        updatedAt: campaign.updatedAt,
        qrBatchesCount: campaign._count.qrBatches,
        experiencesCount: campaign._count.experiences,
      })),
    });
  } catch (error) {
    console.error("[brand/campaigns][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load campaigns." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await getBrandAdminContext();

    if (!context?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const body = await request.json();
    const name = String(body?.name || "").trim();
    const slug = slugifyValue(String(body?.slug || "").trim() || name);
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

    if (!whyVideoSource) {
      return NextResponse.json(
        { error: "Campaign video source is required." },
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

    const existing = await prisma.campaign.findFirst({
      where: {
        OR: [{ name }, { slug }],
      },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json(
        { error: "Campaign name or slug is already in use." },
        { status: 409 },
      );
    }

    const campaign = await prisma.campaign.create({
      data: {
        name,
        slug,
        description: description || null,
        isActive,
        whyVideoSource,
        whyYoutubeUrl: whyVideoSource === "YOUTUBE" ? whyYoutubeUrl : null,
        whyVideoUploadUrl:
          whyVideoSource === "UPLOAD" ? whyVideoAssetUrl : null,
        brandId: context.membership.brand.id,
        createdById: context.userId,
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

    return NextResponse.json({ data: campaign }, { status: 201 });
  } catch (error) {
    console.error("[brand/campaigns][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create campaign." },
      { status: 500 },
    );
  }
}
