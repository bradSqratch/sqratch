import { NextRequest, NextResponse } from "next/server";
import {
  getCreatorContext,
  getOwnedExperienceForCreator,
  slugifyValue,
} from "@/lib/creator-auth";
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

function buildExperienceVideoPath(options: {
  experienceSlug: string;
  fileName: string;
}) {
  const cleanFileName = options.fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
  const cleanExperienceSlug =
    slugifyValue(options.experienceSlug) || "experience";

  return `experiences/${cleanExperienceSlug}/why/${Date.now()}-${cleanFileName}`;
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

    const body = await request.json().catch(() => null);
    const fileName = String(body?.fileName || "").trim();
    const fileType = String(body?.fileType || "").trim();
    const fileSize = Number(body?.fileSize || 0);
    const experienceId = String(body?.experienceId || "").trim();
    const experienceSlug = slugifyValue(
      String(body?.experienceSlug || "").trim(),
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

    if (!experienceSlug) {
      return NextResponse.json(
        { error: "experienceSlug is required." },
        { status: 400 },
      );
    }

    // experienceId is required — ownership must always be verified before
    // issuing a signed URL. Allowing a slug-only path with no DB ownership
    // check would let any creator upload under an arbitrary experience slug.
    if (!experienceId) {
      return NextResponse.json(
        { error: "experienceId is required." },
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
      process.env.SUPABASE_EXPERIENCE_VIDEO_BUCKET ||
      process.env.SUPABASE_CAMPAIGN_VIDEO_BUCKET ||
      "campaign-videos";
    const signedUpload = await createSignedUploadUrl({
      bucket,
      path: buildExperienceVideoPath({
        experienceSlug,
        fileName,
      }),
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
    console.error("[uploads/experience-video][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to upload experience video." },
      { status: 500 },
    );
  }
}
