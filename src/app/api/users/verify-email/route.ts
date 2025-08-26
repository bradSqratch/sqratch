// src/app/api/verify-email/route.ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { sendInviteEmail } from "@/helpers/mailer";

async function createDiscordOneTimeInvite(): Promise<string> {
  const token = process.env.DISCORD_BOT_TOKEN; // Bot token
  const channelId = process.env.DISCORD_CHANNEL_ID; // Text channel ID to create invites from
  if (!token || !channelId) {
    throw new Error("DISCORD_BOT_TOKEN or DISCORD_CHANNEL_ID not set");
  }

  // Discord API: POST /channels/{channel.id}/invites
  const res = await fetch(
    `https://discord.com/api/v10/channels/${channelId}/invites`,
    {
      method: "POST",
      headers: {
        Authorization: `Bot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        max_uses: 1, // single-use
        max_age: 172800, // 2 days (in seconds)
        temporary: false, // true = kicks user when they disconnect; usually false
        unique: true, // force a unique code
      }),
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord invite creation failed: ${res.status} ${text}`);
  }

  const json = (await res.json()) as { code: string };
  // standard invite URL form:
  return `https://discord.gg/${json.code}`;
}

export async function POST(request: NextRequest) {
  try {
    const { emailVerifyToken, qrcodeID } = (await request.json()) as {
      emailVerifyToken?: string;
      qrcodeID?: string;
    };

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

    // 3) Branching by community
    if (qrcodeID) {
      const qr = await prisma.qRCode.findFirst({
        where: { qrCodeData: qrcodeID },
        include: {
          campaign: {
            include: {
              community: true,
            },
          },
          redeemedBy: true,
        },
      });

      // console.log("[verify-email] qrcodeID:", qrcodeID);
      // console.log("[verify-email] qr found:", Boolean(qr));
      // console.log("[verify-email] campaign found:", Boolean(qr?.campaign));
      // console.log("[verify-email] inviteUrl:", qr?.campaign?.inviteUrl);
      // console.log("[verify-email] community:", qr?.campaign?.community);
      // console.log(
      //   "[verify-email] community.type:",
      //   qr?.campaign?.community?.type
      // );

      if (!qr) {
        console.warn("[verify-email] QR not found for qrcodeID:", qrcodeID);
      } else if (qr.campaign) {
        const { campaign } = qr;

        // normalize to a concrete value we can switch on
        const communityType = campaign.community?.type ?? "GENERIC";

        switch (communityType) {
          case "BETTERMODE": {
            console.log("[verify-email] Branch: BETTERMODE");
            const hook = process.env.ZAPIER_WEBHOOK_URL;
            if (!hook) {
              console.error("[verify-email] ZAPIER_WEBHOOK_URL is not set");
              break;
            }
            try {
              const payload = {
                action: "EMAIL_VERIFIED",
                source: "nextjs",
                userEmail: user.email,
                userName: user.name,
                campaignName: campaign.name,
                inviteUrl: campaign.inviteUrl,
                qrcodeID,
              };
              const res = await fetch(hook, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
              });
              const text = await res.text();
              console.log(
                "[verify-email] Zapier webhook status:",
                res.status,
                text
              );
              if (!res.ok)
                console.error(
                  "[verify-email] Zapier webhook failed:",
                  res.status,
                  text
                );
            } catch (err) {
              console.error("[verify-email] Zapier error:", err);
            }
            break;
          }

          case "DISCORD": {
            try {
              // 1) create a single-use invite link
              const oneTimeInviteUrl = await createDiscordOneTimeInvite();

              // 2) email it to the user (reuses your existing helper)
              if (user.email) {
                await sendInviteEmail(
                  user.email,
                  oneTimeInviteUrl,
                  campaign.name
                );
              }
            } catch (e) {
              console.error("Discord invite flow failed:", e);
            }
            break;
          }

          case "GENERIC": // explicit case (in addition to default)
          default: {
            console.log("[verify-email] Branch: DEFAULT/GENERIC");
            if (campaign.inviteUrl && user.email) {
              try {
                await sendInviteEmail(
                  user.email,
                  campaign.inviteUrl,
                  campaign.name
                );
                console.log("[verify-email] Invite email sent successfully");
              } catch (err) {
                console.error("[verify-email] Invite email send failed:", err);
              }
            } else {
              console.warn(
                "[verify-email] No inviteUrl or user.email; campaignId:",
                campaign.id
              );
            }
            break;
          }
        }
      }
    }

    // 4) Cleanup token
    await prisma.emailVerificationToken.delete({
      where: { id: verificationToken.id },
    });

    return NextResponse.json({ message: "Email verified successfully" });
  } catch (error) {
    console.error("[verify-email] Error:", error);
    return NextResponse.json(
      { error: "An error occurred during verification" },
      { status: 500 }
    );
  }
}
