import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { sendInviteEmail } from "@/helpers/mailer";
// import { getBettermodeAccessToken } from "@/helpers/bettermodeToken";

// // Utility to send GraphQL calls to Bettermode
// async function graphqlFetch(body: object) {
//   const token = await getBettermodeAccessToken();

//   const res = await fetch(process.env.BETTERMODE_GRAPHQL_ENDPOINT!, {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       Authorization: `Bearer ${token}`,
//     },
//     body: JSON.stringify(body),
//   });

//   return res.json();
// }

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

    // 2. Update user as verified
    const user = await prisma.user.update({
      where: { id: verificationToken.userId },
      data: { isEmailVerified: true, emailVerifiedAt: new Date() },
    });

    // 3. If qrcodeID is present, send campaign invite link
    if (qrcodeID) {
      // Find QR code by qrCodeData or id, as per your usage
      const qr = await prisma.qRCode.findFirst({
        where: { qrCodeData: qrcodeID },
        include: {
          campaign: true,
          redeemedBy: true,
        },
      });

      if (qr && qr.campaign && qr.campaign.inviteUrl && qr.redeemedBy) {
        // // 3. If Bettermode ID is not already set, create user in Bettermode`;
        if (!user.bettermodeMemberId) {
          // Send invite to redeemedBy.email
          // await sendInviteEmail(
          //   qr.redeemedBy.email,
          //   qr.campaign.inviteUrl,
          //   qr.campaign.name
          // );

          try {
            const res = await fetch(
              "https://hooks.zapier.com/hooks/catch/24081094/u4aq3zt/",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "x-make-apikey": process.env.MAKE_WEBHOOK_KEY || "",
                },
                body: JSON.stringify({
                  message: "Email Verified!",
                  userEmail: user.email,
                  userName: user.name,
                }),
              }
            );

            console.log("Webhook response:", await res.text());

            if (res.ok) {
              console.log("Webhook triggered!");
            } else {
              console.error("Failed to trigger webhook:", res.statusText);
            }
          } catch (err) {
            console.error("Error triggering webhook:", err);
          }
        }

        // // 3. If Bettermode ID is not already set, create user in Bettermode
        // if (!user.bettermodeMemberId) {
        //   const generatedPassword = Math.random().toString(36).slice(2, 10); // temp password
        //   // 4. joinNetwork mutation
        //   const joinPayload = {
        //     query: `
        //   mutation JoinNetwork($input: JoinNetworkInput!) {
        //     joinNetwork(input: $input) {
        //       accessToken
        //       member {
        //         id
        //       }
        //     }
        //   }
        // `,
        //     variables: {
        //       input: {
        //         email: user.email,
        //         name: user.name || user.email.split("@")[0],
        //         password: generatedPassword,
        //       },
        //     },
        //   };
        //   const joinResult = await graphqlFetch(joinPayload);
        //   const memberId = joinResult?.data?.joinNetwork?.member?.id;
        //   if (!memberId) {
        //     console.error("JoinNetwork failed:", joinResult);
        //     return NextResponse.json(
        //       { error: "Failed to create member in Bettermode" },
        //       { status: 500 }
        //     );
        //   }
        //   // 5. Add to space
        //   const spaceId = process.env.BETTERMODE_SPACE_ID!;
        //   const addToSpacePayload = {
        //     query: `
        //   mutation AddToSpace($spaceId: ID!, $memberId: ID!) {
        //     addSpaceMembers(spaceId: $spaceId, input: { memberId: $memberId }) {
        //       member { email }
        //     }
        //   }
        // `,
        //     variables: { spaceId, memberId },
        //   };
        //   await graphqlFetch(addToSpacePayload);
        // // 6. Save Bettermode memberId in DB
        // await prisma.user.update({
        //   where: { id: user.id },
        //   data: { bettermodeMemberId: memberId },
        // });
        // }
      }
      // Optionally handle if QR not found or campaign/URL missing
      if (!qr?.campaign?.inviteUrl) {
        console.warn("QR code or campaign or invite URL missing");
      }
    }

    // 7. Clean up token
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
    console.error(
      "Stack trace:",
      error instanceof Error ? error.stack : "No stack trace available"
    );
    return NextResponse.json(
      { error: "An error occurred during verification" },
      { status: 500 }
    );
  }
}
