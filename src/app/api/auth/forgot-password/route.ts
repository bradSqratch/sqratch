import crypto from "node:crypto";
import { NextRequest, NextResponse, after } from "next/server";
import prisma from "@/lib/prisma";
import { withAuthNoStore } from "@/lib/auth/auth-response";
import { issuePasswordResetToken } from "@/lib/auth/password-reset";
import { normalizeEmail } from "@/lib/email-validation";
import { getRequestIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_LIMIT = 5;
const PER_EMAIL_LIMIT = 3;

/** Identical for every outcome so the response never reveals whether an account exists. */
export const FORGOT_PASSWORD_MESSAGE =
  "If an account exists for that email address, we have sent a link to reset the password.";

export type ForgotPasswordDeps = {
  db: typeof prisma;
  rateLimit: typeof rateLimit;
  sendResetEmail: (input: { email: string; name: string | null; token: string }) => Promise<void>;
  /** Runs the account lookup and mail delivery after the response is sent. */
  runAfterResponse: (task: () => Promise<void>) => void;
};

export async function POST(request: NextRequest) {
  return withAuthNoStore(
    await forgotPasswordImpl(request, {
      db: prisma,
      rateLimit,
      sendResetEmail: async (input) => {
        const { sendPasswordResetEmail } = await import("@/helpers/mailer");
        await sendPasswordResetEmail(input);
      },
      runAfterResponse: (task) => after(task),
    }),
  );
}

export async function forgotPasswordImpl(request: NextRequest, deps: ForgotPasswordDeps) {
  const ip = getRequestIp(request);
  const ipLimit = deps.rateLimit(`forgot-password:ip:${ip}`, PER_IP_LIMIT, WINDOW_MS);
  if (!ipLimit.success) return rateLimitResponse(ipLimit.resetAt);

  let body: { email?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Enter your email address." }, { status: 400 });
  }
  const email = normalizeEmail(body?.email);
  if (!email) {
    return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
  }

  const emailKey = crypto.createHash("sha256").update(email).digest("hex");
  const emailLimit = deps.rateLimit(`forgot-password:email:${emailKey}`, PER_EMAIL_LIMIT, WINDOW_MS);

  // Over the per-address limit the answer stays the same; nothing is sent. The
  // work happens after the response, so timing does not depend on the account.
  if (emailLimit.success) {
    deps.runAfterResponse(async () => {
      try {
        const user = await deps.db.user.findUnique({
          where: { email },
          select: { id: true, email: true, name: true, isActive: true },
        });
        if (!user || !user.isActive) return;
        const { token } = await issuePasswordResetToken(deps.db, user.id);
        await deps.sendResetEmail({ email: user.email, name: user.name, token });
      } catch {
        console.warn("[auth/forgot-password] delivery failed", { outcome: "request_failed" });
      }
    });
  }

  return NextResponse.json({ data: { message: FORGOT_PASSWORD_MESSAGE } });
}
