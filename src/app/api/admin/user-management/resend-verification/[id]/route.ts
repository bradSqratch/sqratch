import { NextResponse } from "next/server";
import { withAuthNoStore } from "@/lib/auth/auth-response";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { issueEmailVerificationChallenge } from "@/lib/auth/email-verification";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const WINDOW_MS = 15 * 60 * 1000;
const PER_TARGET_LIMIT = 3;
const PER_ADMIN_LIMIT = 20;

export type ResendVerificationDeps = {
  getSession: () => Promise<{ user?: { id?: string | null; role?: string | null } } | null>;
  db: typeof prisma;
  sendVerificationEmail: (email: string, code: string) => Promise<void>;
  rateLimit: typeof rateLimit;
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuthNoStore(await resendVerificationImpl(request, params, {
    getSession: () => getServerSession(authOptions),
    db: prisma,
    sendVerificationEmail: async (email, code) => {
      const { sendVerificationEmail } = await import("@/helpers/mailer");
      await sendVerificationEmail(email, code);
    },
    rateLimit,
  }));
}

/**
 * Administrator-only: issue a fresh verification challenge for an unverified
 * account and mail it. The new challenge replaces any earlier one, so a failed
 * delivery can simply be retried. Verified accounts are refused.
 */
export async function resendVerificationImpl(
  _request: Request,
  params: Promise<{ id: string }>,
  deps: ResendVerificationDeps,
) {
  const session = await deps.getSession();
  const adminId = session?.user?.id;
  if (!adminId || session?.user?.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { id } = await params;

  const perAdmin = deps.rateLimit(`admin-resend-verify-admin:${adminId}`, PER_ADMIN_LIMIT, WINDOW_MS);
  if (!perAdmin.success) return rateLimitResponse(perAdmin.resetAt);
  const perTarget = deps.rateLimit(`admin-resend-verify:${id}`, PER_TARGET_LIMIT, WINDOW_MS);
  if (!perTarget.success) return rateLimitResponse(perTarget.resetAt);

  try {
    const user = await deps.db.user.findUnique({
      where: { id },
      select: { id: true, email: true, isEmailVerified: true, isActive: true },
    });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }
    if (user.isEmailVerified) {
      return NextResponse.json(
        { error: "This email address is already verified." },
        { status: 409 },
      );
    }

    if (!user.isActive) {
      return NextResponse.json({ error: "This account is deactivated." }, { status: 409 });
    }

    const challenge = await deps.db.$transaction(async (tx) => {
      // Replacing the challenge must not drop a self-signup's welcome eligibility.
      const previous = await tx.emailVerificationToken.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        select: { welcomeEligible: true },
      });
      return issueEmailVerificationChallenge(tx, user.id, user.email, {
        welcomeEligible: previous?.welcomeEligible ?? false,
      });
    });

    let emailSent = true;
    try {
      await deps.sendVerificationEmail(user.email, challenge.code);
    } catch {
      emailSent = false;
      console.warn("[admin/resend-verification] Email delivery failed", {
        outcome: "delivery_failed",
      });
    }

    return NextResponse.json({ data: { ok: true, emailSent } });
  } catch {
    console.error("[admin/resend-verification] Error", { outcome: "request_failed" });
    return NextResponse.json({ error: "Failed to resend verification email." }, { status: 500 });
  }
}
