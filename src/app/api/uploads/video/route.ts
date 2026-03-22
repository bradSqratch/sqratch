import { NextRequest, NextResponse } from "next/server";
import { getCreatorContext } from "@/lib/creator-auth";
import prisma from "@/lib/prisma";
import { getMaxVideoUploadBytes, uploadFileToStorage } from "@/lib/storage-upload";

const ALLOWED_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/mpeg",
  "video/x-m4v",
]);

function buildVideoPath(options: {
  experienceSlug: string;
  courseId: string;
  fileName: string;
}) {
  const { experienceSlug, courseId, fileName } = options;
  const cleanFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, "-");
  const cleanExperienceSlug =
    experienceSlug.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase() || "experience";

  return `experiences/${cleanExperienceSlug}/courses/${courseId}/lessons/${Date.now()}-${cleanFileName}`;
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
    const courseId = String(formData.get("courseId") || "").trim();

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

    if (!courseId) {
      return NextResponse.json(
        { error: "courseId is required." },
        { status: 400 },
      );
    }

    const course = await prisma.course.findFirst({
      where: {
        id: courseId,
        experience: {
          creator: {
            userId: creator.userId,
          },
        },
      },
      select: {
        id: true,
        experience: {
          select: {
            slug: true,
          },
        },
      },
    });

    if (!course) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }

    const bucket = process.env.SUPABASE_LESSON_VIDEO_BUCKET || "lesson-videos";
    const path = buildVideoPath({
      experienceSlug: course.experience.slug,
      courseId: course.id,
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
        courseId: course.id,
        uploadedBy: creator.creatorProfile.id,
      },
    });
  } catch (error) {
    console.error("[uploads/video][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to upload video." },
      { status: 500 },
    );
  }
}
