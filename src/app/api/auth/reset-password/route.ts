import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { withAuthNoStore } from "@/lib/auth/auth-response";
import { resetPasswordWithToken } from "@/lib/auth/password-reset";
import { getRequestIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit";

const WINDOW_MS = 15 * 60 * 1000;
const PER_IP_LIMIT = 10;

/** Same answer for unknown, expired, used and malformed tokens. */
export const RESET_LINK_INVALID_MESSAGE =
  "This reset link is invalid or has expired. Request a new one.";

export type ResetPasswordDeps = {
  db: typeof prisma;
  rateLimit: typeof rateLimit;
  now?: () => Date;
};

export async function POST(request: NextRequest) {
  return withAuthNoStore(await resetPasswordImpl(request, { db: prisma, rateLimit }));
}

export async function resetPasswordImpl(request: NextRequest, deps: ResetPasswordDeps) {
  const ipLimit = deps.rateLimit(`reset-password:ip:${getRequestIp(request)}`, PER_IP_LIMIT, WINDOW_MS);
  if (!ipLimit.success) return rateLimitResponse(ipLimit.resetAt);

  let body: { token?: unknown; password?: unknown; confirmPassword?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: RESET_LINK_INVALID_MESSAGE }, { status: 400 });
  }

  const password = typeof body?.password === "string" ? body.password : "";
  if (body?.confirmPassword !== undefined && body.confirmPassword !== password) {
    return NextResponse.json({ error: "Passwords do not match." }, { status: 400 });
  }

  try {
    const outcome = await resetPasswordWithToken(
      deps.db,
      { token: body?.token, newPassword: password },
      deps.now?.(),
    );
    if (outcome.status === "weak_password") {
      return NextResponse.json({ error: outcome.message }, { status: 400 });
    }
    if (outcome.status === "invalid") {
      return NextResponse.json({ error: RESET_LINK_INVALID_MESSAGE }, { status: 400 });
    }
    return NextResponse.json({ data: { success: true } });
  } catch {
    console.error("[auth/reset-password] Error", { outcome: "request_failed" });
    return NextResponse.json({ error: "Failed to reset password." }, { status: 500 });
  }
}
