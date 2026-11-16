import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { validatePassword } from "@/lib/password-policy";

/** Reset links are short-lived and single use. */
export const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;
const TOKEN_BYTES = 32;
const BCRYPT_COST = 12;

function getPepper() {
  // Same server secret as the email verification codes; the domain prefix in
  // the HMAC input keeps the two hash spaces apart.
  const pepper = process.env.EMAIL_VERIFICATION_CODE_PEPPER?.trim();
  if (!pepper) throw new Error("EMAIL_VERIFICATION_CODE_PEPPER is not configured");
  return pepper;
}

export function generatePasswordResetToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

/** Tokens are 32 random bytes, base64url encoded: always 43 characters. */
export function isWellFormedResetToken(token: unknown): token is string {
  return typeof token === "string" && /^[A-Za-z0-9_-]{43}$/.test(token);
}

export function hashPasswordResetToken(token: string) {
  return crypto
    .createHmac("sha256", getPepper())
    .update(`sqratch-password-reset:v1:${token}`)
    .digest("hex");
}

/**
 * Issues a fresh reset token for the user and removes their earlier ones.
 * The user row is touched first so concurrent requests for the same account
 * run one after another and exactly one token survives.
 */
export async function issuePasswordResetToken(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<{ token: string; expires: Date }> {
  const token = generatePasswordResetToken();
  const tokenHash = hashPasswordResetToken(token);
  const expires = new Date(now.getTime() + PASSWORD_RESET_TTL_MS);

  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { updatedAt: now } });
    await tx.passwordResetToken.deleteMany({ where: { userId } });
    await tx.passwordResetToken.create({ data: { userId, tokenHash, expires } });
  });

  return { token, expires };
}

export type PasswordResetOutcome =
  | { status: "reset" }
  | { status: "invalid" }
  | { status: "weak_password"; message: string };

/**
 * Consumes a reset token and sets the new password in one transaction.
 *
 * The token is claimed with a conditional update (`consumedAt IS NULL` and not
 * expired) whose count must be exactly 1, so two simultaneous submissions of the
 * same token change the password once. The password hash, the session version
 * increment (which signs out every existing session) and the removal of the
 * account's other reset tokens commit together with the claim. Unknown, expired,
 * consumed or inactive-account tokens all return the same `invalid` outcome.
 */
export async function resetPasswordWithToken(
  db: PrismaClient,
  input: { token: unknown; newPassword: string },
  now: Date = new Date(),
): Promise<PasswordResetOutcome> {
  const policyError = validatePassword(input.newPassword);
  if (policyError) return { status: "weak_password", message: policyError };

  if (!isWellFormedResetToken(input.token)) return { status: "invalid" };
  const tokenHash = hashPasswordResetToken(input.token);

  // Cheap read first: bcrypt (about 250 ms) runs only for a token that currently
  // looks usable, so junk requests cannot spend CPU. The transaction below
  // re-checks everything under lock.
  const candidate = await db.passwordResetToken.findUnique({
    where: { tokenHash },
    select: { consumedAt: true, expires: true, user: { select: { isActive: true } } },
  });
  if (!candidate || candidate.consumedAt || candidate.expires <= now || !candidate.user.isActive) {
    return { status: "invalid" };
  }
  const passwordHash = await bcrypt.hash(input.newPassword, BCRYPT_COST);

  return db.$transaction(async (tx): Promise<PasswordResetOutcome> => {
    const record = await tx.passwordResetToken.findUnique({
      where: { tokenHash },
      select: { id: true, userId: true, user: { select: { isActive: true } } },
    });
    if (!record || !record.user.isActive) return { status: "invalid" };

    // Lock order is user row first, then token rows, matching issuePasswordResetToken,
    // so a reset and a new request for the same account cannot deadlock.
    await tx.user.update({ where: { id: record.userId }, data: { updatedAt: now } });

    const claimed = await tx.passwordResetToken.updateMany({
      where: { id: record.id, consumedAt: null, expires: { gt: now } },
      data: { consumedAt: now },
    });
    if (claimed.count !== 1) return { status: "invalid" };

    await tx.user.update({
      where: { id: record.userId },
      data: { password: passwordHash, sessionVersion: { increment: 1 } },
    });
    await tx.passwordResetToken.deleteMany({
      where: { userId: record.userId, id: { not: record.id } },
    });
    return { status: "reset" };
  });
}
