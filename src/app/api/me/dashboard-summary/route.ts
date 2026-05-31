import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

type Role = "ADMIN" | "BRAND_ADMIN" | "CREATOR" | "USER" | "EXTERNAL";

type RecentActivityItem = {
  label: string;
  detail?: string;
  at?: string;
};

function getStartOfLastDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function toRelativeTime(date: Date) {
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.floor(diffMs / (1000 * 60));

  if (diffMinutes < 1) {
    return "just now";
  }

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

async function getAdminCards() {
  const recentWindow = getStartOfLastDays(7);

  const [creatorPending, brandPending, totalBrands, totalCampaigns, recentScans] =
    await Promise.all([
      prisma.creatorRequest.count({
        where: { status: "PENDING" },
      }),
      prisma.brandRequest.count({
        where: { status: "PENDING" },
      }),
      prisma.brand.count(),
      prisma.campaign.count(),
      prisma.analyticsEvent.count({
        where: {
          name: "qr_scan",
          createdAt: {
            gte: recentWindow,
          },
        },
      }),
    ]);

  return {
    approvalsPending: creatorPending + brandPending,
    totalBrands,
    totalCampaigns,
    recentScans,
  };
}

async function getBrandAdminCards(userId: string) {
  const recentWindow = getStartOfLastDays(7);

  const membership = await prisma.brandMember.findFirst({
    where: {
      userId,
      role: {
        in: ["ADMIN", "MANAGER"],
      },
    },
    select: {
      brand: {
        select: {
          id: true,
          shopifyShopDomain: true,
          shopifyAdminAccessTokenEncrypted: true,
          shopifyConnectionStatus: true,
          shopifyLastProductSyncAt: true,
        },
      },
    },
  });

  const brand = membership?.brand;

  if (!brand) {
    return {
      campaignsCount: 0,
      qrBatchCount: 0,
      productSyncStatus: "DISCONNECTED",
      recentScans: 0,
    };
  }

  const [campaignsCount, qrBatchCount, recentScans] = await Promise.all([
    prisma.campaign.count({
      where: {
        brandId: brand.id,
      },
    }),
    prisma.qRCodeBatch.count({
      where: {
        campaign: {
          brandId: brand.id,
        },
      },
    }),
    prisma.analyticsEvent.count({
      where: {
        name: "qr_scan",
        brandId: brand.id,
        createdAt: {
          gte: recentWindow,
        },
      },
    }),
  ]);

  const hasShopifyConnection = Boolean(
    brand.shopifyShopDomain &&
      brand.shopifyAdminAccessTokenEncrypted &&
      brand.shopifyConnectionStatus === "CONNECTED",
  );
  const syncWindow = getStartOfLastDays(7);
  const productSyncStatus = !hasShopifyConnection
    ? "DISCONNECTED"
    : brand.shopifyLastProductSyncAt &&
        brand.shopifyLastProductSyncAt >= syncWindow
      ? "OK"
      : "NEEDS_ATTENTION";

  return {
    campaignsCount,
    qrBatchCount,
    productSyncStatus,
    recentScans,
  };
}

async function getCreatorCards(userId: string) {
  const creatorProfile = await prisma.creatorProfile.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!creatorProfile) {
    return {
      experiencesCount: 0,
      draftsCount: 0,
      unansweredQACount: 0,
      views: 0,
    };
  }

  const experienceIds = (
    await prisma.experience.findMany({
      where: {
        creatorId: creatorProfile.id,
      },
      select: { id: true },
    })
  ).map((experience) => experience.id);

  const [experiencesCount, draftsCount, unansweredQACount, views] =
    await Promise.all([
      prisma.experience.count({
        where: {
          creatorId: creatorProfile.id,
        },
      }),
      prisma.experience.count({
        where: {
          creatorId: creatorProfile.id,
          isActive: false,
        },
      }),
      prisma.question.count({
        where: {
          experience: {
            creatorId: creatorProfile.id,
          },
          status: "OPEN",
        },
      }),
      experienceIds.length
        ? prisma.analyticsEvent.count({
            where: {
              name: "experience_view",
              experienceId: {
                in: experienceIds,
              },
            },
          })
        : 0,
    ]);

  return {
    experiencesCount,
    draftsCount,
    unansweredQACount,
    views,
  };
}

