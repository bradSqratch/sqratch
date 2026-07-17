import { NextRequest, NextResponse } from "next/server";
import {
  getBrandAdminContext,
  getBrandContextFailure,
} from "@/lib/brand-auth";
import { getMaxUploadBytes, uploadFileToStorage } from "@/lib/storage-upload";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

const MIME_TYPE_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
};

function buildBrandAssetPath(options: {
  brandId: string;
  brandSlug: string;
  assetType: "logo" | "cover";
  file: File;
}) {
  const { brandId, brandSlug, assetType, file } = options;
  const extension = MIME_TYPE_TO_EXTENSION[file.type] || "bin";
  const cleanSlug =
    brandSlug.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase() || "brand";

  return `brands/${brandId}/${assetType}/${cleanSlug}-${Date.now()}.${extension}`;
}

export async function POST(request: NextRequest) {
  try {
    const brandAdmin = await getBrandAdminContext();

    if (!brandAdmin?.membership) {
      const failure = getBrandContextFailure(brandAdmin);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const assetType = String(formData.get("assetType") || "").trim();

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "An image file is required." },
        { status: 400 },
      );
    }

    if (assetType !== "logo" && assetType !== "cover") {
      return NextResponse.json(
        { error: "assetType must be 'logo' or 'cover'." },
        { status: 400 },
      );
    }

    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: "Only PNG, JPG, JPEG, and WEBP images are allowed." },
        { status: 400 },
      );
    }

    if (file.size > getMaxUploadBytes()) {
      return NextResponse.json(
        { error: "File is too large." },
        { status: 400 },
      );
    }

    const bucket = process.env.SUPABASE_BRAND_ASSET_BUCKET || "brand-assets";
    const path = buildBrandAssetPath({
      brandId: brandAdmin.membership.brand.id,
      brandSlug: brandAdmin.membership.brand.slug,
      assetType: assetType as "logo" | "cover",
      file,
    });

    const uploaded = await uploadFileToStorage({
      bucket,
      path,
      file,
      cacheControl: "3600",
      upsert: true,
    });

    return NextResponse.json({
      data: {
        bucket: uploaded.bucket,
        path: uploaded.path,
        fileUrl: uploaded.fileUrl,
        assetType,
      },
    });
  } catch (error) {
    console.error("[uploads/brand-asset][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to upload brand asset." },
      { status: 500 },
    );
  }
}
