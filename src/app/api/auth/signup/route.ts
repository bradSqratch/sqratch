import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import bcryptjs from "bcryptjs";

type RequestedRole = "CREATOR" | "BRAND" | null;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      name,
      email,
      password,
      requestedRole,
      application,
    }: {
      name?: string;
      email?: string;
      password?: string;
      requestedRole?: RequestedRole;
      application?: Record<string, any>;
    } = body;

    const normalizedEmail = String(email || "")
      .trim()
      .toLowerCase();
    const cleanName = String(name || "").trim();
    const cleanPassword = String(password || "");

    if (!normalizedEmail || !cleanPassword) {
      return NextResponse.json(
        { error: "Email and password are required." },
        { status: 400 }
      );
    }

    if (!cleanName) {
      return NextResponse.json(
        { error: "Name is required." },
        { status: 400 }
      );
    }

    if (cleanPassword.length < 6) {
      return NextResponse.json(
        { error: "Password must be at least 6 characters." },
        { status: 400 }
      );
    }

    if (
      requestedRole !== null &&
      requestedRole !== undefined &&
      requestedRole !== "CREATOR" &&
      requestedRole !== "BRAND"
    ) {
      return NextResponse.json(
        { error: "Invalid requested role." },
        { status: 400 }
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "Email is already registered." },
        { status: 409 }
      );
    }

    const salt = await bcryptjs.genSalt(10);
    const hashedPassword = await bcryptjs.hash(cleanPassword, salt);

    const otpCode = generateOtp();
    const expires = new Date(Date.now() + 10 * 60 * 1000);

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: cleanName,
          email: normalizedEmail,
          password: hashedPassword,
          role: "USER",
          isEmailVerified: false,
          isActive: true,
        },
      });

      if (requestedRole === "CREATOR") {
        await tx.creatorRequest.create({
          data: {
            userId: user.id,
            status: "PENDING",
            reason: JSON.stringify({
              displayName: application?.displayName || cleanName,
              websiteOrSocial: application?.websiteOrSocial || "",
              shortReason: application?.shortReason || "",
            }),
          },
        });
      }

      if (requestedRole === "BRAND") {
        await tx.brandRequest.create({
          data: {
            userId: user.id,
            status: "PENDING",
            proposedBrandName: application?.brandName || null,
            proposedStoreUrl: application?.website || null,
            reason: JSON.stringify({
              shopifyDomain: application?.shopifyDomain || "",
              shortGoal: application?.shortGoal || "",
            }),
          },
        });
      }

      await tx.emailVerificationToken.deleteMany({
        where: { userId: user.id },
      });

      await tx.emailVerificationToken.create({
        data: {
          userId: user.id,
          emailVerifyToken: otpCode,
          expires,
        },
      });

      return user;
    });

    // Best-effort email sending.
    // Replace this with your exact mailer helper if needed.
    try {
      const mailer = await import("@/helpers/mailer");
      if (typeof (mailer as any).sendVerificationEmail === "function") {
        await (mailer as any).sendVerificationEmail(normalizedEmail, otpCode);
      } else {
        console.warn(
          "[auth/signup] sendVerificationEmail helper not found. OTP created but not emailed."
        );
      }
    } catch (mailError) {
      console.warn("[auth/signup] Failed to send verification email:", mailError);
    }

    return NextResponse.json(
      {
        ok: true,
        message: "Signup successful. Please verify your email.",
        email: created.email,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[auth/signup] Error:", error);
    return NextResponse.json(
      { error: "An error occurred during signup." },
      { status: 500 }
    );
  }
}