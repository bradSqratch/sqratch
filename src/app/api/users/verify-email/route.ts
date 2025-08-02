import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function POST(request: NextRequest) {
  try {
    const { emailVerifyToken } = await request.json();
    console.log("emailVerifyToken", emailVerifyToken);
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
