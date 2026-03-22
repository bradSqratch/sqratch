import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id || null;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const [progressRows, unlockedCampaigns] = await Promise.all([
      prisma.lessonProgress.findMany({
        where: {
          userId,
        },
        orderBy: {
          updatedAt: "desc",
        },
        select: {
          id: true,
          lessonId: true,
          lastPositionSeconds: true,
          isCompleted: true,
          updatedAt: true,
          lesson: {
            select: {
              id: true,
              title: true,
              description: true,
              course: {
                select: {
                  id: true,
                  title: true,
                  lessons: {
                    where: { isActive: true },
                    select: { id: true },
                  },
                  experience: {
                    select: {
                      id: true,
                      slug: true,
                      title: true,
                      coverImageUrl: true,
                      campaigns: {
                        orderBy: { sortOrder: "asc" },
                        select: {
                          campaignId: true,
                          campaign: {
                            select: {
                              id: true,
                              name: true,
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      prisma.campaignUnlock.findMany({
        where: { userId },
        select: {
          campaignId: true,
        },
      }),
    ]);

    const unlockedCampaignIdSet = new Set(
      unlockedCampaigns.map((unlock) => unlock.campaignId),
    );

    const courseIds = Array.from(
      new Set(progressRows.map((row) => row.lesson.course.id)),
    );

    const allCourseLessons = courseIds.length
      ? await prisma.lesson.findMany({
          where: {
            courseId: {
              in: courseIds,
            },
            isActive: true,
          },
          select: {
            id: true,
            courseId: true,
          },
        })
      : [];

    const lessonProgressByCourse = new Map<string, Set<string>>();

    for (const row of progressRows) {
      if (!row.isCompleted) {
        continue;
      }

      const completed =
        lessonProgressByCourse.get(row.lesson.course.id) || new Set<string>();
      completed.add(row.lessonId);
      lessonProgressByCourse.set(row.lesson.course.id, completed);
    }

    const totalLessonsByCourse = new Map<string, number>();

    for (const lesson of allCourseLessons) {
      totalLessonsByCourse.set(
        lesson.courseId,
        (totalLessonsByCourse.get(lesson.courseId) || 0) + 1,
      );
    }

    const continueWatching = progressRows
      .filter((row) => !row.isCompleted && row.lastPositionSeconds > 0)
      .map((row) => {
        const experience = row.lesson.course.experience;
        const linkedUnlockedCampaign =
          experience.campaigns.find((item) =>
            unlockedCampaignIdSet.has(item.campaignId),
          )?.campaign || null;
        const totalLessons = totalLessonsByCourse.get(row.lesson.course.id) || 0;
        const completedLessons =
          lessonProgressByCourse.get(row.lesson.course.id)?.size || 0;

        return {
          progressId: row.id,
          lessonId: row.lessonId,
          lastPositionSeconds: row.lastPositionSeconds,
          isCompleted: row.isCompleted,
          updatedAt: row.updatedAt,
          lesson: {
            id: row.lesson.id,
            title: row.lesson.title,
            description: row.lesson.description,
          },
          course: {
            id: row.lesson.course.id,
            title: row.lesson.course.title,
            progressPercent:
              totalLessons > 0
                ? Math.round((completedLessons / totalLessons) * 100)
                : 0,
            completedLessons,
            totalLessons,
          },
          experience: {
            id: experience.id,
            slug: experience.slug,
            title: experience.title,
            coverImageUrl: experience.coverImageUrl,
          },
          campaign: linkedUnlockedCampaign,
        };
      });

    return NextResponse.json({
      data: {
        continueWatching,
        summary: {
          continueWatchingCount: continueWatching.length,
          completedLessonsCount: progressRows.filter((row) => row.isCompleted)
            .length,
        },
      },
    });
  } catch (error) {
    console.error("[user/progress] Error:", error);
    return NextResponse.json(
      { error: "Failed to load user progress." },
      { status: 500 },
    );
  }
}
