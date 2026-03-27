import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import type { NextRequest } from "next/server";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { getSessionIdFromRequest } from "@/lib/session";

type ExperienceAccessBase = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  coverImageUrl: string | null;
  qaDailyQuestionLimit: number;
  creator: {
    id: string;
    userId: string;
    displayName: string | null;
    bio: string | null;
    avatarUrl: string | null;
    user: {
      name: string | null;
    };
  };
  campaigns: Array<{
    campaignId: string;
    campaign: {
      id: string;
      name: string;
      whyVideoSource: "YOUTUBE" | "UPLOAD" | null;
      whyYoutubeUrl: string | null;
      whyVideoUploadUrl: string | null;
      brand: {
        id: string;
        name: string;
        slug: string;
        logoUrl: string | null;
      } | null;
    };
  }>;
};

export type ViewerContext = {
  session: Session | null;
  userId: string | null;
  sessionId: string | null;
};

export type ExperienceAccessContext = {
  viewer: ViewerContext;
  experience: ExperienceAccessBase;
  campaignIds: string[];
  isLoggedIn: boolean;
  isCreatorOwner: boolean;
  hasUnlockedCampaign: boolean;
  canAccessPrivate: boolean;
  canInteract: boolean;
};

export async function getViewerContext(request?: NextRequest): Promise<ViewerContext> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || null;
  const sessionId = await getSessionIdFromRequest(request);

  return {
    session,
    userId,
    sessionId,
  };
}

export async function getExperienceAccessContext(
  experienceSlug: string,
  request?: NextRequest,
) {
  const viewer = await getViewerContext(request);

  const experience = await prisma.experience.findUnique({
    where: { slug: experienceSlug },
    select: {
      id: true,
      slug: true,
      title: true,
      description: true,
      coverImageUrl: true,
      qaDailyQuestionLimit: true,
      creator: {
        select: {
          id: true,
          userId: true,
          displayName: true,
          bio: true,
          avatarUrl: true,
          user: {
            select: {
              name: true,
            },
          },
        },
      },
      campaigns: {
        orderBy: {
          sortOrder: "asc",
        },
        select: {
          campaignId: true,
          campaign: {
            select: {
              id: true,
              name: true,
              whyVideoSource: true,
              whyYoutubeUrl: true,
              whyVideoUploadUrl: true,
              brand: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                  logoUrl: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!experience) {
    return null;
  }

  const campaignIds = experience.campaigns.map((item) => item.campaignId);
  const isLoggedIn = Boolean(viewer.userId);
  const isCreatorOwner = viewer.userId === experience.creator.userId;

  let hasUnlockedCampaign = false;

  if (campaignIds.length > 0) {
    if (viewer.userId) {
      const unlock = await prisma.campaignUnlock.findFirst({
        where: {
          campaignId: {
            in: campaignIds,
          },
          userId: viewer.userId,
        },
        select: { id: true },
      });

      hasUnlockedCampaign = Boolean(unlock);
    } else if (viewer.sessionId) {
      const unlock = await prisma.campaignUnlock.findFirst({
        where: {
          campaignId: {
            in: campaignIds,
          },
          anonKey: viewer.sessionId,
          userId: null,
        },
        select: { id: true },
      });

      hasUnlockedCampaign = Boolean(unlock);
    }
  }

  return {
    viewer,
    experience,
    campaignIds,
    isLoggedIn,
    isCreatorOwner,
    hasUnlockedCampaign,
    canAccessPrivate: isCreatorOwner || (isLoggedIn && hasUnlockedCampaign),
    canInteract: isCreatorOwner || (isLoggedIn && hasUnlockedCampaign),
  } satisfies ExperienceAccessContext;
}

export async function createAnalyticsEvent(options: {
  request: NextRequest;
  name: string;
  brandId?: string | null;
  campaignId?: string | null;
  qrCodeId?: string | null;
  experienceId?: string | null;
  courseId?: string | null;
  lessonId?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  pagePath?: string | null;
  data?: Record<string, unknown>;
}) {
  await prisma.analyticsEvent.create({
    data: {
      name: options.name,
      brandId: options.brandId || undefined,
      campaignId: options.campaignId || undefined,
      qrCodeId: options.qrCodeId || undefined,
      experienceId: options.experienceId || undefined,
      courseId: options.courseId || undefined,
      lessonId: options.lessonId || undefined,
      userId: options.userId || undefined,
      sessionId: options.sessionId || undefined,
      pagePath: options.pagePath || undefined,
      referrer: options.request.headers.get("referer") || undefined,
      userAgent: options.request.headers.get("user-agent") || undefined,
      data: options.data as Prisma.InputJsonValue | undefined,
    },
  });
}
