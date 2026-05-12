import { NextRequest, NextResponse } from "next/server";
import {
  getCreatorContext,
  getOwnedExperienceForCreator,
  slugifyValue,
} from "@/lib/creator-auth";
import prisma from "@/lib/prisma";
import {
  deleteFileFromStorage,
  deleteStorageObjectByUrl,
  getMaxUploadBytes,
  uploadFileToStorage,
} from "@/lib/storage-upload";

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

function buildCoverImagePath(
  experienceId: string,
  experienceSlug: string,
  file: File,
) {
  const slug = slugifyValue(experienceSlug) || "experience-cover";
  const extension = MIME_TYPE_TO_EXTENSION[file.type] || "bin";

  return `experiences/${experienceId}/cover/${slug}-${Date.now()}.${extension}`;
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const { id } = await context.params;
    const experience = await getOwnedExperienceForCreator(id, creator.userId);

    if (!experience) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "An image file is required." },
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

    try {
      const updated = await prisma.experience.update({
        where: { id: experience.id },
        data: {
          coverImageUrl: uploaded.fileUrl,
        },
        select: {
          id: true,
          coverImageUrl: true,
          updatedAt: true,
        },
      });

      if (
        experience.coverImageUrl &&
        experience.coverImageUrl !== updated.coverImageUrl
      ) {
        await deleteStorageObjectByUrl(experience.coverImageUrl);
      }

      return NextResponse.json({
        data: {
          id: updated.id,
          fileUrl: updated.coverImageUrl,
          updatedAt: updated.updatedAt,
        },
      });
    } catch (dbError) {
      await deleteFileFromStorage(uploaded.bucket, uploaded.path).catch(
        () => false,
      );
      throw dbError;
    }
  } catch (error) {
    console.error("[creator/experiences/[id]/cover][POST] Error:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to update cover image.",
      },
      { status: 500 },
    );
  }
}
