import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import {
  deleteStorageObjectByUrl,
  deleteFileFromStorage,
  getLessonVideoBucket,
  parsePublicStorageUrl,
  validateLessonVideoStorageObject,
  validateLessonVideoStorageUrl,
} from "@/lib/storage-upload";

export async function DELETE(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    const role = session?.user?.role || null;

    if (!session?.user?.id || !role || !["ADMIN", "BRAND_ADMIN", "CREATOR"].includes(role)) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = await request.json().catch(() => null);
    const url = String(body?.url || "").trim();
    const courseId = String(body?.courseId || "").trim();
    const bucket = String(body?.bucket || "").trim();
    const path = String(body?.path || "").trim();

    if (!url && !bucket && !path) {
      return NextResponse.json(
        { error: "Storage object URL is required." },
        { status: 400 },
      );
    }

    const parsed = url ? parsePublicStorageUrl(url) : null;
    const isLessonVideoRequest =
      bucket === getLessonVideoBucket() ||
      parsed?.bucket === getLessonVideoBucket();

    if (role === "CREATOR" && isLessonVideoRequest) {
      if (!courseId) {
        return NextResponse.json(
          { error: "courseId is required for lesson video cleanup." },
          { status: 400 },
        );
      }

      const course = await prisma.course.findFirst({
        where: {
          id: courseId,
          experience: {
            creator: {
              userId: session.user.id,
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

      const lessonVideoReference = course
        ? bucket || path
          ? validateLessonVideoStorageObject({
              bucket,
              path,
              courseId: course.id,
              experienceSlug: course.experience.slug,
            })
          : validateLessonVideoStorageUrl({
              url,
              courseId: course.id,
              experienceSlug: course.experience.slug,
            })
        : null;

      if (!lessonVideoReference) {
        return NextResponse.json(
          { error: "Storage object not found." },
          { status: 404 },
        );
      }

      const deleted = await deleteFileFromStorage(
        lessonVideoReference.bucket,
        lessonVideoReference.path,
      );

      return NextResponse.json({ data: { deleted } });
    }

    if (!url) {
      return NextResponse.json(
        { error: "Storage object URL is required." },
        { status: 400 },
      );
    }

    const deleted = await deleteStorageObjectByUrl(url);

    return NextResponse.json({ data: { deleted } });
  } catch (error) {
    console.error("[uploads/storage-object][DELETE] Error:", error);
    return NextResponse.json(
      { error: "Failed to delete storage object." },
      { status: 500 },
    );
  }
}
