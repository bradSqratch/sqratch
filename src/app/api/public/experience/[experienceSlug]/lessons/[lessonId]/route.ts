import { NextRequest, NextResponse } from "next/server";
import { getExperienceAccessContext } from "@/lib/experience-access";
import prisma from "@/lib/prisma";

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ experienceSlug: string; lessonId: string }>;
  },
) {
  try {
    const { experienceSlug, lessonId } = await context.params;
    const access = await getExperienceAccessContext(experienceSlug, request);

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const lesson = await prisma.lesson.findFirst({
      where: {
        id: lessonId,
        isActive: true,
        course: {
          experienceId: access.experience.id,
          isActive: true,
        },
      },
      select: {
        id: true,
        title: true,
        description: true,
        sortOrder: true,
        videoSource: true,
        youtubeUrl: true,
        videoUploadUrl: true,
        productLinks: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            productUrl: true,
            title: true,
            imageUrl: true,
            priceText: true,
          },
        },
        course: {
          select: {
            id: true,
            title: true,
            access: true,
            lessons: {
              where: { isActive: true },
              orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
              select: {
                id: true,
                title: true,
              },
            },
          },
        },
      },
    });

    if (!lesson) {
      return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
    }

    const canAccess =
      lesson.course.access === "PUBLIC" || access.canAccessPrivate;
    const lessonIndex = lesson.course.lessons.findIndex(
      (item) => item.id === lesson.id,
    );
    const previousLesson =
      lessonIndex > 0 ? lesson.course.lessons[lessonIndex - 1] : null;
    const nextLesson =
      lessonIndex >= 0 && lessonIndex < lesson.course.lessons.length - 1
        ? lesson.course.lessons[lessonIndex + 1]
        : null;

    return NextResponse.json({
      data: {
        experience: {
          id: access.experience.id,
          slug: access.experience.slug,
          title: access.experience.title,
          description: access.experience.description,
          coverImageUrl: access.experience.coverImageUrl,
          creator: {
            id: access.experience.creator.id,
            displayName:
              access.experience.creator.displayName ||
              access.experience.creator.user.name ||
              "Creator",
            bio: access.experience.creator.bio,
            avatarUrl: access.experience.creator.avatarUrl,
          },
          campaigns: access.experience.campaigns.map((item) => ({
            id: item.campaign.id,
            name: item.campaign.name,
            brand: item.campaign.brand,
          })),
          isLoggedIn: access.isLoggedIn,
          hasUnlockedCampaign: access.hasUnlockedCampaign,
          isCreatorOwner: access.isCreatorOwner,
          canAccessPrivate: access.canAccessPrivate,
          canInteract: access.canInteract,
        },
        course: {
          id: lesson.course.id,
          title: lesson.course.title,
          access: lesson.course.access,
        },
        lesson: {
          id: lesson.id,
          title: lesson.title,
          description: lesson.description,
          videoSource: lesson.videoSource,
          youtubeUrl: canAccess ? lesson.youtubeUrl : null,
          videoAssetUrl: canAccess ? lesson.videoUploadUrl : null,
          resources: canAccess ? lesson.productLinks : [],
        },
        previousLesson,
        nextLesson,
        canAccess,
      },
    });
  } catch (error) {
    console.error(
      "[public/experience/[experienceSlug]/lessons/[lessonId]] Error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to load lesson." },
      { status: 500 },
    );
  }
}
