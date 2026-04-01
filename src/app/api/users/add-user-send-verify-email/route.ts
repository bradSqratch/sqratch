import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { sendInviteEmail } from "@/helpers/mailer";
import { awardQrScanPoint } from "@/lib/points";

export async function POST(request: NextRequest) {
  try {
    const reqBody = await request.json();
    const { name, email, qrCodeId, campaignId } = reqBody;

    if (!name || !email || !qrCodeId || !campaignId) {
      return NextResponse.json(
        { error: "Name, email, campaign and QR code are required." },
        { status: 400 },
      );
    }

    // 1. Validate QR code (must be NEW and correct campaign)
    const qr = await prisma.qRCode.findFirst({
      where: {
        qrCodeData: qrCodeId,
        campaignId,
        status: "NEW",
      },
      include: {
        campaign: true,
      },
    });

    if (!qr) {
      return NextResponse.json(
        { error: "Invalid or already redeemed QR code." },
        { status: 400 },
      );
    }

    // 2. Check if user already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      // Case: Email exists but not verified
      // if (!existingUser.isEmailVerified) {
      //   return NextResponse.json(
      //     {
      //       error:
      //         "Verify the email address first. (Check your email for a verification link from the QR code you scanned earlier)",
      //     },
      //     { status: 400 }
      //   );
      // }

      // Case: Email exists and is verified - send invite directly
      // Update QR code with existing user info
      await prisma.qRCode.update({
        where: { id: qr.id },
        data: {
          redeemedById: existingUser.id,
          email,
          status: "USED",
          usedAt: new Date(),
        },
      });

      // Send invite based on community type (logic from verify-email route)
      const { campaign } = qr;

      try {
        if (campaign?.inviteUrl && existingUser.email) {
          await sendInviteEmail(
            existingUser.email,
            campaign.inviteUrl,
            campaign.name,
          );
        }
      } catch (inviteError) {
        console.error("Failed to send invite:", inviteError);
        return NextResponse.json(
          {
            error:
              "QR code redeemed but failed to send invite. Please contact support.",
          },
          { status: 500 },
        );
      }

      // Add point for successful QR scan and invite sent (DIRECT_INVITE case)
      try {
        await awardQrScanPoint({
          userId: existingUser.id,
          qrCodeId: qr.id,
        });
      } catch (pointError) {
        console.error("Failed to add points:", pointError);
        // Don't fail the request if points can't be added
      }

      return NextResponse.json(
        { message: "Invite sent directly to your email!" },
        { status: 200 },
      );
    }

    // Case: Email doesn't exist - modified flow (skip verification, send invite directly)
    // Create new user
    const user = await prisma.user.create({
      data: {
        name,
        email,
        isEmailVerified: false,
        role: "EXTERNAL",
      },
    });

    // Update the QR code
    await prisma.qRCode.update({
      where: { id: qr.id },
      data: {
        redeemedById: user.id,
        email,
        status: "USED",
        usedAt: new Date(),
      },
    });

    // Send invite based on community type (same logic as existing user flow)
    const { campaign } = qr;

    try {
      if (campaign?.inviteUrl && user.email) {
        await sendInviteEmail(user.email, campaign.inviteUrl, campaign.name);
      }
    } catch (inviteError) {
      console.error("Failed to send invite:", inviteError);
      return NextResponse.json(
        {
          error:
            "QR code redeemed but failed to send invite. Please contact support.",
        },
        { status: 500 },
      );
    }

    // Add point for successful QR scan and invite sent (new user case)
    try {
      await awardQrScanPoint({
        userId: user.id,
        qrCodeId: qr.id,
      });
    } catch (pointError) {
      console.error("Failed to add points:", pointError);
      // Don't fail the request if points can't be added
    }

    return NextResponse.json(
      { message: "Invite sent directly to your email!" },
      { status: 200 },
    );
  } catch (error) {
    console.error("Signup with QR error:", error);
    return NextResponse.json(
      { error: "Server error. Please try again." },
      { status: 500 },
    );
  }
}
