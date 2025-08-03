import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import crypto from "crypto";
import { sendVerificationEmail } from "@/helpers/mailer";

export async function POST(request: NextRequest) {
  try {
    const reqBody = await request.json();
    const { name, email, qrCodeId, campaignId } = reqBody;

    if (!name || !email || !qrCodeId || !campaignId) {
      return NextResponse.json(
        { error: "Name, email, campaign and QR code are required." },
        { status: 400 }
      );
    }

    // 1. Validate QR code (must be NEW and correct campaign)
    const qr = await prisma.qRCode.findFirst({
      where: {
        qrCodeData: qrCodeId, // Make sure qrCodeId is the qrCodeData (random part)
        campaignId: campaignId,
        status: "NEW",
      },
    });

    if (!qr) {
      return NextResponse.json(
        { error: "Invalid or already redeemed QR code." },
        { status: 400 }
      );
    }

    // 2. Find or create user
    let user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      // If user doesn't exist, create a new one
      user = await prisma.user.create({
        data: {
          name,
          email,
          isEmailVerified: false,
        },
      });
    }

    // 3. Update the QR code with redeemedById, email, and status "USED"
    await prisma.qRCode.update({
      where: { id: qr.id },
      data: {
        redeemedById: user.id,
        email,
        status: "USED",
        usedAt: new Date(),
      },
    });

    // 4. Generate verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 48 * 60 * 60 * 1000);

    await prisma.emailVerificationToken.create({
      data: {
        userId: user.id,
        emailVerifyToken: verificationToken,
        expires,
      },
    });

    // 5. Send verification email (include qrCodeId in the link)
    await sendVerificationEmail(email, verificationToken, qrCodeId);

    return NextResponse.json(
      { message: "Check your email to verify & complete redemption!" },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("Signup with QR error:", err);
    return NextResponse.json(
      { error: "Server error. Please try again." },
      { status: 500 }
    );
  }
}
