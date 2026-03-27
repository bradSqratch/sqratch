import { NextRequest, NextResponse } from "next/server";
import {
  createAnalyticsEvent,
  getExperienceAccessContext,
} from "@/lib/experience-access";
import prisma from "@/lib/prisma";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
) {
  try {
    const { experienceSlug } = await context.params;
    const access = await getExperienceAccessContext(experienceSlug, request);

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
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
      campaignsWithVideo[0] || access.experience.campaigns[0];

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

    const primaryCampaignVideo = primaryCampaign?.campaign
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

    const featuredStory = primaryCampaignVideo &&
      ((primaryCampaignVideo.videoSource === "YOUTUBE" &&
        primaryCampaignVideo.youtubeUrl) ||
        (primaryCampaignVideo.videoSource === "UPLOAD" &&
          primaryCampaignVideo.videoAssetUrl))
      ? primaryCampaignVideo
      :
      playableLessons.find((lesson) => lesson.sortOrder === 3) ||
      playableLessons[0] ||
      null;

    const [publicCourseCount, privateCourseCount, postsCount, questionsCount] =
      await Promise.all([
        prisma.course.count({
          where: {
            experienceId: access.experience.id,
            isActive: true,
            access: "PUBLIC",
          },
        }),
        prisma.course.count({
          where: {
            experienceId: access.experience.id,
            isActive: true,
            access: "PRIVATE",
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

    const sessionId =
      access.viewer.sessionId ||
      (await ensureViewerSession({
        request,
        userId: access.viewer.userId,
        campaignId: primaryCampaign?.campaignId || null,
      }));

    await createAnalyticsEvent({
      request,
      name: "experience_view",
      brandId: primaryCampaign?.campaign.brand?.id || null,
      campaignId: primaryCampaign?.campaignId || null,
      experienceId: access.experience.id,
      userId: access.viewer.userId,
      sessionId,
      pagePath: `/x/${access.experience.slug}`,
      data: {
        canAccessPrivate: access.canAccessPrivate,
        canInteract: access.canInteract,
        visibleCourseCount: courses.length,
      },
    });

    const response = NextResponse.json({
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
          visibleLessonCount: courses.reduce(
            (total, course) => total + course.lessons.length,
            0,
          ),
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
    });

    attachSessionCookie(response, sessionId);
    return response;
  } catch (error) {
    console.error("[public/experience/[experienceSlug]] Error:", error);
    return NextResponse.json(
      { error: "Failed to load experience." },
      { status: 500 },
    );
  }
}
