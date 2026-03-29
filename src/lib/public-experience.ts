import type { NextRequest } from "next/server";
import type { PublicExperienceData } from "@/components/experience/types";
import {
  getExperienceAccessContext,
  type ExperienceAccessContext,
} from "@/lib/experience-access";
import prisma from "@/lib/prisma";

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
        },
      },
    },
  });

  const campaignsWithVideo = access.experience.campaigns.filter(
    (item) =>
      (item.campaign.whyVideoSource === "YOUTUBE" &&
        item.campaign.whyYoutubeUrl) ||
      (item.campaign.whyVideoSource === "UPLOAD" &&
        item.campaign.whyVideoUploadUrl),
  );

  const primaryCampaign =
    campaignsWithVideo[0] || access.experience.campaigns[0] || null;

  const orderedCampaigns = primaryCampaign
    ? [
        primaryCampaign,
        ...access.experience.campaigns.filter(
          (item) => item.campaignId !== primaryCampaign.campaignId,
        ),
      ]
    : access.experience.campaigns;

  const playableLessons = courses
    .flatMap((course) =>
      course.lessons.map((lesson) => ({
        id: `lesson:${lesson.id}`,
        lessonId: lesson.id,
        kind: "LESSON" as const,
        title: lesson.title,
        sortOrder: lesson.sortOrder,
        courseTitle: course.title,
        videoSource: lesson.videoSource,
        youtubeUrl: lesson.youtubeUrl,
        videoAssetUrl: lesson.videoUploadUrl,
      })),
    )
    .filter(
      (lesson) =>
        (lesson.videoSource === "YOUTUBE" && lesson.youtubeUrl) ||
        (lesson.videoSource === "UPLOAD" && lesson.videoAssetUrl),
    );

  const primaryCampaignVideo = primaryCampaign?.campaign &&
    ((primaryCampaign.campaign.whyVideoSource === "YOUTUBE" &&
      primaryCampaign.campaign.whyYoutubeUrl) ||
      (primaryCampaign.campaign.whyVideoSource === "UPLOAD" &&
        primaryCampaign.campaign.whyVideoUploadUrl))
    ? {
        id: `campaign:${primaryCampaign.campaign.id}`,
        lessonId: null,
        kind: "CAMPAIGN" as const,
        title: primaryCampaign.campaign.name,
        courseTitle: null,
        videoSource: primaryCampaign.campaign.whyVideoSource,
        youtubeUrl: primaryCampaign.campaign.whyYoutubeUrl,
        videoAssetUrl: primaryCampaign.campaign.whyVideoUploadUrl,
      }
    : null;

  const featuredStory = primaryCampaignVideo
    ? primaryCampaignVideo
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
    primaryCampaignId: primaryCampaign?.campaignId || null,
    primaryBrandId: primaryCampaign?.campaign.brand?.id || null,
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
      canAccessPrivate: access.canAccessPrivate,
      canInteract: access.canInteract,
    },
  };
}
