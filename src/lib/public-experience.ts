import type { NextRequest } from "next/server";
import { unstable_noStore as noStore } from "next/cache";
import type { PublicExperienceData } from "@/components/experience/types";
import {
  getExperienceAccessContext,
  resolvePublicCampaignId,
  type ExperienceAccessContext,
} from "@/lib/experience-access";
import prisma from "@/lib/prisma";
import { getAuthorizedLessonVideoUrl } from "@/lib/lesson-video-playback";

type LoadPublicExperienceResult = {
  access: ExperienceAccessContext;
  data: PublicExperienceData;
  primaryCampaignId: string | null;
  primaryBrandId: string | null;
};

export async function loadPublicExperience(
  experienceSlug: string,
  request?: NextRequest,
): Promise<LoadPublicExperienceResult | null> {
  noStore();
  const access = await getExperienceAccessContext(experienceSlug, request);

  if (!access) {
    return null;
  }

  const courses = await prisma.course.findMany({
    where: {
      experienceId: access.experience.id,
      isActive: true,
      ...(access.canAccessPrivate
        ? {}
        : {
            access: "PUBLIC",
          }),
    },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      title: true,
      description: true,
      access: true,
      sortOrder: true,
      lessons: {
        where: { isActive: true },
        orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          title: true,
          sortOrder: true,
          videoSource: true,
          youtubeUrl: true,
          videoUploadUrl: true,
          videoStorageBucket: true,
          videoStoragePath: true,
        },
      },
    },
  });

  // The primary campaign/brand of a co-sponsored Experience is resolved from
  // the visitor's own trusted session context, never from `campaigns[0]`.
  // When it cannot be resolved (two or more eligible sponsors and no trusted
  // signal) it stays null and every downstream consumer stays brand-neutral:
  // `primaryBrandId` is null rather than an arbitrary sponsor's id, and the
  // campaign list keeps its deterministic persisted order instead of promoting
  // a guess to the front.
  const resolvedCampaignId = resolvePublicCampaignId({
    campaigns: access.experience.campaigns.map((item) => ({
      campaignId: item.campaignId,
      brandId: item.campaign.brand?.id ?? null,
    })),
    storedCampaignId: access.storedCampaignId,
  });

  const resolvedCampaign =
    access.experience.campaigns.find(
      (item) => item.campaignId === resolvedCampaignId,
    ) || null;

  const orderedCampaigns = resolvedCampaign
    ? [
        resolvedCampaign,
        ...access.experience.campaigns.filter(
          (item) => item.campaignId !== resolvedCampaign.campaignId,
        ),
      ]
    : access.experience.campaigns;

  const playableLessons = (
    await Promise.all(
      courses.flatMap((course) =>
        course.lessons.map(async (lesson) => ({
          id: `lesson:${lesson.id}`,
          lessonId: lesson.id,
          kind: "LESSON" as const,
          title: lesson.title,
          sortOrder: lesson.sortOrder,
          courseTitle: course.title,
          videoSource: lesson.videoSource,
          youtubeUrl: lesson.youtubeUrl,
          videoAssetUrl: await getAuthorizedLessonVideoUrl({
            canAccess:
              course.access === "PUBLIC" || access.canAccessPrivate,
            videoSource: lesson.videoSource,
            lesson,
            courseId: course.id,
            experienceSlug: access.experience.slug,
          }),
        })),
      ),
    )
  )
    .filter(
      (lesson) =>
        (lesson.videoSource === "YOUTUBE" && lesson.youtubeUrl) ||
        (lesson.videoSource === "UPLOAD" && lesson.videoAssetUrl),
    );

  const experienceWhyVideo =
    (access.experience.whyVideoSource === "YOUTUBE" &&
      access.experience.whyYoutubeUrl) ||
    (access.experience.whyVideoSource === "UPLOAD" &&
      access.experience.whyVideoUploadUrl)
      ? {
          id: `experience:${access.experience.id}:why`,
          lessonId: null,
          kind: "EXPERIENCE" as const,
          title: access.experience.title,
          courseTitle: null,
          videoSource: access.experience.whyVideoSource,
          youtubeUrl: access.experience.whyYoutubeUrl,
          videoAssetUrl: access.experience.whyVideoUploadUrl,
        }
      : null;

  const featuredStory = experienceWhyVideo
    ? experienceWhyVideo
    : playableLessons.find((lesson) => lesson.sortOrder === 3) ||
      playableLessons[0] ||
      null;

  const [courseCounts, postsCount, questionsCount] = await Promise.all([
    prisma.course.groupBy({
      by: ["access"],
      where: {
        experienceId: access.experience.id,
        isActive: true,
      },
      _count: {
        _all: true,
      },
    }),
    prisma.post.count({
      where: {
        experienceId: access.experience.id,
        isActive: true,
      },
    }),
    prisma.question.count({
      where: {
        experienceId: access.experience.id,
      },
    }),
  ]);

  const publicCourseCount =
    courseCounts.find((item) => item.access === "PUBLIC")?._count._all || 0;
  const privateCourseCount =
    courseCounts.find((item) => item.access === "PRIVATE")?._count._all || 0;

  const visibleLessonCount = courses.reduce(
    (total, course) => total + course.lessons.length,
    0,
  );

  return {
    access,
    primaryCampaignId: resolvedCampaign?.campaignId || null,
    primaryBrandId: resolvedCampaign?.campaign.brand?.id || null,
    data: {
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
      campaigns: orderedCampaigns.map((item) => ({
        id: item.campaign.id,
        name: item.campaign.name,
        brand: item.campaign.brand,
      })),
      // Additive: lets the client render the visitor's OWN sponsor rather than
      // re-deriving `campaigns[0]`, and render a neutral placeholder when the
      // context is ambiguous. Only an id already present in `campaigns` above.
      resolvedCampaignId: resolvedCampaign?.campaignId || null,
      featuredStory,
      courses: courses.map((course) => ({
        id: course.id,
        title: course.title,
        description: course.description,
        access: course.access,
        lessonCount: course.lessons.length,
      })),
      courseSummary: {
        visibleCourseCount: courses.length,
        visibleLessonCount,
        publicCourseCount,
        privateCourseCount: access.canAccessPrivate ? privateCourseCount : 0,
      },
      counts: {
        posts: postsCount,
        questions: questionsCount,
      },
      qaDailyQuestionLimit: access.experience.qaDailyQuestionLimit || 1,
      isLoggedIn: access.isLoggedIn,
      hasUnlockedCampaign: access.hasUnlockedCampaign,
      isCreatorOwner: access.isCreatorOwner,
      hasRedeemedQrWarning: access.hasRedeemedQrWarning,
      canAccessPrivate: access.canAccessPrivate,
      canInteract: access.canInteract,
    },
  };
}
