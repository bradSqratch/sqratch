import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  createAnalyticsEvent,
  getExperienceAccessContext,
  getViewerContext,
} from "@/lib/experience-access";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";
import {
  awardLessonCompletionPoints,
  awardCourseCompletionPoints,
} from "@/lib/points";

function buildProgressWhere(
  userId: string | null,
  sessionId: string | null,
  lessonIds: string[],
) {
  if (userId) {
    return {
      userId,
      lessonId: {
        in: lessonIds,
      },
    };
  }

  if (sessionId) {
    return {
      sessionId,
      lessonId: {
        in: lessonIds,
      },
    };
  }

  return null;
}

export async function GET(request: NextRequest) {
  try {
    const experienceSlug = request.nextUrl.searchParams.get("experienceSlug");
    const courseId = request.nextUrl.searchParams.get("courseId");
    const lessonId = request.nextUrl.searchParams.get("lessonId");
    const viewer = await getViewerContext(request);

    let courseIds: string[] = [];
    let lessonIds: string[] = [];

    if (experienceSlug) {
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
        select: {
          id: true,
          lessons: {
            where: { isActive: true },
            select: {
              id: true,
            },
          },
        },
      });

      courseIds = courses.map((course) => course.id);
      lessonIds = courses.flatMap((course) =>
        course.lessons.map((lesson) => lesson.id),
      );
    } else if (courseId) {
      const course = await prisma.course.findUnique({
        where: { id: courseId },
        select: {
          id: true,
          access: true,
          experience: {
            select: {
              slug: true,
            },
          },
          lessons: {
            where: { isActive: true },
            select: { id: true },
          },
        },
      });

      if (!course) {
        return NextResponse.json(
          { error: "Course not found." },
          { status: 404 },
        );
      }

      const access = await getExperienceAccessContext(
        course.experience.slug,
        request,
      );

      if (!access) {
        return NextResponse.json(
          { error: "Experience not found." },
          { status: 404 },
        );
      }

      if (course.access === "PRIVATE" && !access.canAccessPrivate) {
        return NextResponse.json({ data: { lessonProgress: [], courseProgress: [] } });
      }

      courseIds = [course.id];
      lessonIds = course.lessons.map((lesson) => lesson.id);
    } else if (lessonId) {
      lessonIds = [lessonId];

      const lesson = await prisma.lesson.findUnique({
        where: { id: lessonId },
        select: {
          courseId: true,
          course: {
            select: {
              access: true,
              experience: {
                select: {
                  slug: true,
                },
              },
            },
          },
        },
      });

      if (!lesson) {
        return NextResponse.json(
          { error: "Lesson not found." },
          { status: 404 },
        );
      }

      const access = await getExperienceAccessContext(
        lesson.course.experience.slug,
        request,
      );

      if (!access) {
        return NextResponse.json(
          { error: "Experience not found." },
          { status: 404 },
        );
      }

      if (lesson.course.access === "PRIVATE" && !access.canAccessPrivate) {
        return NextResponse.json({ data: { lessonProgress: [], courseProgress: [] } });
      }

      courseIds = [lesson.courseId];
    }

    if (lessonIds.length === 0) {
      return NextResponse.json({
        data: {
          lessonProgress: [],
          courseProgress: [],
        },
      });
    }

    const progressWhere = buildProgressWhere(
      viewer.userId,
      viewer.sessionId,
      lessonIds,
    );

    const progressRows = progressWhere
      ? await prisma.lessonProgress.findMany({
          where: progressWhere,
          select: {
            lessonId: true,
            isCompleted: true,
            lastPositionSeconds: true,
            updatedAt: true,
            lesson: {
              select: {
                courseId: true,
              },
            },
          },
        })
      : [];

    const courseStats = new Map<
      string,
      { totalLessons: number; completedLessons: number }
    >();

    if (courseIds.length > 0) {
      const totals = await prisma.lesson.groupBy({
        by: ["courseId"],
        where: {
          isActive: true,
          courseId: {
            in: courseIds,
          },
        },
        _count: {
          _all: true,
        },
      });

      for (const item of totals) {
        courseStats.set(item.courseId, {
          totalLessons: item._count._all,
          completedLessons: 0,
        });
      }
    }

    for (const row of progressRows) {
      const courseIdForRow = row.lesson.courseId;
      const existing = courseStats.get(courseIdForRow);

      if (!existing) {
        continue;
      }

      if (row.isCompleted) {
        existing.completedLessons += 1;
      }
    }

    return NextResponse.json({
      data: {
        lessonProgress: progressRows.map((row) => ({
          lessonId: row.lessonId,
          isCompleted: row.isCompleted,
          lastPositionSeconds: row.lastPositionSeconds,
          updatedAt: row.updatedAt,
        })),
        courseProgress: Array.from(courseStats.entries()).map(
          ([trackedCourseId, stats]) => ({
            courseId: trackedCourseId,
            totalLessons: stats.totalLessons,
            completedLessons: stats.completedLessons,
            progressPercent:
              stats.totalLessons > 0
                ? Math.round((stats.completedLessons / stats.totalLessons) * 100)
                : 0,
          }),
        ),
      },
    });
  } catch (error) {
    console.error("[progress/lesson][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load lesson progress." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const lessonId = String(body?.lessonId || "").trim();
    const lastPositionSeconds = Math.max(
      0,
      Number(body?.lastPositionSeconds || 0),
    );
    const isCompleted = Boolean(body?.isCompleted);
    const eventName = String(body?.eventName || "").trim();
    const progressPercent =
      typeof body?.progressPercent === "number" ? body.progressPercent : null;

    if (!lessonId) {
      return NextResponse.json(
        { error: "lessonId is required." },
        { status: 400 },
      );
    }

    const lesson = await prisma.lesson.findUnique({
      where: { id: lessonId },
      select: {
        id: true,
        title: true,
        courseId: true,
        course: {
          select: {
            id: true,
            access: true,
            experience: {
              select: {
                id: true,
                slug: true,
                campaigns: {
                  select: {
                    campaignId: true,
                    campaign: {
                      select: {
                        brandId: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!lesson) {
      return NextResponse.json(
        { error: "Lesson not found." },
        { status: 404 },
      );
    }

    const access = await getExperienceAccessContext(
      lesson.course.experience.slug,
      request,
    );

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    if (lesson.course.access === "PRIVATE" && !access.canAccessPrivate) {
      return NextResponse.json(
        { error: "You do not have access to this lesson." },
        { status: 403 },
      );
    }

    const sessionId = await ensureViewerSession({
      request,
      userId: access.viewer.userId,
      campaignId: access.campaignIds[0] || null,
    });

    const progressWhere = access.viewer.userId
      ? {
          userId_lessonId: {
            userId: access.viewer.userId,
            lessonId,
          },
        }
      : {
          sessionId_lessonId: {
            sessionId,
            lessonId,
          },
        };

    const existing = await prisma.lessonProgress.findUnique({
      where: progressWhere,
      select: {
        id: true,
        lastPositionSeconds: true,
        isCompleted: true,
      },
    });

    const progress = existing
      ? await prisma.lessonProgress.update({
          where: { id: existing.id },
          data: {
            lastPositionSeconds: Math.max(
              existing.lastPositionSeconds,
              lastPositionSeconds,
            ),
            isCompleted: existing.isCompleted || isCompleted,
          },
          select: {
            lessonId: true,
            lastPositionSeconds: true,
            isCompleted: true,
            updatedAt: true,
          },
        })
      : await prisma.lessonProgress.create({
          data: {
            lessonId,
            userId: access.viewer.userId || undefined,
            sessionId: access.viewer.userId ? undefined : sessionId,
            lastPositionSeconds,
            isCompleted,
          },
          select: {
            lessonId: true,
            lastPositionSeconds: true,
            isCompleted: true,
            updatedAt: true,
          },
        });

    // Award creator-configured completion rewards for logged-in users only.
    // Anonymous completions are rewarded later, on progress merge. Awards are
    // idempotent per (user, lesson/course) via the ledger, so retries and repeat
    // POSTs never double-award. Failures here must not block the progress save.
    if (access.viewer.userId && progress.isCompleted) {
      try {
        await awardLessonCompletionPoints({
          userId: access.viewer.userId,
          lessonId,
        });
        await awardCourseCompletionPoints({
          userId: access.viewer.userId,
          courseId: lesson.courseId,
        });
      } catch (rewardError) {
        console.error(
          "[progress/lesson][POST] completion reward error:",
          rewardError,
        );
      }
    }

    const normalizedEventName = new Set([
      "lesson_started",
      "lesson_progress",
      "lesson_completed",
    ]).has(eventName)
      ? eventName
      : "";

    if (normalizedEventName) {
      const primaryCampaign = lesson.course.experience.campaigns[0];

      await createAnalyticsEvent({
        request,
        name: normalizedEventName,
        brandId: primaryCampaign?.campaign.brandId || null,
        campaignId: primaryCampaign?.campaignId || null,
        experienceId: lesson.course.experience.id,
        courseId: lesson.courseId,
        lessonId: lesson.id,
        userId: access.viewer.userId,
        sessionId,
        pagePath: `/x/${lesson.course.experience.slug}/lessons/${lesson.id}`,
        data: {
          progressPercent,
          lastPositionSeconds: progress.lastPositionSeconds,
          isCompleted: progress.isCompleted,
        },
      });
    }

    const response = NextResponse.json({
      data: {
        progress,
      },
    });

    attachSessionCookie(response, sessionId);
    return response;
  } catch (error) {
    console.error("[progress/lesson][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to save lesson progress." },
      { status: 500 },
    );
  }
}
