import { NextRequest, NextResponse } from "next/server";
import { getBrandAdminContext, slugifyValue } from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import {
  createSignedUploadUrl,
  getMaxVideoUploadBytes,
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

    const body = await request.json().catch(() => null);
    const fileName = String(body?.fileName || "").trim();
    const fileType = String(body?.fileType || "").trim();
    const fileSize = Number(body?.fileSize || 0);
    const campaignId = String(body?.campaignId || "").trim();
    const campaignSlug = slugifyValue(
      String(body?.campaignSlug || "").trim(),
    );

    if (!fileName) {
      return NextResponse.json(
        { error: "A video file name is required." },
        { status: 400 },
      );
    }

    if (!ALLOWED_VIDEO_TYPES.has(fileType)) {
      return NextResponse.json(
        { error: "Only MP4, MOV, WEBM, and M4V videos are allowed." },
        { status: 400 },
      );
    }

    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      return NextResponse.json(
        { error: "A valid video file size is required." },
        { status: 400 },
      );
    }

    if (fileSize > getMaxVideoUploadBytes()) {
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
      fileName,
    });
    const signedUpload = await createSignedUploadUrl({
      bucket,
      path,
      upsert: true,
    });

    return NextResponse.json({
      data: {
        bucket: signedUpload.bucket,
        path: signedUpload.path,
        fileUrl: signedUpload.fileUrl,
        signedUrl: signedUpload.signedUrl,
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
