import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function POST(request: NextRequest) {
  try {
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
      const mailer = await import("@/helpers/mailer");

      if (typeof (mailer as any).sendVerificationEmail === "function") {
        await (mailer as any).sendVerificationEmail(email, otpCode);
      } else {
        console.warn(
          "[auth/send-email-verification] sendVerificationEmail helper not found.",
        );
      }
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
