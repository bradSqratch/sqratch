import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

type Db = typeof prisma;

export type CustomerActivityItem = {
  label: string;
  detail?: string;
  at?: string;
  href?: string;
};

export type CustomerHome = {
  cards: {
    unlockedCampaignsCount: number;
    continueWatchingLessonsCount: number;
    recentActivityCount: number;
  };
  recentActivity: CustomerActivityItem[];
  resume: {
    experienceSlug: string;
    experienceTitle: string;
    lessonId: string;
    lessonTitle: string;
    lastPositionSeconds: number;
    href: string;
  } | null;
  unlockedExperiences: Array<{
    slug: string;
    title: string;
    coverImageUrl: string | null;
    creatorName: string | null;
    href: string;
  }>;
  unlockedExperiencesTotal: number;
  rewards: { spendablePoints: number; href: string };
};

/** Cap on the experience list; the dashboard states the total when it is larger. */
export const UNLOCKED_EXPERIENCES_LIMIT = 12;

function relativeTime(date: Date, now: number) {
  const minutes = Math.floor((now - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const lessonHref = (experienceSlug: string, lessonId: string) =>
  `/x/${encodeURIComponent(experienceSlug)}/lessons/${encodeURIComponent(lessonId)}`;
const experienceHref = (experienceSlug: string) => `/x/${encodeURIComponent(experienceSlug)}`;

/**
 * Lessons a signed-in customer may open: the lesson, its course and its
 * experience are published, and a private course also needs an unlock on one of
 * the experience's campaigns. This mirrors the viewer's own access rule, so the
 * dashboard never offers a link the viewer would refuse.
 */
export function accessibleLessonWhere(unlockedCampaignIds: string[]): Prisma.LessonWhereInput {
  return {
    isActive: true,
    course: {
      isActive: true,
      experience: { isActive: true },
      OR: [
        { access: "PUBLIC" },
        { experience: { campaigns: { some: { campaignId: { in: unlockedCampaignIds } } } } },
      ],
    },
  };
}

export async function loadCustomerHome(userId: string, db: Db = prisma, now: Date = new Date()): Promise<CustomerHome> {
  const recentWindow = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const unlocks = await db.campaignUnlock.findMany({
    where: { userId },
    select: { campaignId: true },
  });
  const unlockedCampaignIds = [...new Set(unlocks.map((unlock) => unlock.campaignId))];
  const accessibleLesson = accessibleLessonWhere(unlockedCampaignIds);
  const unlockedExperienceWhere: Prisma.ExperienceWhereInput = {
    isActive: true,
    campaigns: { some: { campaignId: { in: unlockedCampaignIds } } },
  };

  const [
    continueWatchingCount,
    resumeRow,
    experiences,
    experienceTotal,
    account,
    recentUnlocks,
    recentProgress,
    recentCommerceClicks,
    recentEvents,
  ] = await Promise.all([
    db.lessonProgress.count({
      where: { userId, isCompleted: false, lastPositionSeconds: { gt: 0 }, lesson: accessibleLesson },
    }),
    db.lessonProgress.findFirst({
      where: { userId, isCompleted: false, lastPositionSeconds: { gt: 0 }, lesson: accessibleLesson },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      select: {
        lastPositionSeconds: true,
        lesson: {
          select: {
            id: true,
            title: true,
            course: { select: { experience: { select: { slug: true, title: true } } } },
          },
        },
      },
    }),
    db.experience.findMany({
      where: unlockedExperienceWhere,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      take: UNLOCKED_EXPERIENCES_LIMIT,
      select: {
        slug: true,
        title: true,
        coverImageUrl: true,
        creator: { select: { displayName: true } },
      },
    }),
    db.experience.count({ where: unlockedExperienceWhere }),
    db.userPointAccount.findUnique({ where: { userId }, select: { spendablePoints: true } }),
    db.campaignUnlock.findMany({
      where: { userId, createdAt: { gte: recentWindow } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        createdAt: true,
        campaign: {
          select: {
            name: true,
            experiences: {
              where: { experience: { isActive: true } },
              orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
              take: 1,
              select: { experience: { select: { slug: true } } },
            },
          },
        },
      },
    }),
    db.lessonProgress.findMany({
      where: { userId, updatedAt: { gte: recentWindow }, lesson: accessibleLesson },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: {
        updatedAt: true,
        isCompleted: true,
        lesson: {
          select: {
            id: true,
            title: true,
            course: { select: { experience: { select: { slug: true } } } },
          },
        },
      },
    }),
    db.commerceClickAttribution.findMany({
      where: { userId, experience: { isActive: true }, createdAt: { gte: recentWindow } },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { createdAt: true, experience: { select: { title: true, slug: true } } },
    }),
    db.analyticsEvent.findMany({
      where: {
        userId,
        lesson: accessibleLesson,
        createdAt: { gte: recentWindow },
        name: { in: ["lesson_started", "lesson_completed"] },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        name: true,
        createdAt: true,
        lessonId: true,
        experience: { select: { title: true, slug: true } },
      },
    }),
  ]);

  const stamp = (date: Date) => relativeTime(date, now.getTime());
  const items: Array<CustomerActivityItem & { ts: Date }> = [
    ...recentProgress.map((progress) => ({
      label: progress.isCompleted ? "Completed lesson" : "Watched lesson",
      detail: progress.lesson.title,
      at: stamp(progress.updatedAt),
      href: lessonHref(progress.lesson.course.experience.slug, progress.lesson.id),
      ts: progress.updatedAt,
    })),
    ...recentUnlocks.map((unlock) => {
      const slug = unlock.campaign.experiences[0]?.experience.slug;
      return {
        label: "Unlocked campaign",
        detail: unlock.campaign.name,
        at: stamp(unlock.createdAt),
        href: slug ? experienceHref(slug) : undefined,
        ts: unlock.createdAt,
      };
    }),
    ...recentCommerceClicks.map((click) => ({
      label: "Opened shop product",
      detail: click.experience.title,
      at: stamp(click.createdAt),
      href: `${experienceHref(click.experience.slug)}/shop`,
      ts: click.createdAt,
    })),
    ...recentEvents.map((event) => ({
      label: event.name === "lesson_completed" ? "Completed lesson" : "Started lesson",
      detail: event.experience?.title || undefined,
      at: stamp(event.createdAt),
      href: event.experience?.slug && event.lessonId ? lessonHref(event.experience.slug, event.lessonId) : undefined,
      ts: event.createdAt,
    })),
  ];

  const recentActivity = items
    .sort((a, b) => b.ts.getTime() - a.ts.getTime())
    .slice(0, 6)
    .map((item) => ({ label: item.label, detail: item.detail, at: item.at, href: item.href }));

  const experience = resumeRow?.lesson.course.experience;
  return {
    cards: {
      unlockedCampaignsCount: unlockedCampaignIds.length,
      continueWatchingLessonsCount: continueWatchingCount,
      recentActivityCount: recentActivity.length,
    },
    recentActivity,
    resume:
      resumeRow && experience
        ? {
            experienceSlug: experience.slug,
            experienceTitle: experience.title,
            lessonId: resumeRow.lesson.id,
            lessonTitle: resumeRow.lesson.title,
            lastPositionSeconds: resumeRow.lastPositionSeconds,
            href: lessonHref(experience.slug, resumeRow.lesson.id),
          }
        : null,
    unlockedExperiences: experiences.map((item) => ({
      slug: item.slug,
      title: item.title,
      coverImageUrl: item.coverImageUrl,
      creatorName: item.creator.displayName,
      href: experienceHref(item.slug),
    })),
    unlockedExperiencesTotal: experienceTotal,
    rewards: { spendablePoints: account?.spendablePoints ?? 0, href: "/dashboard/points" },
  };
}
