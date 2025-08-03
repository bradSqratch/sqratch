import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { sendInviteEmail } from "@/helpers/mailer";

export async function POST(request: NextRequest) {
  try {
    const { emailVerifyToken, qrcodeID } = await request.json();
    if (!emailVerifyToken || typeof emailVerifyToken !== "string") {
      return NextResponse.json(
        { error: "Invalid or missing token" },
        { status: 400 }
      );
    }
    const verificationToken = await prisma.emailVerificationToken.findFirst({
      where: { emailVerifyToken },
    });
    console.log("verification token", verificationToken);

    if (!verificationToken) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 400 }
      );
    }
    console.log("verification expires", verificationToken.expires);

    if (!verificationToken.expires || verificationToken.expires < new Date()) {
      return NextResponse.json({ error: "Token has expired" }, { status: 400 });
    }

    await prisma.user.update({
      where: { id: verificationToken.userId },
      data: { isEmailVerified: true, emailVerifiedAt: new Date() },
    });

    // 3. If qrcodeID is present, send campaign invite link
    if (qrcodeID) {
      // Find QR code by qrCodeData or id, as per your usage
      const qr = await prisma.qRCode.findFirst({
        where: {
          OR: [{ id: qrcodeID }, { qrCodeData: qrcodeID }],
        },
        include: {
          campaign: true,
          redeemedBy: true,
        },
      });

      if (qr && qr.campaign && qr.campaign.inviteUrl && qr.redeemedBy) {
        // Send invite to redeemedBy.email
        await sendInviteEmail(
          qr.redeemedBy.email,
          qr.campaign.inviteUrl,
          qr.campaign.name
        );
      }
      // Optionally handle if QR not found or campaign/URL missing
    }

    await prisma.emailVerificationToken.delete({
      where: { id: verificationToken.id },
    });

    return NextResponse.json({ message: "Email verified successfully" });
  } catch (error) {
    if (error instanceof Error) {
      // This ensures we handle it as an error object
      console.error("Error verifying email:", error.message);
    } else {
      // In case the error isn't an instance of Error
      console.error("Error verifying email:", error);
    }
    return NextResponse.json(
      { error: "An error occurred during verification" },
      { status: 500 }
    );
  }
}
