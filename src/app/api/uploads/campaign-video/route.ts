import { NextRequest, NextResponse } from "next/server";
import { getBrandAdminContext, slugifyValue } from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import {
  getMaxVideoUploadBytes,
  uploadFileToStorage,
} from "@/lib/storage-upload";

const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/mpeg",
  "video/x-m4v",
]);

function buildCampaignVideoPath(options: {
  brandSlug: string;
  campaignSlug: string;
  fileName: string;
}) {
  const cleanFileName = options.fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
  const cleanBrandSlug = slugifyValue(options.brandSlug) || "brand";
  const cleanCampaignSlug = slugifyValue(options.campaignSlug) || "campaign";

  return `brands/${cleanBrandSlug}/campaigns/${cleanCampaignSlug}/why/${Date.now()}-${cleanFileName}`;
}

export async function POST(request: NextRequest) {
  try {
    const brand = await getBrandAdminContext();

    if (!brand?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const campaignId = String(formData.get("campaignId") || "").trim();
    const campaignSlug = slugifyValue(String(formData.get("campaignSlug") || "").trim());

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "A video file is required." },
        { status: 400 },
      );
    }

    if (!ALLOWED_VIDEO_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: "Only MP4, MOV, WEBM, and M4V videos are allowed." },
        { status: 400 },
      );
    }

    if (file.size > getMaxVideoUploadBytes()) {
      return NextResponse.json(
        { error: "File is too large." },
        { status: 400 },
      );
    }

    if (!campaignSlug) {
      return NextResponse.json(
        { error: "campaignSlug is required." },
        { status: 400 },
      );
    }

    if (campaignId) {
      const campaign = await prisma.campaign.findFirst({
        where: {
          id: campaignId,
          brandId: brand.membership.brand.id,
        },
        select: { id: true },
      });

      if (!campaign) {
        return NextResponse.json(
          { error: "Campaign not found." },
          { status: 404 },
        );
      }
    }

    const bucket =
      process.env.SUPABASE_CAMPAIGN_VIDEO_BUCKET || "campaign-videos";
    const path = buildCampaignVideoPath({
      brandSlug: brand.membership.brand.slug,
      campaignSlug,
      fileName: file.name,
    });
    const uploaded = await uploadFileToStorage({
      bucket,
      path,
      file,
      upsert: true,
    });

    return NextResponse.json({
      data: {
        bucket: uploaded.bucket,
        path: uploaded.path,
        fileUrl: uploaded.fileUrl,
      },
    });
  } catch (error) {
    console.error("[uploads/campaign-video][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to upload campaign video." },
      { status: 500 },
    );
  }
}
