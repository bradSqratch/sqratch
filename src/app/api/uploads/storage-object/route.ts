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

/**
 * Returns the brand-asset bucket name (mirrors brand-asset/route.ts convention).
 */
function getBrandAssetBucket() {
  return process.env.SUPABASE_BRAND_ASSET_BUCKET || "brand-assets";
}

/**
 * Returns the experience-cover bucket name (mirrors experience-cover/route.ts convention).
 */
function getExperienceCoverBucket() {
  return process.env.SUPABASE_EXPERIENCE_COVER_BUCKET || "experience-covers";
}

/**
 * Returns the experience-video bucket name (mirrors experience-video/route.ts convention).
 */
function getExperienceVideoBucket() {
  return (
    process.env.SUPABASE_EXPERIENCE_VIDEO_BUCKET ||
    process.env.SUPABASE_CAMPAIGN_VIDEO_BUCKET ||
    "campaign-videos"
  );
}

/**
 * Returns the user-avatar bucket name (mirrors user-avatar/route.ts convention).
 */
function getUserAvatarBucket() {
  return process.env.SUPABASE_USER_AVATAR_BUCKET || "user-avatars";
}

/**
 * Validates that a parsed storage path is owned by the given brand.
 * Brand-asset paths: brands/{brandId}/...
 */
function isBrandOwnedPath(parsedBucket: string, parsedPath: string, brandId: string): boolean {
  if (parsedBucket === getBrandAssetBucket()) {
    // brands/{brandId}/...
    const parts = parsedPath.split("/");
    return parts.length >= 2 && parts[0] === "brands" && parts[1] === brandId;
  }
  return false;
}

/**
 * Validates that a parsed storage path is owned by the given creator (userId).
 * - Experience covers:  experiences/{experienceId}/cover/... — verified via DB ownership
 * - Experience videos:  experiences/{experienceSlug}/why/... — verified via DB ownership
 * - User avatar:        users/{userId}/avatar/...
 * - Lesson videos:      handled separately in the CREATOR + isLessonVideoRequest branch
 *
 * Returns a promise resolving to true if ownership is confirmed.
 */
async function isCreatorOwnedPath(
  parsedBucket: string,
  parsedPath: string,
  userId: string,
): Promise<boolean> {
  const parts = parsedPath.split("/");

  // User avatar: users/{userId}/avatar/...
  if (parsedBucket === getUserAvatarBucket()) {
    return parts.length >= 3 && parts[0] === "users" && parts[1] === userId && parts[2] === "avatar";
  }

  // Experience cover: experiences/{experienceId}/cover/...
  if (parsedBucket === getExperienceCoverBucket()) {
    if (parts.length >= 3 && parts[0] === "experiences" && parts[2] === "cover") {
      const experienceId = parts[1];
      const owned = await prisma.experience.findFirst({
        where: { id: experienceId, creator: { userId } },
        select: { id: true },
      });
      return Boolean(owned);
    }
    return false;
  }

  // Experience video (why): experiences/{experienceSlug}/why/...
  if (parsedBucket === getExperienceVideoBucket()) {
    if (parts.length >= 3 && parts[0] === "experiences" && parts[2] === "why") {
      const experienceSlug = parts[1];
      const owned = await prisma.experience.findFirst({
        where: { slug: experienceSlug, creator: { userId } },
        select: { id: true },
      });
      return Boolean(owned);
    }
    return false;
  }

  return false;
}

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

    // ADMIN may delete any object broadly.
    if (role === "ADMIN") {
      const deleted = await deleteStorageObjectByUrl(url);
      return NextResponse.json({ data: { deleted } });
    }

    // BRAND_ADMIN: only delete objects under their own brand's path.
    if (role === "BRAND_ADMIN") {
      const membership = await prisma.brandMember.findFirst({
        where: {
          userId: session.user.id,
          role: { in: ["ADMIN", "MANAGER"] },
        },
        select: { brand: { select: { id: true } } },
      });

      if (!membership?.brand) {
        return NextResponse.json(
          { error: "Brand membership not found." },
          { status: 403 },
        );
      }

      const parsedUrl = parsePublicStorageUrl(url);
      if (
        !parsedUrl ||
        !isBrandOwnedPath(parsedUrl.bucket, parsedUrl.path, membership.brand.id)
      ) {
        return NextResponse.json(
          { error: "You do not have permission to delete this storage object." },
          { status: 403 },
        );
      }

      const deleted = await deleteStorageObjectByUrl(url);
      return NextResponse.json({ data: { deleted } });
    }

    // CREATOR: only delete objects under their own experience/avatar paths
    // (non-lesson-video paths — lesson video path is handled above).
    if (role === "CREATOR") {
      const parsedUrl = parsePublicStorageUrl(url);
      if (!parsedUrl) {
        return NextResponse.json(
          { error: "Invalid storage object URL." },
          { status: 400 },
        );
      }

      const owned = await isCreatorOwnedPath(parsedUrl.bucket, parsedUrl.path, session.user.id);
      if (!owned) {
        return NextResponse.json(
          { error: "You do not have permission to delete this storage object." },
          { status: 403 },
        );
      }

      const deleted = await deleteStorageObjectByUrl(url);
      return NextResponse.json({ data: { deleted } });
    }

    // Fallback (should not be reached given the role check above).
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  } catch (error) {
    console.error("[uploads/storage-object][DELETE] Error:", error);
    return NextResponse.json(
      { error: "Failed to delete storage object." },
      { status: 500 },
    );
  }
}
