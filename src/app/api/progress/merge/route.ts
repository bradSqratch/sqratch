import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { awardQrScanPoint } from "@/lib/points";
import prisma from "@/lib/prisma";
import { redeemQrCodeForUser } from "@/lib/qr-redemption";
import { SESSION_COOKIE_NAME } from "@/lib/session";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id || null;
    const userEmail = session?.user?.email || null;
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
    let pointsAwarded = 0;

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
