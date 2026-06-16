import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { rateLimit, getRequestIp, rateLimitResponse } from "@/lib/rate-limit";

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function POST(request: NextRequest) {
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

    if (!user) {
      return NextResponse.json(
        { error: "No user found with this email." },
        { status: 404 },
      );
    }

    if (user.isEmailVerified) {
      return NextResponse.json(
        { error: "Email is already verified." },
        { status: 400 },
      );
    }

    const otpCode = generateOtp();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    await prisma.emailVerificationToken.deleteMany({
      where: { userId: user.id },
    });

    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        emailVerifyToken: otpCode,
        expires,
      },
    });

    try {
      const { sendVerificationEmail } = await import("@/helpers/mailer");
      await sendVerificationEmail(email, otpCode);
    } catch (mailError) {
      console.warn(
        "[auth/send-email-verification] Failed to send verification email:",
        mailError,
      );
    }

    return NextResponse.json({
      ok: true,
      message: "Verification code sent successfully.",
    });
  } catch (error) {
    console.error("[auth/send-email-verification] Error:", error);
    return NextResponse.json(
      { error: "Failed to send verification code." },
      { status: 500 },
    );
  }
}
