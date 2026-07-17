import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import bcryptjs from "bcryptjs";
import { rateLimit, getRequestIp, rateLimitResponse } from "@/lib/rate-limit";
import { issueEmailVerificationChallenge } from "@/lib/auth/email-verification";
import { PASSWORD_POLICY_MESSAGE, validatePassword } from "@/lib/password-policy";

type RequestedRole = "CREATOR" | "BRAND" | null;

function optionalString(value: unknown) {
  return typeof value === "string" ? value : "";
}

export async function POST(request: NextRequest) {
  try {
    const ip = getRequestIp(request);
    const rl = rateLimit(`signup:${ip}`, 5, 15 * 60 * 1000);
    if (!rl.success) {
      return rateLimitResponse(rl.resetAt);
    }

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
      application?: Record<string, unknown>;
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

    if (validatePassword(cleanPassword)) {
      return NextResponse.json(
        { error: PASSWORD_POLICY_MESSAGE },
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

    const salt = await bcryptjs.genSalt(12);
    const hashedPassword = await bcryptjs.hash(cleanPassword, salt);

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
              displayName: optionalString(application?.displayName) || cleanName,
              websiteOrSocial: optionalString(application?.websiteOrSocial),
              shortReason: optionalString(application?.shortReason),
            }),
          },
        });
      }

      if (requestedRole === "BRAND") {
        await tx.brandRequest.create({
          data: {
            userId: user.id,
            status: "PENDING",
            proposedBrandName: optionalString(application?.brandName) || null,
            proposedStoreUrl: optionalString(application?.website) || null,
            reason: JSON.stringify({
              shopifyDomain: optionalString(application?.shopifyDomain),
              shortGoal: optionalString(application?.shortGoal),
            }),
          },
        });
      }

      const challenge = await issueEmailVerificationChallenge(
        tx,
        user.id,
        normalizedEmail,
        {
          welcomeEligible: requestedRole == null,
        },
      );

      return { user, code: challenge.code };
    });

    // Best-effort email sending.
    // Replace this with your exact mailer helper if needed.
    try {
      const { sendVerificationEmail } = await import("@/helpers/mailer");
      await sendVerificationEmail(normalizedEmail, created.code);
    } catch {
      console.warn("[auth/signup] Verification email delivery failed", {
        outcome: "delivery_failed",
      });
    }

    return NextResponse.json(
      {
        ok: true,
        message: "Signup successful. Please verify your email.",
        email: created.user.email,
      },
      { status: 201 }
    );
  } catch {
    console.error("[auth/signup] Error", { outcome: "request_failed" });
    return NextResponse.json(
      { error: "An error occurred during signup." },
      { status: 500 }
    );
  }
}
