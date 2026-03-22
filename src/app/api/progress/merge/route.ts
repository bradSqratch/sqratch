import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { SESSION_COOKIE_NAME } from "@/lib/session";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id || null;
    const sessionId = request.cookies.get(SESSION_COOKIE_NAME)?.value || null;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    if (!sessionId) {
      return NextResponse.json({
        data: {
          mergedLessons: 0,
          mergedUnlocks: 0,
        },
      });
    }

    const [anonProgressRows, anonUnlocks] = await Promise.all([
      prisma.lessonProgress.findMany({
        where: { sessionId },
        orderBy: { updatedAt: "desc" },
      }),
      prisma.campaignUnlock.findMany({
        where: {
          anonKey: sessionId,
          userId: null,
        },
      }),
    ]);

    let mergedLessons = 0;
    let mergedUnlocks = 0;

    for (const anonRow of anonProgressRows) {
      const existingUserRow = await prisma.lessonProgress.findUnique({
        where: {
          userId_lessonId: {
            userId,
            lessonId: anonRow.lessonId,
          },
        },
      });

      if (!existingUserRow) {
        await prisma.lessonProgress.create({
          data: {
            userId,
            lessonId: anonRow.lessonId,
            lastPositionSeconds: anonRow.lastPositionSeconds,
            isCompleted: anonRow.isCompleted,
          },
        });
        mergedLessons += 1;
        continue;
      }

      await prisma.lessonProgress.update({
        where: { id: existingUserRow.id },
        data: {
          lastPositionSeconds: Math.max(
            existingUserRow.lastPositionSeconds,
            anonRow.lastPositionSeconds,
          ),
          isCompleted: existingUserRow.isCompleted || anonRow.isCompleted,
        },
      });
      mergedLessons += 1;
    }

    if (anonProgressRows.length > 0) {
      await prisma.lessonProgress.deleteMany({
        where: { sessionId },
      });
    }

    for (const unlock of anonUnlocks) {
      const existingUserUnlock = await prisma.campaignUnlock.findFirst({
        where: {
          campaignId: unlock.campaignId,
          userId,
        },
        select: { id: true },
      });

      if (existingUserUnlock) {
        await prisma.campaignUnlock.delete({
          where: { id: unlock.id },
        });
        continue;
      }

      await prisma.campaignUnlock.update({
        where: { id: unlock.id },
        data: { userId },
      });
      mergedUnlocks += 1;
    }

    await prisma.userSession.updateMany({
      where: { id: sessionId },
      data: {
        userId,
        lastSeenAt: new Date(),
      },
    });

    return NextResponse.json({
      data: {
        mergedLessons,
        mergedUnlocks,
      },
    });
  } catch (error) {
    console.error("[progress/merge] Error:", error);
    return NextResponse.json(
      { error: "Failed to merge progress." },
      { status: 500 },
    );
  }
}
