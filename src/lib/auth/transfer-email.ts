import type { PrismaClient } from "@prisma/client";
import { normalizeEmail } from "@/lib/email-validation";
import {
  issueEmailVerificationChallenge,
  TRANSFER_VERIFICATION_TTL_MS,
} from "@/lib/auth/email-verification";

export type TransferEmailErrorCode =
  | "INVALID_EMAIL"
  | "USER_NOT_FOUND"
  | "SAME_EMAIL"
  | "SELF_TRANSFER"
  | "ADMIN_TARGET"
  | "PASSWORD_REQUIRED"
  | "EMAIL_IN_USE";

export class TransferEmailError extends Error {
  constructor(public readonly code: TransferEmailErrorCode) {
    super(code);
    this.name = "TransferEmailError";
  }
}

/** Single normalisation used for the checks, the stored value and the OTP hash. */
export function normalizeTransferEmail(raw: unknown): string | null {
  return normalizeEmail(raw);
}

/**
 * Moves an account to a new login email in one transaction: the email changes,
 * the account becomes unverified, every existing session of this one user is
 * invalidated (sessionVersion + 1) and a fresh OTP challenge for the NEW
 * address replaces any older one. Sending the OTP email is the caller's job
 * and must happen after this resolves.
 */
export async function transferUserEmail(
  db: PrismaClient,
  input: { actingAdminId: string; targetUserId: string; newEmail: unknown },
) {
  const newEmail = normalizeTransferEmail(input.newEmail);
  if (!newEmail) throw new TransferEmailError("INVALID_EMAIL");

  if (input.actingAdminId === input.targetUserId) {
    throw new TransferEmailError("SELF_TRANSFER");
  }

  try {
    return await db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: input.targetUserId },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          password: true,
        },
      });

      if (!user) throw new TransferEmailError("USER_NOT_FOUND");
      if (user.role === "ADMIN") throw new TransferEmailError("ADMIN_TARGET");
      if (!user.password) throw new TransferEmailError("PASSWORD_REQUIRED");
      if (user.email.toLowerCase() === newEmail) {
        throw new TransferEmailError("SAME_EMAIL");
      }

      const taken = await tx.user.findFirst({
        where: { email: { equals: newEmail, mode: "insensitive" } },
        select: { id: true },
      });
      if (taken) throw new TransferEmailError("EMAIL_IN_USE");

      await tx.user.update({
        where: { id: user.id },
        data: {
          email: newEmail,
          isEmailVerified: false,
          emailVerifiedAt: null,
          sessionVersion: { increment: 1 },
        },
      });

      const challenge = await issueEmailVerificationChallenge(
        tx,
        user.id,
        newEmail,
        { welcomeEligible: false, ttlMs: TRANSFER_VERIFICATION_TTL_MS },
      );

      return {
        userId: user.id,
        name: user.name,
        oldEmail: user.email,
        newEmail,
        code: challenge.code,
        expires: challenge.expires,
      };
    });
  } catch (error) {
    if (
      (error as { code?: string } | null)?.code === "P2002" &&
      (error as { meta?: { target?: string[] } }).meta?.target?.includes("email")
    ) {
      throw new TransferEmailError("EMAIL_IN_USE");
    }
    throw error;
  }
}
