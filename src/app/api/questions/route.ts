import { NextRequest, NextResponse } from "next/server";
import { getExperienceAccessContext, getViewerContext } from "@/lib/experience-access";
import prisma from "@/lib/prisma";

function getServerDayRange() {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  return { dayStart, dayEnd };
}

async function getExperienceSlugFromRequest(request: NextRequest) {
  const experienceSlug = request.nextUrl.searchParams.get("experienceSlug");
  const experienceId = request.nextUrl.searchParams.get("experienceId");

  if (experienceSlug) {
    return experienceSlug;
  }

  if (!experienceId) {
    return null;
  }

  const experience = await prisma.experience.findUnique({
    where: { id: experienceId },
    select: { slug: true },
  });

  return experience?.slug || null;
}

export async function GET(request: NextRequest) {
  try {
    const creatorInbox =
      request.nextUrl.searchParams.get("creatorInbox") === "1";

    if (creatorInbox) {
      const viewer = await getViewerContext(request);

      if (!viewer.userId) {
        return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
      }

      const experienceId = request.nextUrl.searchParams.get("experienceId");
      const creatorProfile = await prisma.creatorProfile.findUnique({
        where: {
          userId: viewer.userId,
        },
        select: {
          id: true,
          experiences: {
            where: experienceId ? { id: experienceId } : undefined,
            orderBy: { updatedAt: "desc" },
            select: {
              id: true,
              title: true,
              slug: true,
            },
          },
        },
      });

      if (!creatorProfile) {
        return NextResponse.json(
          { error: "Creator access required." },
          { status: 403 },
        );
      }

      const experienceIds = creatorProfile.experiences.map(
        (experience) => experience.id,
      );

      const experienceFilter = experienceIds.length
        ? {
            experienceId: {
              in: experienceIds,
            },
          }
        : { id: { in: [] as string[] } };

      const [openQuestions, answeredQuestions] = await Promise.all([
        prisma.question.findMany({
          where: {
            ...experienceFilter,
            status: "OPEN",
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            body: true,
            status: true,
            createdAt: true,
            experience: {
              select: {
                id: true,
                title: true,
                slug: true,
              },
            },
            askedBy: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        }),
        prisma.question.findMany({
          where: {
            ...experienceFilter,
            status: "ANSWERED",
          },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            body: true,
            status: true,
            createdAt: true,
            experience: {
              select: {
                id: true,
                title: true,
                slug: true,
              },
            },
            askedBy: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
            answers: {
              orderBy: { createdAt: "asc" },
              select: {
                id: true,
                body: true,
                createdAt: true,
                answeredBy: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                  },
                },
              },
            },
          },
        }),
      ]);

      return NextResponse.json({
        data: {
          experiences: creatorProfile.experiences,
          questions: openQuestions.map((question) => ({
            id: question.id,
            body: question.body,
            status: question.status,
            createdAt: question.createdAt,
            experience: question.experience,
            askedBy: {
              id: question.askedBy.id,
              name: question.askedBy.name || question.askedBy.email,
            },
          })),
          answeredQuestions: answeredQuestions.map((question) => ({
            id: question.id,
            body: question.body,
            status: question.status,
            createdAt: question.createdAt,
            experience: question.experience,
            askedBy: {
              id: question.askedBy.id,
              name: question.askedBy.name || question.askedBy.email,
            },
            answers: question.answers.map((answer) => ({
              id: answer.id,
              body: answer.body,
              createdAt: answer.createdAt,
              answeredBy: {
                id: answer.answeredBy.id,
                name: answer.answeredBy.name || answer.answeredBy.email,
              },
            })),
          })),
        },
      });
    }

    const experienceSlug = await getExperienceSlugFromRequest(request);

    if (!experienceSlug) {
      return NextResponse.json(
        { error: "experienceSlug or experienceId is required." },
        { status: 400 },
      );
    }

    const access = await getExperienceAccessContext(experienceSlug, request);

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    if (!access.viewer.userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    if (!access.canInteract) {
      return NextResponse.json(
        { error: "You do not have access to Q&A." },
        { status: 403 },
      );
    }

    const { dayStart, dayEnd } = getServerDayRange();
    const [questions, todaysQuestionCount] = await Promise.all([
      prisma.question.findMany({
        where: {
          experienceId: access.experience.id,
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          body: true,
          status: true,
          createdAt: true,
          askedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          answers: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              body: true,
              createdAt: true,
              answeredBy: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
      }),
      prisma.question.count({
        where: {
          experienceId: access.experience.id,
          askedById: access.viewer.userId,
          createdAt: {
            gte: dayStart,
            lt: dayEnd,
          },
        },
      }),
    ]);

    const dailyLimit = access.experience.qaDailyQuestionLimit || 1;

    return NextResponse.json({
      data: {
        experience: {
          id: access.experience.id,
          slug: access.experience.slug,
          title: access.experience.title,
        },
        canAnswer: access.isCreatorOwner,
        dailyLimit,
        remainingToday: Math.max(0, dailyLimit - todaysQuestionCount),
        questions: questions.map((question) => ({
          id: question.id,
          body: question.body,
          status: question.status,
          createdAt: question.createdAt,
          askedBy: {
            id: question.askedBy.id,
            name: question.askedBy.name || question.askedBy.email,
          },
          answers: question.answers.map((answer) => ({
            id: answer.id,
            body: answer.body,
            createdAt: answer.createdAt,
            answeredBy: {
              id: answer.answeredBy.id,
              name: answer.answeredBy.name || answer.answeredBy.email,
            },
          })),
        })),
      },
    });
  } catch (error) {
    console.error("[questions][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load questions." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const viewer = await getViewerContext(request);

    if (!viewer.userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = await request.json();
    const experienceId = String(body?.experienceId || "").trim();
    const experienceSlug = String(body?.experienceSlug || "").trim();
    const content = String(body?.body || "").trim();

    if (!content || (!experienceId && !experienceSlug)) {
      return NextResponse.json(
        { error: "Experience and question body are required." },
        { status: 400 },
      );
    }

    const resolvedExperienceSlug =
      experienceSlug ||
      (
        await prisma.experience.findUnique({
          where: { id: experienceId },
          select: { slug: true },
        })
      )?.slug ||
      "";

    if (!resolvedExperienceSlug) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const access = await getExperienceAccessContext(
      resolvedExperienceSlug,
      request,
    );

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    if (!access.canInteract) {
      return NextResponse.json(
        { error: "You do not have access to submit a question." },
        { status: 403 },
      );
    }

    const { dayStart, dayEnd } = getServerDayRange();
    const dailyLimit = access.experience.qaDailyQuestionLimit || 1;
    const todaysQuestionCount = await prisma.question.count({
      where: {
        experienceId: access.experience.id,
        askedById: viewer.userId,
        createdAt: {
          gte: dayStart,
          lt: dayEnd,
        },
      },
    });

    if (todaysQuestionCount >= dailyLimit) {
      return NextResponse.json(
        {
          error: `Daily question limit reached (${dailyLimit}).`,
          remainingToday: 0,
        },
        { status: 429 },
      );
    }

    const question = await prisma.question.create({
      data: {
        experienceId: access.experience.id,
        askedById: viewer.userId,
        body: content,
      },
      select: {
        id: true,
        body: true,
        status: true,
        createdAt: true,
      },
    });

    return NextResponse.json(
      {
        data: {
          ...question,
          remainingToday: Math.max(0, dailyLimit - todaysQuestionCount - 1),
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[questions][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create question." },
      { status: 500 },
    );
  }
}
