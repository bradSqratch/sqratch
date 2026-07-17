import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { rateLimit, getRequestIp, rateLimitResponse } from "@/lib/rate-limit";
import { issueEmailVerificationChallenge } from "@/lib/auth/email-verification";
import { withAuthNoStore } from "@/lib/auth/auth-response";

async function handlePost(request: NextRequest) {
  try {
    const ip = getRequestIp(request);
    const rl = rateLimit(`send-verify-email:${ip}`, 5, 15 * 60 * 1000);
    if (!rl.success) {
      return rateLimitResponse(rl.resetAt);
    }

    const body = await request.json();
    const email = String(body?.email || "")
      .trim()
      .toLowerCase();

    if (!email) {
      return NextResponse.json(
        { error: "Email is required." },
        { status: 400 },
      );
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        isEmailVerified: true,
      },
    });

    if (user && !user.isEmailVerified) {
      try {
        const challenge = await prisma.$transaction(async (tx) => {
          const previousChallenge =
            await tx.emailVerificationToken.findFirst({
              where: { userId: user.id },
              orderBy: { createdAt: "desc" },
              select: { welcomeEligible: true },
            });

          return issueEmailVerificationChallenge(
            tx,
            user.id,
            user.email,
            {
              welcomeEligible:
                previousChallenge?.welcomeEligible ?? false,
            },
          );
        });
        const { sendVerificationEmail } = await import("@/helpers/mailer");
        await sendVerificationEmail(email, challenge.code);
      } catch {
        console.warn("[auth/send-email-verification] challenge delivery failed", {
          outcome: "delivery_failed",
        });
      }
    }

    return NextResponse.json({
      ok: true,
      message: "If an account needs verification, a code will be sent.",
    });
  } catch {
    console.error("[auth/send-email-verification] Error", {
      outcome: "request_failed",
    });
    return NextResponse.json(
      { error: "Failed to send verification code." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  return withAuthNoStore(await handlePost(request));
}
