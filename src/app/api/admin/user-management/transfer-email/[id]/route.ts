import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import prisma from "@/lib/prisma";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { TRANSFER_VERIFICATION_TTL_MS } from "@/lib/auth/email-verification";
import {
  TransferEmailError,
  type TransferEmailErrorCode,
  transferUserEmail,
} from "@/lib/auth/transfer-email";

const ERROR_RESPONSES: Record<
  TransferEmailErrorCode,
  { status: number; message: string }
> = {
  INVALID_EMAIL: { status: 400, message: "Enter a valid email address." },
  SELF_TRANSFER: {
    status: 400,
    message: "You cannot transfer your own email; you would lock yourself out.",
  },
  ADMIN_TARGET: {
    status: 403,
    message: "Admin account emails cannot be transferred from this screen.",
  },
  PASSWORD_REQUIRED: {
    status: 400,
    message:
      "This account has no password, so it could not log in after the transfer.",
  },
  SAME_EMAIL: {
    status: 400,
    message: "The new email is the same as the current one.",
  },
  USER_NOT_FOUND: { status: 404, message: "User not found" },
  EMAIL_IN_USE: { status: 409, message: "Email already in use" },
};

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Access denied. Admins only." },
      { status: 403 },
    );
  }

  const { id } = await params;

  let body: { newEmail?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  let result: Awaited<ReturnType<typeof transferUserEmail>>;
  try {
    result = await transferUserEmail(prisma, {
      actingAdminId: session.user.id,
      targetUserId: id,
      newEmail: body?.newEmail,
    });
  } catch (error) {
    if (error instanceof TransferEmailError) {
      const mapped = ERROR_RESPONSES[error.code];
      return NextResponse.json(
        { error: mapped.message },
        { status: mapped.status },
      );
    }
    console.error("[admin/transfer-email][POST] Error", {
      outcome: "request_failed",
    });
    return NextResponse.json({ error: "Transfer failed" }, { status: 500 });
  }

  console.info("[admin/transfer-email]", {
    outcome: "transferred",
    adminId: session.user.id,
    userId: result.userId,
    oldDomain: result.oldEmail.split("@")[1],
    newDomain: result.newEmail.split("@")[1],
  });

  // The transfer is committed; a mail failure must not undo it. The new owner
  // can request another code from the verify page.
  let emailSent = true;
  try {
    const { sendEmailTransferVerificationEmail } = await import(
      "@/helpers/mailer"
    );
    await sendEmailTransferVerificationEmail({
      email: result.newEmail,
      name: result.name,
      code: result.code,
      expiresInHours: TRANSFER_VERIFICATION_TTL_MS / (60 * 60 * 1000),
    });
  } catch {
    emailSent = false;
    console.warn("[admin/transfer-email] OTP email delivery failed", {
      outcome: "delivery_failed",
    });
  }

  return NextResponse.json({
    data: { ok: true, emailSent, email: result.newEmail },
  });
}
