import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  awardQrScanPoint,
  awardLessonCompletionPoints,
  awardCourseCompletionPoints,
} from "@/lib/points";
import { redeemQrCodeForUser } from "@/lib/qr-redemption";
import { SESSION_COOKIE_NAME } from "@/lib/session";
import { isValidSessionId } from "@/lib/session-id";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";

export async function POST(request: NextRequest) {
  return mergeImpl(request, realAuthResolvers);
}

export async function mergeImpl(request: NextRequest, deps: AuthResolvers) {
  try {
    const session = await deps.resolveSession();
    const userId = session?.user?.id || null;
    const userEmail = session?.user?.email || null;
    const rawSessionId = request.cookies.get(SESSION_COOKIE_NAME)?.value || null;
    const sessionId = isValidSessionId(rawSessionId) ? rawSessionId : null;

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
    let pointsAwarded = 0;

    // Lessons that are completed for the user after the merge — used to award
    // creator-configured lesson/course completion rewards below.
    const completedLessonIds = new Set<string>();

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
        if (anonRow.isCompleted) {
          completedLessonIds.add(anonRow.lessonId);
        }
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
      if (existingUserRow.isCompleted || anonRow.isCompleted) {
        completedLessonIds.add(anonRow.lessonId);
      }
      mergedLessons += 1;
    }

    if (anonProgressRows.length > 0) {
      await prisma.lessonProgress.deleteMany({
        where: { sessionId },
      });
    }

    // Award completion rewards for lessons that became (or already were)
    // completed by this now-logged-in user. Idempotent via the ledger, so a
    // reward already granted before the merge is never granted twice. Course
    // rewards fire only when all active lessons in a course are complete.
    if (completedLessonIds.size > 0) {
      try {
        const mergedLessonRows = await prisma.lesson.findMany({
          where: { id: { in: Array.from(completedLessonIds) } },
          select: { id: true, courseId: true },
        });
        for (const lessonRow of mergedLessonRows) {
          await awardLessonCompletionPoints({ userId, lessonId: lessonRow.id });
        }
        const affectedCourseIds = new Set(
          mergedLessonRows.map((lessonRow) => lessonRow.courseId),
        );
        for (const courseId of affectedCourseIds) {
          await awardCourseCompletionPoints({ userId, courseId });
        }
      } catch (rewardError) {
        console.error(
          "[progress/merge] completion reward error:",
          rewardError,
        );
      }
    }

    for (const unlock of anonUnlocks) {
      const result = await prisma.$transaction(async (tx) => {
        const existingUserUnlock = await tx.campaignUnlock.findFirst({
          where: {
            campaignId: unlock.campaignId,
            userId,
          },
          select: { id: true },
        });

        if (existingUserUnlock) {
          let pointAwarded = false;

          if (unlock.qrCodeId) {
            const redemption = await redeemQrCodeForUser({
              qrCodeId: unlock.qrCodeId,
              userId,
              userEmail,
              db: tx,
            });

            if (redemption.redeemed) {
              pointAwarded = await awardQrScanPoint({
                userId,
                qrCodeId: unlock.qrCodeId,
                db: tx,
              });
            }
          }

          await tx.campaignUnlock.delete({
            where: { id: unlock.id },
          });

          return {
            merged: false,
            pointAwarded,
          };
        }

        if (unlock.qrCodeId) {
          const redemption = await redeemQrCodeForUser({
            qrCodeId: unlock.qrCodeId,
            userId,
            userEmail,
            db: tx,
          });

          if (!redemption.redeemed) {
            await tx.campaignUnlock.delete({
              where: { id: unlock.id },
            });

            return {
              merged: false,
              pointAwarded: false,
            };
          }
        }

        await tx.campaignUnlock.update({
          where: { id: unlock.id },
          data: { userId },
        });

        return {
          merged: true,
          pointAwarded: await awardQrScanPoint({
            userId,
            qrCodeId: unlock.qrCodeId,
            db: tx,
          }),
        };
      });

      if (result.merged) {
        mergedUnlocks += 1;
      }

      if (result.pointAwarded) {
        pointsAwarded += 1;
      }
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
        pointsAwarded,
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
