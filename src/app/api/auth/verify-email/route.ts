import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { cookies } from "next/headers";

async function mergeAnonymousCampaignUnlocks(
  userId: string,
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
      data: {
        userId,
      },
    });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      email,
      code,
      token,
      anonKey: bodyAnonKey,
    }: {
      email?: string;
      code?: string;
      token?: string;
      anonKey?: string;
    } = body || {};

    let verificationToken = null;

    if (token) {
      verificationToken = await prisma.emailVerificationToken.findFirst({
        where: {
          emailVerifyToken: token,
        },
      });
    } else {
      const normalizedEmail = String(email || "")
        .trim()
        .toLowerCase();
      const cleanCode = String(code || "").trim();

      if (!normalizedEmail || !cleanCode) {
        return NextResponse.json(
          { error: "Email and code are required." },
          { status: 400 },
        );
      }

      const user = await prisma.user.findUnique({
        where: { email: normalizedEmail },
        select: { id: true, email: true },
      });

      if (!user) {
        return NextResponse.json({ error: "User not found." }, { status: 404 });
      }

      verificationToken = await prisma.emailVerificationToken.findFirst({
        where: {
          userId: user.id,
          emailVerifyToken: cleanCode,
        },
      });
    }

    if (!verificationToken) {
      return NextResponse.json(
        { error: "Invalid or expired verification code." },
        { status: 400 },
      );
    }

    if (verificationToken.expires < new Date()) {
      return NextResponse.json(
        { error: "Verification code has expired." },
        { status: 400 },
      );
    }

    const user = await prisma.user.update({
      where: { id: verificationToken.userId },
      data: {
        isEmailVerified: true,
        emailVerifiedAt: new Date(),
      },
      select: {
        id: true,
        email: true,
      },
    });

    const cookieStore = await cookies();
    const anonKeyFromCookie =
      cookieStore.get("anonKey")?.value ||
      cookieStore.get("deviceKey")?.value ||
      null;

    const sessionIdFromCookie = cookieStore.get("sqr_session")?.value || null;

    await mergeAnonymousCampaignUnlocks(
      user.id,
      bodyAnonKey || anonKeyFromCookie,
    );

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

    await prisma.emailVerificationToken.deleteMany({
      where: { userId: user.id },
    });

    return NextResponse.json({
      ok: true,
      message: "Email verified successfully.",
      user,
    });
  } catch (error) {
    console.error("[auth/verify-email] Error:", error);
    return NextResponse.json(
      { error: "An error occurred during verification." },
      { status: 500 },
    );
  }
}
