import { Prisma } from "@prisma/client";
import { getServerSession } from "next-auth";
import type { Session } from "next-auth";
import type { NextRequest } from "next/server";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import {
  resolvePublicExperienceEntryContext,
  resolveValidatedPublicCampaignContext,
  type PublicExperienceEntryContext,
} from "@/lib/campaign-context";
import prisma from "@/lib/prisma";
import {
  getSessionIdFromRequest,
  getViewerSessionRecord,
  hasRedeemedQrWarning,
} from "@/lib/session";

type ExperienceAccessBase = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  coverImageUrl: string | null;
  whyVideoSource: "YOUTUBE" | "UPLOAD" | null;
  whyYoutubeUrl: string | null;
  whyVideoUploadUrl: string | null;
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
  /**
   * The visitor's stored `UserSession.campaignId` — the ONLY trusted public
   * campaign signal. It is cookie-backed (`sqr_session`, httpOnly) and is
   * stamped server-side by `/api/public/scan` and
   * `/api/public/campaign/[slug]`, never by a client-supplied parameter.
   *
   * Surfaced here (rather than re-queried per route) because
   * `getExperienceAccessContext` already loads the session record for the
   * redeemed-QR check; a second `getViewerSessionRecord` call per public route
   * would duplicate that query. It is deliberately RAW: it has not been
   * validated against this Experience yet. Never read it directly — always
   * resolve it through `resolvePublicCampaignId` below.
   */
  storedCampaignId: string | null;
  /**
   * Trusted public entry semantics.  DIRECT is intentionally distinct from
   * an unresolved/missing campaign: it means this Experience was entered
   * without campaign acquisition context and must not invent one from the
   * Experience's linked campaigns.
   */
  entryContext: PublicExperienceEntryContext;
  isLoggedIn: boolean;
  isCreatorOwner: boolean;
  hasUnlockedCampaign: boolean;
  hasRedeemedQrWarning: boolean;
  canAccessPrivate: boolean;
  canInteract: boolean;
};

/**
 * The minimum a caller must project out of one Experience-campaign join row for
 * public campaign-context resolution: the campaign id and the campaign's brand
 * id. Routes hold different campaign row shapes (some select the whole brand,
 * some only `brandId`), so the contract is narrowed to what the rule needs.
 */
export type PublicCampaignContextSource = {
  campaignId: string;
  brandId: string | null;
};

/**
 * The single entry point every PUBLIC surface uses to answer "which campaign is
 * this visitor in on this Experience?".
 *
 * It applies two rules that must never drift apart across routes:
 *
 *  1. Eligibility: malformed source input without a Brand is never a context.
 *    Persisted Campaign ownership is required and immutable (same defensive
 *    rule as `buildEligibleCampaignContexts`).
 *  2. Resolution: `resolveValidatedPublicCampaignContext` — the visitor's
 *    stored campaign only when it is genuinely linked to this Experience;
 *    otherwise `null` for explicit direct/unscoped entry.
 *
 * `null` means direct/unscoped entry. Callers must never replace it with a
 * campaign guess. It is never `campaigns[0]`: `CampaignExperience.sortOrder`
 * is brand-writable, so taking the first row let a co-sponsoring brand elect
 * itself as the primary sponsor of a shared Experience.
 */
export function resolvePublicCampaignId(options: {
  campaigns: PublicCampaignContextSource[];
  storedCampaignId: string | null;
}): string | null {
  return resolveValidatedPublicCampaignContext({
    storedCampaignId: options.storedCampaignId,
    eligibleCampaignIds: options.campaigns
      .filter((campaign) => campaign.brandId !== null)
      .map((campaign) => campaign.campaignId),
  });
}

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
      whyVideoSource: true,
      whyYoutubeUrl: true,
      whyVideoUploadUrl: true,
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
        // `sortOrder` is brand-writable and has no natural uniqueness, so it
        // alone leaves the row order undefined for ties. The `id` tiebreak
        // makes this list stable; consumers must still go through
        // `src/lib/campaign-context.ts` rather than taking `campaigns[0]`.
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        select: {
          campaignId: true,
          campaign: {
            select: {
              id: true,
              name: true,
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
  const viewerSession = await getViewerSessionRecord(request);

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

  const showRedeemedQrWarning =
    !hasUnlockedCampaign &&
    hasRedeemedQrWarning({
      viewerSession,
      currentUserId: viewer.userId,
      allowedCampaignIds: campaignIds,
    });

  const entryContext = resolvePublicExperienceEntryContext({
    storedCampaignId: viewerSession?.campaignId ?? null,
    eligibleCampaignIds: experience.campaigns
      .filter((item) => item.campaign.brand !== null)
      .map((item) => item.campaignId),
  });

  return {
    viewer,
    experience,
    campaignIds,
    storedCampaignId: viewerSession?.campaignId ?? null,
    entryContext,
    isLoggedIn,
    isCreatorOwner,
    hasUnlockedCampaign,
    hasRedeemedQrWarning: showRedeemedQrWarning,
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
