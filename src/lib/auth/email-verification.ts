import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  compareEmailVerificationCodeHash,
  generateEmailVerificationCode,
  hashEmailVerificationCode,
} from "@/lib/auth/email-verification-crypto";
import { enqueueWelcomeEmailIfEligible } from "@/lib/welcome-email";

export {
  compareEmailVerificationCodeHash,
  generateEmailVerificationCode,
  hashEmailVerificationCode,
};

const MAX_FAILED_ATTEMPTS = 5;
const VERIFICATION_TTL_MS = 10 * 60 * 1000;
type DbClient = PrismaClient | Prisma.TransactionClient;

export async function issueEmailVerificationChallenge(
  db: DbClient,
  userId: string,
  email: string,
  options: {
    welcomeEligible: boolean;
  },
) {
  const code = generateEmailVerificationCode();
  const expires = new Date(Date.now() + VERIFICATION_TTL_MS);
  const codeHash = hashEmailVerificationCode(email, code);

  await db.emailVerificationToken.deleteMany({ where: { userId } });
  await db.emailVerificationToken.create({
    data: {
      userId,
      email,
      codeHash,
      welcomeEligible: options.welcomeEligible,
      failedAttempts: 0,
      consumedAt: null,
      expires,
    },
  });

  return { code, expires };
}

export type VerificationOutcome =
  | "verified"
  | "invalid"
  | "expired"
  | "consumed"
  | "exhausted"
  | "unavailable";

export async function verifyAndConsumeEmailVerificationCode(
  email: string,
  code: string,
): Promise<VerificationOutcome> {
  try {
    return await prisma.$transaction(async (tx) => {
      const now = new Date();
      const challenge = await tx.emailVerificationToken.findFirst({
        where: { email },
        orderBy: { createdAt: "desc" },
      });

      if (!challenge) return "unavailable";
      if (challenge.consumedAt) return "consumed";
      if (challenge.failedAttempts >= MAX_FAILED_ATTEMPTS) return "exhausted";
      if (challenge.expires <= now) return "expired";

      const submittedHash = hashEmailVerificationCode(email, code);
      if (!compareEmailVerificationCodeHash(challenge.codeHash, submittedHash)) {
        const failed = await tx.emailVerificationToken.updateMany({
          where: {
            id: challenge.id,
            consumedAt: null,
            expires: { gt: now },
            failedAttempts: { lt: MAX_FAILED_ATTEMPTS },
          },
          data: { failedAttempts: { increment: 1 } },
        });

        if (failed.count === 0) return "unavailable";
        return challenge.failedAttempts + 1 >= MAX_FAILED_ATTEMPTS
          ? "exhausted"
          : "invalid";
      }

      const consumed = await tx.emailVerificationToken.updateMany({
        where: {
          id: challenge.id,
          codeHash: challenge.codeHash,
          consumedAt: null,
          expires: { gt: now },
          failedAttempts: { lt: MAX_FAILED_ATTEMPTS },
        },
        data: { consumedAt: now },
      });

      if (consumed.count !== 1) return "unavailable";

      await tx.user.update({
        where: { id: challenge.userId },
        data: {
          isEmailVerified: true,
          emailVerifiedAt: now,
        },
      });

      await enqueueWelcomeEmailIfEligible(tx, {
        userId: challenge.userId,
        welcomeEligible: challenge.welcomeEligible,
      });

      return "verified";
    });
  } catch {
    return "unavailable";
  }
}
