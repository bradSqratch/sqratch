import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getLessonVideoBucket,
  validateVideoUploadMetadata,
} from "@/lib/storage-upload";

type CreatorIdentity = {
  userId: string;
};

type SignedUploadResult = {
  bucket: string;
  path: string;
  signedUrl: string;
};

type UploadRouteDependencies = {
  getCreator: () => Promise<CreatorIdentity | null>;
  findOwnedCourse: (
    courseId: string,
    userId: string,
  ) => Promise<{
    id: string;
    experience: { slug: string };
  } | null>;
  signUpload: (input: {
    bucket: string;
    path: string;
    upsert: boolean;
  }) => Promise<SignedUploadResult>;
};

function buildVideoPath(options: {
  experienceSlug: string;
  courseId: string;
  fileName: string;
}) {
  const cleanFileName =
    options.fileName
      .replace(/[^a-zA-Z0-9._-]/g, "-")
      .replace(/^-+/, "") || "video";
  const cleanExperienceSlug =
    options.experienceSlug
      .replace(/[^a-zA-Z0-9-]/g, "-")
      .toLowerCase() || "experience";

  return `experiences/${cleanExperienceSlug}/courses/${options.courseId}/lessons/${crypto.randomUUID()}-${cleanFileName}`;
}

export function createLessonVideoUploadHandler(
  dependencies: UploadRouteDependencies,
) {
  return async function POST(request: NextRequest) {
    try {
      const creator = await dependencies.getCreator();

      if (!creator) {
        return NextResponse.json(
          { error: "Creator access required." },
          { status: 403 },
        );
      }

      const body = await request.json().catch(() => null);
      const courseId = String(body?.courseId || "").trim();
      const fileName = String(body?.fileName || "").trim();
      const fileType = String(body?.fileType || "").trim().toLowerCase();
      const fileSize = Number(body?.fileSize);

      if (!courseId) {
        return NextResponse.json(
          { error: "courseId is required." },
          { status: 400 },
        );
      }

      const metadataError = validateVideoUploadMetadata({
        fileName,
        fileType,
        fileSize,
      });

      if (metadataError) {
        return NextResponse.json({ error: metadataError }, { status: 400 });
      }

      const course = await dependencies.findOwnedCourse(
        courseId,
        creator.userId,
      );

      if (!course) {
        return NextResponse.json(
          { error: "Course not found." },
          { status: 404 },
        );
      }

      const signedUpload = await dependencies.signUpload({
        bucket: getLessonVideoBucket(),
        path: buildVideoPath({
          experienceSlug: course.experience.slug,
          courseId: course.id,
          fileName,
        }),
        upsert: false,
      });

      return NextResponse.json({
        data: {
          bucket: signedUpload.bucket,
          path: signedUpload.path,
          signedUrl: signedUpload.signedUrl,
        },
      });
    } catch (error) {
      console.error("[uploads/video][POST] Error:", error);
      return NextResponse.json(
        { error: "Failed to prepare video upload." },
        { status: 500 },
      );
    }
  };
}
