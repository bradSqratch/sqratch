import { NextRequest, NextResponse } from "next/server";
import {
  getCreatorContext,
  getOwnedExperienceForCreator,
  slugifyValue,
} from "@/lib/creator-auth";
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

function buildCoverImagePath(experienceId: string, experienceSlug: string, file: File) {
  const slug = slugifyValue(experienceSlug) || "experience-cover";
  const extension = MIME_TYPE_TO_EXTENSION[file.type] || "bin";

  return `experiences/${experienceId}/cover/${slug}-${Date.now()}.${extension}`;
}

export async function POST(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");
    const experienceId = String(formData.get("experienceId") || "").trim();

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "An image file is required." },
        { status: 400 },
      );
    }

    if (!experienceId) {
      return NextResponse.json(
        { error: "experienceId is required." },
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

    const experience = await getOwnedExperienceForCreator(
      experienceId,
      creator.userId,
    );

    if (!experience) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const bucket =
      process.env.SUPABASE_EXPERIENCE_COVER_BUCKET || "experience-covers";
    const path = buildCoverImagePath(experience.id, experience.slug, file);
    const uploaded = await uploadFileToStorage({
      bucket,
      path,
      file,
      cacheControl: "3600",
      upsert: false,
    });

    return NextResponse.json({
      data: {
        bucket: uploaded.bucket,
        path: uploaded.path,
        fileUrl: uploaded.fileUrl,
        experienceId: experience.id,
      },
    });
  } catch (error) {
    console.error("[uploads/experience-cover][POST] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to upload image." },
      { status: 500 },
    );
  }
}
