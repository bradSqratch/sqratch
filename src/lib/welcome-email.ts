import type { Prisma, PrismaClient, Role } from "@prisma/client";

type DbClient = PrismaClient | Prisma.TransactionClient;

export type WelcomeEmailEligibility = {
  isEmailVerified: boolean;
  role: Role;
  hasCreatorRequest: boolean;
  hasBrandRequest: boolean;
};

export function isWelcomeEmailEligible(
  account: WelcomeEmailEligibility,
): boolean {
  return (
    account.isEmailVerified &&
    account.role === "USER" &&
    !account.hasCreatorRequest &&
    !account.hasBrandRequest
  );
}

export async function enqueueWelcomeEmailIfEligible(
  db: DbClient,
  options: {
    userId: string;
    welcomeEligible: boolean;
  },
): Promise<boolean> {
  if (!options.welcomeEligible) {
    return false;
  }

  const user = await db.user.findUnique({
    where: { id: options.userId },
    select: {
      id: true,
      email: true,
      role: true,
      isEmailVerified: true,
      creatorRequests: {
        select: { id: true },
        take: 1,
      },
      brandRequests: {
        select: { id: true },
        take: 1,
      },
    },
  });

  if (
    !user ||
    !isWelcomeEmailEligible({
      isEmailVerified: user.isEmailVerified,
      role: user.role,
      hasCreatorRequest: user.creatorRequests.length > 0,
      hasBrandRequest: user.brandRequests.length > 0,
    })
  ) {
    return false;
  }

  await db.emailQueue.upsert({
    where: {
      uq_email_queue_user_template: {
        userId: user.id,
        template: "WELCOME",
      },
    },
    update: {
      email: user.email,
      verificationEligible: true,
    },
    create: {
      userId: user.id,
      email: user.email,
      template: "WELCOME",
      verificationEligible: true,
    },
  });

  return true;
}
