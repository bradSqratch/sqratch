import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const { emailVerifyToken, qrcodeID } = await request.json();

    if (!emailVerifyToken || typeof emailVerifyToken !== "string") {
      return NextResponse.json(
        { error: "Invalid or missing token" },
        { status: 400 }
      );
    }

    // 1) Find token
    const verificationToken = await prisma.emailVerificationToken.findFirst({
      where: { emailVerifyToken },
    });
    if (!verificationToken) {
      return NextResponse.json(
        { error: "Invalid or expired token" },
        { status: 400 }
      );
    }
    if (!verificationToken.expires || verificationToken.expires < new Date()) {
      return NextResponse.json({ error: "Token has expired" }, { status: 400 });
    }

    // 2) Update user as verified
    const user = await prisma.user.update({
      where: { id: verificationToken.userId },
      data: { isEmailVerified: true, emailVerifiedAt: new Date() },
    });

    // 3) If qrcodeID present, look up QR & campaign
    if (qrcodeID) {
      const qr = await prisma.qRCode.findFirst({
        where: { qrCodeData: qrcodeID },
        include: {
          campaign: true,
          redeemedBy: true,
        },
      });

      if (!qr) {
        console.warn("QR not found for qrcodeID:", qrcodeID);
      }

      // If campaign + inviteUrl exist, notify Zapier with all the context
      if (qr?.campaign?.inviteUrl) {
        try {
          const payload = {
            action: "EMAIL_VERIFIED", // handy for Zapier Paths
            message: "Email Verified!",
            source: "nextjs",
            // userId: user.id,
            userEmail: user.email,
            userName: user.name,
            // bettermodeMemberId: user.bettermodeMemberId || null,

            // QR/Campaign context
            // qrcodeID,           // what your app sent us (same as qr.qrCodeData)
            // qrCodeData: qr.qrCodeData,
            // campaignId: qr.campaign.id,
            campaignName: qr.campaign.name,
            inviteUrl: qr.campaign.inviteUrl,

            // Optional: who redeemed the QR (if you track it)
            // redeemedById: qr.redeemedById || null,
            // redeemedByEmail: qr.redeemedBy?.email || null,
          };

          const res = await fetch(process.env.ZAPIER_WEBHOOK_URL || "", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });

          const text = await res.text();
          console.log("Zapier webhook status:", res.status, text);

          if (!res.ok) {
            console.error("Zapier webhook failed:", res.status, text);
          }
        } catch (err) {
          console.error("Error posting to Zapier webhook:", err);
        }
      } else {
        console.warn(
          "No campaign invite URL available for qrcodeID:",
          qrcodeID
        );
      }
    }

    // 4) Cleanup token
    await prisma.emailVerificationToken.delete({
      where: { id: verificationToken.id },
    });

    return NextResponse.json({ message: "Email verified successfully" });
  } catch (error) {
    console.error("Error verifying email:", error);
    return NextResponse.json(
      { error: "An error occurred during verification" },
      { status: 500 }
    );
  }
}
