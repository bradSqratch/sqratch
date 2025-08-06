// pages/api/auth/send-verification.ts
import prisma from "@/lib/prisma";
import { sendVerificationEmail } from "@/helpers/mailer";
import { NextResponse } from "next/server";
import crypto from "crypto";

export async function POST(req: Request) {
  try {
    const { email } = await req.json();

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    if (user.isEmailVerified) {
      return NextResponse.json(
        { error: "Email already verified." },
        { status: 400 }
      );
    }

    // 1. Delete existing verification tokens for this user
    await prisma.emailVerificationToken.deleteMany({
      where: { userId: user.id },
    });

    // 2. Generate new token and expiry
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours

    // 3. Save new token
    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        emailVerifyToken: verificationToken,
        expires,
      },
    });

    // 4. Send email
    await sendVerificationEmail(email, verificationToken);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Resend error:", error);
    return NextResponse.json(
      { error: "Something went wrong." },
      { status: 500 }
    );
  }
}