async function getUserCardsAndActivity(userId: string) {
  const recentWindow = getStartOfLastDays(14);

  const [unlockedCampaignsCount, continueWatchingLessonsCount] =
    await Promise.all([
      prisma.campaignUnlock.count({
        where: {
          userId,
        },
      }),
      prisma.lessonProgress.count({
        where: {
          userId,
          isCompleted: false,
          lastPositionSeconds: {
            gt: 0,
          },
        },
      }),
    ]);

  const [recentUnlocks, recentProgress, recentEvents] = await Promise.all([
    prisma.campaignUnlock.findMany({
      where: {
        userId,
        createdAt: {
          gte: recentWindow,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 5,
      select: {
        createdAt: true,
        campaign: {
          select: {
            name: true,
          },
        },
      },
    }),
    prisma.lessonProgress.findMany({
      where: {
        userId,
        updatedAt: {
          gte: recentWindow,
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 5,
      select: {
        updatedAt: true,
        isCompleted: true,
        lesson: {
          select: {
            title: true,
          },
        },
      },
    }),
    prisma.analyticsEvent.findMany({
      where: {
        userId,
        createdAt: {
          gte: recentWindow,
        },
        name: {
          in: ["shop_click", "lesson_started", "lesson_completed"],
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 5,
      select: {
        name: true,
        createdAt: true,
        experience: {
          select: {
            title: true,
          },
        },
      },
    }),
  ]);

  const unlockItems: Array<RecentActivityItem & { ts: Date }> = recentUnlocks.map(
    (unlock) => ({
      label: "Unlocked campaign",
      detail: unlock.campaign.name,
      at: toRelativeTime(unlock.createdAt),
      ts: unlock.createdAt,
    }),
  );

  const progressItems: Array<RecentActivityItem & { ts: Date }> = recentProgress.map(
    (progress) => ({
      label: progress.isCompleted ? "Completed lesson" : "Watched lesson",
      detail: progress.lesson.title,
      at: toRelativeTime(progress.updatedAt),
      ts: progress.updatedAt,
    }),
  );

  const eventItems: Array<RecentActivityItem & { ts: Date }> = recentEvents.map(
    (event) => {
      const label =
        event.name === "shop_click"
          ? "Opened shop product"
          : event.name === "lesson_completed"
            ? "Completed lesson"
            : "Started lesson";

      return {
        label,
        detail: event.experience?.title || undefined,
        at: toRelativeTime(event.createdAt),
        ts: event.createdAt,
      };
    },
  );

  const recentActivity = [...progressItems, ...unlockItems, ...eventItems]
    .sort((a, b) => b.ts.getTime() - a.ts.getTime())
    .slice(0, 6)
    .map((item) => ({
      label: item.label,
      detail: item.detail,
      at: item.at,
    }));

  return {
    cards: {
      unlockedCampaignsCount,
      continueWatchingLessonsCount,
      recentActivityCount: recentActivity.length,
    },
    recentActivity,
  };
}

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = (session.user.role || "USER") as Role;
  const userId = session.user.id || null;

  const base = {
    role,
    user: {
      name: session.user.name ?? null,
      email: session.user.email ?? null,
    },
  };

  try {
    if (!userId) {
      return NextResponse.json(
        {
          data: {
            ...base,
            cards: {},
          },
        },
        { status: 200 },
      );
    }

    if (role === "ADMIN") {
      return NextResponse.json({
        data: {
          ...base,
          cards: await getAdminCards(),
        },
      });
    }

    if (role === "BRAND_ADMIN") {
      return NextResponse.json({
        data: {
          ...base,
          cards: await getBrandAdminCards(userId),
        },
      });
    }

    if (role === "CREATOR") {
      return NextResponse.json({
        data: {
          ...base,
          cards: await getCreatorCards(userId),
        },
      });
    }

    const userData = await getUserCardsAndActivity(userId);
    return NextResponse.json({
      data: {
        ...base,
        ...userData,
      },
    });
  } catch (error) {
    console.error("[me/dashboard-summary][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load dashboard summary." },
      { status: 500 },
    );
  }
}
