import { NextRequest, NextResponse } from "next/server";
import { getCreatorContext } from "@/lib/creator-auth";
import prisma from "@/lib/prisma";
import {
  deleteFileFromStorage,
  storageObjectExists,
  validateLessonVideoStorageObject,
  validateLessonVideoStorageUrl,
} from "@/lib/storage-upload";
import { createSignedLessonVideoUrl } from "@/lib/lesson-video-playback";
import {
  resolveLessonVideoStorageReference,
  type LessonVideoStorageReference,
} from "@/lib/lesson-video-reference";
import { parseRewardPoints } from "@/lib/reward-points-input";
import { isProductLinkCurrent } from "@/lib/product-link-compatibility";

function normalizeVideoSource(value: unknown) {
  const normalized = String(value || "YOUTUBE")
    .trim()
    .toUpperCase();

  return normalized === "UPLOAD" ? "UPLOAD" : "YOUTUBE";
}

async function validateNewLessonVideoAsset(options: {
  videoAssetUrl: string;
  videoStorageBucket: string;
  videoStoragePath: string;
  courseId: string;
  experienceSlug: string;
}) {
  const parsed =
    options.videoStorageBucket || options.videoStoragePath
      ? validateLessonVideoStorageObject({
          bucket: options.videoStorageBucket,
          path: options.videoStoragePath,
          courseId: options.courseId,
          experienceSlug: options.experienceSlug,
        })
      : validateLessonVideoStorageUrl({
          url: options.videoAssetUrl,
          courseId: options.courseId,
          experienceSlug: options.experienceSlug,
        });

  if (!parsed) {
    return {
      ok: false as const,
      error: "The uploaded lesson video is not valid for this course.",
    };
  }

  const exists = await storageObjectExists(parsed);

  if (!exists) {
    return {
      ok: false as const,
      error: "The uploaded lesson video could not be found.",
    };
  }

  return { ok: true as const, reference: parsed };
}

