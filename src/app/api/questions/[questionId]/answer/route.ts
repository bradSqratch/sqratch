import { NextRequest, NextResponse } from "next/server";
import { getViewerContext } from "@/lib/experience-access";
import prisma from "@/lib/prisma";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ questionId: string }> },
) {
  try {
    const { questionId } = await context.params;
    const viewer = await getViewerContext(request);

    if (!viewer.userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const userId = viewer.userId;

    const body = await request.json();
    const content = String(body?.body || "").trim();

    if (!content) {
      return NextResponse.json(
        { error: "Answer body is required." },
        { status: 400 },
      );
    }

    const question = await prisma.question.findUnique({
      where: { id: questionId },
      select: {
        id: true,
        experience: {
          select: {
            creator: {
              select: {
                userId: true,
              },
            },
          },
        },
      },
    });

    if (!question) {
      return NextResponse.json(
        { error: "Question not found." },
        { status: 404 },
      );
    }

    if (question.experience.creator.userId !== viewer.userId) {
      return NextResponse.json(
        { error: "Only the experience creator can answer." },
        { status: 403 },
      );
    }

    const existingAnswer = await prisma.questionAnswer.findFirst({
      where: { questionId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    const answer = await prisma.$transaction(async (tx) => {
      const savedAnswerId = existingAnswer
        ? (
            await tx.questionAnswer.update({
              where: { id: existingAnswer.id },
              data: {
                body: content,
              },
              select: {
                id: true,
              },
            })
          ).id
        : (
            await tx.questionAnswer.create({
              data: {
                questionId,
                answeredById: userId,
                body: content,
              },
              select: {
                id: true,
              },
            })
          ).id;

      await tx.question.update({
        where: { id: questionId },
        data: {
          status: "ANSWERED",
        },
      });

      return tx.questionAnswer.findUniqueOrThrow({
        where: { id: savedAnswerId },
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
      });
    });

    return NextResponse.json({
      data: {
        id: answer.id,
        body: answer.body,
        createdAt: answer.createdAt,
        answeredBy: {
          id: answer.answeredBy.id,
          name: answer.answeredBy.name || answer.answeredBy.email,
        },
      },
    });
  } catch (error) {
    console.error("[questions/[questionId]/answer][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to answer question." },
      { status: 500 },
    );
  }
}
