import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { cookies } from "next/headers";
import { awardQrScanPoint } from "@/lib/points";
import { redeemQrCodeForUser } from "@/lib/qr-redemption";
import { collectAnonMergeKeys } from "@/lib/anon-merge-keys";
import { verifyAndConsumeEmailVerificationCode } from "@/lib/auth/email-verification";
import { isValidSessionId } from "@/lib/session-id";
import { withAuthNoStore } from "@/lib/auth/auth-response";

async function mergeAnonymousCampaignUnlocks(
  userId: string,
  userEmail?: string | null,
  anonKey?: string | null,
) {
  if (!anonKey) return;

  const anonUnlocks = await prisma.campaignUnlock.findMany({
    where: {
      anonKey,
      userId: null,
    },
    select: {
      id: true,
      campaignId: true,
      qrCodeId: true,
    },
  });

  for (const unlock of anonUnlocks) {
    await prisma.$transaction(async (tx) => {
      const existingUserUnlock = await tx.campaignUnlock.findFirst({
        where: {
          campaignId: unlock.campaignId,
          userId,
        },
        select: { id: true },
      });

      if (existingUserUnlock) {
        if (unlock.qrCodeId) {
          const redemption = await redeemQrCodeForUser({
            qrCodeId: unlock.qrCodeId,
            userId,
            userEmail,
            db: tx,
          });

          if (redemption.redeemed) {
            try {
              await awardQrScanPoint({
                userId,
                qrCodeId: unlock.qrCodeId,
                db: tx,
              });
            } catch {
              console.error("[auth/verify-email] QR reward failed", {
                outcome: "reward_failed",
              });
            }
          }
        }

        await tx.campaignUnlock.delete({
          where: { id: unlock.id },
        });
        return;
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
          return;
        }
      }

      await tx.campaignUnlock.update({
        where: { id: unlock.id },
        data: {
          userId,
        },
      });

      try {
        await awardQrScanPoint({
          userId,
          qrCodeId: unlock.qrCodeId,
          db: tx,
        });
      } catch {
        console.error("[auth/verify-email] QR reward failed", {
          outcome: "reward_failed",
        });
      }
    });
  }
}

async function handlePost(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      email,
      code,
      anonKey: bodyAnonKey,
    }: {
      email?: string;
      code?: string;
      anonKey?: string;
    } = body || {};

    const normalizedEmail = String(email || "").trim().toLowerCase();
    const cleanCode = String(code || "").trim();
    const genericFailure =
      "Unable to verify this code. Request a new code and try again.";

    if (!normalizedEmail || !/^\d{6}$/.test(cleanCode)) {
      return NextResponse.json({ error: genericFailure }, { status: 400 });
    }

    const outcome = await verifyAndConsumeEmailVerificationCode(
      normalizedEmail,
      cleanCode,
    );

    if (outcome !== "verified") {
      return NextResponse.json({ error: genericFailure }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true },
    });

    if (!user) {
      return NextResponse.json({ error: genericFailure }, { status: 400 });
    }

    const cookieStore = await cookies();
    const anonKeyFromCookie = cookieStore.get("anonKey")?.value || null;
    const deviceKeyCookie = cookieStore.get("deviceKey")?.value || null;
    const rawSessionId = cookieStore.get("sqr_session")?.value || null;
    const sessionIdFromCookie = isValidSessionId(rawSessionId)
      ? rawSessionId
      : null;
    const validAnonymousKey = (value: string | null | undefined) => {
      const trimmed = value?.trim() || null;
      return isValidSessionId(trimmed) ? trimmed : null;
    };

    // Merge ALL distinct anon-key candidates so that a stale legacy cookie
    // (anonKey / deviceKey) does NOT shadow the active sqr_session.  The active
    // session is always processed first.
    const mergeKeys = collectAnonMergeKeys({
      bodyAnonKey: validAnonymousKey(bodyAnonKey),
      anonKeyCookie: validAnonymousKey(anonKeyFromCookie),
      deviceKeyCookie: validAnonymousKey(deviceKeyCookie),
      sessionCookie: sessionIdFromCookie,
    });

    for (const key of mergeKeys) {
      await mergeAnonymousCampaignUnlocks(user.id, user.email, key);
    }

    if (sessionIdFromCookie) {
      await prisma.userSession.updateMany({
        where: { id: sessionIdFromCookie },
        data: {
          userId: user.id,
          lastSeenAt: new Date(),
        },
      });
    }

    await mergeAnonymousLessonProgress(user.id, sessionIdFromCookie);

    async function mergeAnonymousLessonProgress(
      userId: string,
      sessionId?: string | null,
    ) {
      if (!sessionId) return;

      const anonProgressRows = await prisma.lessonProgress.findMany({
        where: { sessionId },
        orderBy: { updatedAt: "desc" },
      });

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
      }

      await prisma.lessonProgress.deleteMany({
        where: { sessionId },
      });
    }

    return NextResponse.json({
      ok: true,
      message: "Email verified successfully.",
      user,
    });
  } catch {
    console.error("[auth/verify-email] Error", { outcome: "request_failed" });
    return NextResponse.json(
      { error: "An error occurred during verification." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  return withAuthNoStore(await handlePost(request));
}