async function cleanupLessonVideo(
  reference: LessonVideoStorageReference | null,
  context: string,
) {
  if (!reference) {
    return;
  }

  const deleted = await deleteFileFromStorage(
    reference.bucket,
    reference.path,
  );

  if (!deleted) {
    console.error(
      `[creator/lessons][${context}] Failed to delete lesson video object.`,
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const courseId = request.nextUrl.searchParams.get("courseId");

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
        title: true,
        access: true,
        experience: {
          select: {
            id: true,
            title: true,
            slug: true,
          },
        },
      },
    });

    if (!course) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }

    const lessons = await prisma.lesson.findMany({
      where: {
        courseId: course.id,
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        description: true,
        sortOrder: true,
        completionPointsReward: true,
        videoSource: true,
        youtubeUrl: true,
        videoUploadUrl: true,
        videoStorageBucket: true,
        videoStoragePath: true,
        productLinks: {
          orderBy: {
            createdAt: "desc",
          },
          select: {
            id: true,
            lessonId: true,
            productUrl: true,
            title: true,
            imageUrl: true,
            priceText: true,
            currency: true,
            brandId: true,
            sourceShopDomain: true,
            createdAt: true,
          },
        },
      },
    });

    // Stale/incompatible product links are never hidden from creator
    // management — they're annotated so the creator can see they need
    // relinking rather than silently treating them as current.
    const campaignBrandLinks = await prisma.campaignExperience.findMany({
      where: { experienceId: course.experience.id },
      select: {
        campaign: {
          select: { brand: { select: { id: true, shopifyShopDomain: true } } },
        },
      },
    });
    const domainByBrandId = new Map<string, string | null>();
    campaignBrandLinks.forEach((item) => {
      const brand = item.campaign.brand;
      if (brand) {
        domainByBrandId.set(brand.id, brand.shopifyShopDomain);
      }
    });

    const lessonData = await Promise.all(
      lessons.map(async (lesson) => {
        const reference = resolveLessonVideoStorageReference({
          lesson,
          courseId: course.id,
          experienceSlug: course.experience.slug,
        });

        return {
          id: lesson.id,
          title: lesson.title,
          description: lesson.description,
          sortOrder: lesson.sortOrder,
          completionPointsReward: lesson.completionPointsReward,
          videoSource: lesson.videoSource,
          youtubeUrl: lesson.youtubeUrl,
          videoAssetUrl:
            lesson.videoSource === "UPLOAD" && reference
              ? await createSignedLessonVideoUrl(reference)
              : null,
          videoStorageBucket: reference?.bucket || null,
          videoStoragePath: reference?.path || null,
          productLinks: lesson.productLinks.map((link) => ({
            ...link,
            needsRelinking: !isProductLinkCurrent(link, domainByBrandId),
          })),
        };
      }),
    );

    return NextResponse.json(
      {
        data: {
          course,
          lessons: lessonData,
        },
      },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    );
  } catch (error) {
    console.error("[creator/lessons][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load lessons." },
      { status: 500 },
    );
  }
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

    const body = await request.json();
    const courseId = String(body?.courseId || "").trim();
    const title = String(body?.title || "").trim();
    const description = String(body?.description || "").trim();
    const sortOrder = Number(body?.sortOrder || 0);
    const videoSource = normalizeVideoSource(body?.videoSource);
    const youtubeUrl = String(body?.youtubeUrl || "").trim();
    const videoAssetUrl = String(body?.videoAssetUrl || "").trim();
    const videoStorageBucket = String(
      body?.videoStorageBucket || "",
    ).trim();
    const videoStoragePath = String(body?.videoStoragePath || "").trim();
    const reward = parseRewardPoints(
      body?.completionPointsReward,
      "Lesson completion points",
    );

    if (!courseId || !title) {
      return NextResponse.json(
        { error: "courseId and title are required." },
        { status: 400 },
      );
    }

    if (!reward.ok) {
      return NextResponse.json({ error: reward.error }, { status: 400 });
    }

    if (videoSource === "YOUTUBE" && !youtubeUrl) {
      return NextResponse.json(
        { error: "youtubeUrl is required for YouTube lessons." },
        { status: 400 },
      );
    }

    if (
      videoSource === "UPLOAD" &&
      !videoAssetUrl &&
      !videoStorageBucket &&
      !videoStoragePath
    ) {
      return NextResponse.json(
        { error: "videoAssetUrl is required for uploaded lessons." },
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

    let videoReference: LessonVideoStorageReference | null = null;

    if (videoSource === "UPLOAD") {
      const validation = await validateNewLessonVideoAsset({
        videoAssetUrl,
        videoStorageBucket,
        videoStoragePath,
        courseId: course.id,
        experienceSlug: course.experience.slug,
      });

      if (!validation.ok) {
        return NextResponse.json(
          { error: validation.error },
          { status: 400 },
        );
      }

      videoReference = validation.reference;
    }

    const lesson = await prisma.lesson.create({
      data: {
        courseId: course.id,
        title,
        description: description || null,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
        completionPointsReward: reward.value,
        videoSource,
        youtubeUrl: videoSource === "YOUTUBE" ? youtubeUrl : null,
        videoUploadUrl: null,
        videoStorageBucket: videoReference?.bucket || null,
        videoStoragePath: videoReference?.path || null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        sortOrder: true,
        completionPointsReward: true,
        videoSource: true,
        youtubeUrl: true,
        videoUploadUrl: true,
        videoStorageBucket: true,
        videoStoragePath: true,
      },
    });

    return NextResponse.json(
      {
        data: {
          ...lesson,
          videoAssetUrl: null,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[creator/lessons][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create lesson." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const body = await request.json();
    const id = String(body?.id || "").trim();
    const title = String(body?.title || "").trim();
    const description = String(body?.description || "").trim();
    const sortOrder = Number(body?.sortOrder || 0);
    const videoSource = normalizeVideoSource(body?.videoSource);
    const youtubeUrl = String(body?.youtubeUrl || "").trim();
    const videoAssetUrl = String(body?.videoAssetUrl || "").trim();
    const videoStorageBucket = String(
      body?.videoStorageBucket || "",
    ).trim();
    const videoStoragePath = String(body?.videoStoragePath || "").trim();
    const reward = parseRewardPoints(
      body?.completionPointsReward,
      "Lesson completion points",
    );

    if (!id || !title) {
      return NextResponse.json(
        { error: "Lesson id and title are required." },
        { status: 400 },
      );
    }

    if (!reward.ok) {
      return NextResponse.json({ error: reward.error }, { status: 400 });
    }

    if (videoSource === "YOUTUBE" && !youtubeUrl) {
      return NextResponse.json(
        { error: "youtubeUrl is required for YouTube lessons." },
        { status: 400 },
      );
    }

    if (
      videoSource === "UPLOAD" &&
      !videoAssetUrl &&
      !videoStorageBucket &&
      !videoStoragePath
    ) {
      return NextResponse.json(
        { error: "videoAssetUrl is required for uploaded lessons." },
        { status: 400 },
      );
    }

    const existing = await prisma.lesson.findFirst({
      where: {
        id,
        course: {
          experience: {
            creator: {
              userId: creator.userId,
            },
          },
        },
      },
      select: {
        id: true,
        courseId: true,
        videoUploadUrl: true,
        videoStorageBucket: true,
        videoStoragePath: true,
        course: {
          select: {
            experience: {
              select: {
                slug: true,
              },
            },
          },
        },
      },
    });

    if (!existing) {
      return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
    }

    const oldReference = resolveLessonVideoStorageReference({
      lesson: existing,
      courseId: existing.courseId,
      experienceSlug: existing.course.experience.slug,
    });
    let videoReference: LessonVideoStorageReference | null = null;

    if (videoSource === "UPLOAD") {
      const validation = await validateNewLessonVideoAsset({
        videoAssetUrl,
        videoStorageBucket,
        videoStoragePath,
        courseId: existing.courseId,
        experienceSlug: existing.course.experience.slug,
      });

      if (!validation.ok) {
        return NextResponse.json(
          { error: validation.error },
          { status: 400 },
        );
      }

      videoReference = validation.reference;
    }

    const lesson = await prisma.lesson.update({
      where: { id: existing.id },
      data: {
        title,
        description: description || null,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
        completionPointsReward: reward.value,
        videoSource,
        youtubeUrl: videoSource === "YOUTUBE" ? youtubeUrl : null,
        videoUploadUrl: null,
        videoStorageBucket: videoReference?.bucket || null,
        videoStoragePath: videoReference?.path || null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        sortOrder: true,
        completionPointsReward: true,
        videoSource: true,
        youtubeUrl: true,
        videoUploadUrl: true,
        videoStorageBucket: true,
        videoStoragePath: true,
      },
    });

    const storageObjectChanged =
      oldReference &&
      (!videoReference ||
        oldReference.bucket !== videoReference.bucket ||
        oldReference.path !== videoReference.path);

    if (storageObjectChanged) {
      await cleanupLessonVideo(oldReference, "PATCH");
    }

    return NextResponse.json({
      data: {
        ...lesson,
        videoAssetUrl: null,
      },
    });
  } catch (error) {
    console.error("[creator/lessons][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update lesson." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const body = await request.json();
    const id = String(body?.id || "").trim();

    if (!id) {
      return NextResponse.json(
        { error: "Lesson id is required." },
        { status: 400 },
      );
    }

    const lesson = await prisma.lesson.findFirst({
      where: {
        id,
        course: {
          experience: {
            creator: {
              userId: creator.userId,
            },
          },
        },
      },
      select: {
        id: true,
        videoUploadUrl: true,
        videoStorageBucket: true,
        videoStoragePath: true,
        courseId: true,
        course: {
          select: {
            experience: {
              select: {
                slug: true,
              },
            },
          },
        },
      },
    });

    if (!lesson) {
      return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
    }

    const videoReference = resolveLessonVideoStorageReference({
      lesson,
      courseId: lesson.courseId,
      experienceSlug: lesson.course.experience.slug,
    });

    await prisma.lesson.delete({ where: { id: lesson.id } });

    await cleanupLessonVideo(videoReference, "DELETE");

    return NextResponse.json({ data: { id: lesson.id } });
  } catch (error) {
    console.error("[creator/lessons][DELETE] Error:", error);
    return NextResponse.json(
      { error: "Failed to delete lesson." },
      { status: 500 },
    );
  }
}
