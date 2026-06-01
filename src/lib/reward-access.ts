import type { NextRequest } from "next/server";
import { getExperienceAccessContext } from "@/lib/experience-access";
import prisma from "@/lib/prisma";

export async function getUnlockedRewardBrandIds(userId: string) {
  const unlocks = await prisma.campaignUnlock.findMany({
    where: {
      userId,
      campaign: {
        brandId: {
          not: null,
        },
      },
    },
    select: {
      campaign: {
        select: {
          brandId: true,
        },
      },
    },
  });

  return Array.from(
    new Set(
      unlocks
        .map((unlock) => unlock.campaign.brandId)
        .filter((brandId): brandId is string => Boolean(brandId)),
    ),
  );
}

export async function getRewardClaimContext(options: {
  request?: NextRequest;
  userId: string;
  experienceSlug?: string | null;
  campaignId?: string | null;
}) {
  if (options.experienceSlug) {
    const access = await getExperienceAccessContext(
      options.experienceSlug,
      options.request,
    );

    if (!access) {
      return {
        ok: false as const,
        status: 404,
        error: "Experience not found.",
      };
    }

    if (access.viewer.userId !== options.userId || !access.canAccessPrivate) {
      return {
        ok: false as const,
        status: 403,
        error: "Unlock this experience before claiming rewards.",
      };
    }

    const brandIds = access.experience.campaigns
      .map((item) => item.campaign.brand?.id)
      .filter((brandId): brandId is string => Boolean(brandId));

    if (brandIds.length === 0) {
      return {
        ok: false as const,
        status: 404,
        error: "No reward brand is linked to this experience.",
      };
    }

    return {
      ok: true as const,
      brandIds: Array.from(new Set(brandIds)),
      campaignIds: access.campaignIds,
    };
  }

  if (options.campaignId) {
    const campaign = await prisma.campaign.findUnique({
      where: {
        id: options.campaignId,
      },
      select: {
        id: true,
        brandId: true,
        unlocks: {
          where: {
            userId: options.userId,
          },
          select: {
            id: true,
          },
          take: 1,
        },
      },
    });

    if (!campaign) {
      return {
        ok: false as const,
        status: 404,
        error: "Campaign not found.",
      };
    }

    if (!campaign.unlocks.length) {
      return {
        ok: false as const,
        status: 403,
        error: "Unlock this experience before claiming rewards.",
      };
    }

    if (!campaign.brandId) {
      return {
        ok: false as const,
        status: 404,
        error: "No reward brand is linked to this campaign.",
      };
    }

    return {
      ok: true as const,
      brandIds: [campaign.brandId],
      campaignIds: [campaign.id],
    };
  }

  // Dashboard rewards are intentionally limited to Brands the user has
  // unlocked through at least one campaign, so /dashboard/points cannot bypass
  // the same Brand relationship required by contextual experience rewards.
  return {
    ok: true as const,
    brandIds: await getUnlockedRewardBrandIds(options.userId),
    campaignIds: [],
  };
}
