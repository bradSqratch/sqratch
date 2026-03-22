import { NextRequest, NextResponse } from "next/server";
import { getCreatorContext } from "@/lib/creator-auth";
import prisma from "@/lib/prisma";

function getDateRange(request: NextRequest) {
  const dateFrom = request.nextUrl.searchParams.get("dateFrom");
  const dateTo = request.nextUrl.searchParams.get("dateTo");

  const start = dateFrom ? new Date(dateFrom) : null;
  const end = dateTo ? new Date(dateTo) : null;

  if (end) {
    end.setHours(23, 59, 59, 999);
  }

  return { start, end };
}

export async function GET(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const experienceId = request.nextUrl.searchParams.get("experienceId");
    const { start, end } = getDateRange(request);

    const experiences = await prisma.experience.findMany({
      where: {
        creatorId: creator.creatorProfile.id,
        ...(experienceId
          ? {
              id: experienceId,
            }
          : {}),
      },
      orderBy: { title: "asc" },
      select: {
        id: true,
        title: true,
        slug: true,
      },
    });

    const experienceIds = experiences.map((experience) => experience.id);

    const analyticsWhere = {
      experienceId: {
        in: experienceIds,
      },
      ...(start || end
        ? {
            createdAt: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {}),
            },
          }
        : {}),
    };

    const questionWhere = {
      experienceId: {
        in: experienceIds,
      },
      ...(start || end
        ? {
            createdAt: {
              ...(start ? { gte: start } : {}),
              ...(end ? { lte: end } : {}),
            },
          }
        : {}),
    };

    const [
      experienceViews,
      lessonStarts,
      lessonCompletions,
      questionCounts,
      totalCompletedLessons,
    ] = await Promise.all([
      experienceIds.length
        ? prisma.analyticsEvent.groupBy({
            by: ["experienceId"],
            where: {
              ...analyticsWhere,
              name: "experience_view",
            },
            _count: {
              _all: true,
            },
          })
        : [],
      experienceIds.length
        ? prisma.analyticsEvent.groupBy({
            by: ["experienceId"],
            where: {
              ...analyticsWhere,
              name: "lesson_started",
            },
            _count: {
              _all: true,
            },
          })
        : [],
      experienceIds.length
        ? prisma.analyticsEvent.groupBy({
            by: ["experienceId"],
            where: {
              ...analyticsWhere,
              name: "lesson_completed",
            },
            _count: {
              _all: true,
            },
          })
        : [],
      experienceIds.length
        ? prisma.question.groupBy({
            by: ["experienceId"],
            where: questionWhere,
            _count: {
              _all: true,
            },
          })
        : [],
      experienceIds.length
        ? prisma.lessonProgress.count({
            where: {
              isCompleted: true,
              lesson: {
                course: {
                  experienceId: {
                    in: experienceIds,
                  },
                },
              },
              ...(start || end
                ? {
                    updatedAt: {
                      ...(start ? { gte: start } : {}),
                      ...(end ? { lte: end } : {}),
                    },
                  }
                : {}),
            },
          })
        : 0,
    ]);

    const viewMap = new Map(
      experienceViews.map((row) => [row.experienceId, row._count._all]),
    );
    const lessonStartMap = new Map(
      lessonStarts.map((row) => [row.experienceId, row._count._all]),
    );
    const lessonCompletionMap = new Map(
      lessonCompletions.map((row) => [row.experienceId, row._count._all]),
    );
    const questionMap = new Map(
      questionCounts.map((row) => [row.experienceId, row._count._all]),
    );

    const byExperience = experiences.map((experience) => ({
      id: experience.id,
      title: experience.title,
      slug: experience.slug,
      views: viewMap.get(experience.id) || 0,
      lessonStarts: lessonStartMap.get(experience.id) || 0,
      lessonCompletions: lessonCompletionMap.get(experience.id) || 0,
      questions: questionMap.get(experience.id) || 0,
    }));

    return NextResponse.json({
      data: {
        filters: {
          experienceId: experienceId || null,
          dateFrom: start,
          dateTo: end,
        },
        experiences,
        totals: {
          views: byExperience.reduce((total, row) => total + row.views, 0),
          lessonStarts: byExperience.reduce(
            (total, row) => total + row.lessonStarts,
            0,
          ),
          lessonCompletions: byExperience.reduce(
            (total, row) => total + row.lessonCompletions,
            0,
          ),
          questions: byExperience.reduce((total, row) => total + row.questions, 0),
          completedLessonsFromProgress: totalCompletedLessons,
        },
        byExperience,
      },
    });
  } catch (error) {
    console.error("[creator/analytics][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load creator analytics." },
      { status: 500 },
    );
  }
}
