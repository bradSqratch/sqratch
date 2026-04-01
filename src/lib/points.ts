import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

type PointDbClient = Prisma.TransactionClient | typeof prisma;

export async function awardQrScanPoint(options: {
  userId: string;
  qrCodeId?: string | null;
  db?: PointDbClient;
}) {
  const { userId, qrCodeId } = options;

  if (!qrCodeId) {
    return false;
  }

  const db = options.db || prisma;

  try {
    await db.pointTransaction.create({
      data: {
        userId,
        points: 1,
        reason: "QR_SCAN",
        qrCodeId,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return false;
    }

    throw error;
  }

  await db.user.update({
    where: { id: userId },
    data: {
      points: { increment: 1 },
    },
  });

  return true;
}

export async function getUserPointsOverview(userId: string, take = 25) {
  const [user, transactions] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        points: true,
      },
    }),
    prisma.pointTransaction.findMany({
      where: { userId },
      orderBy: {
        createdAt: "desc",
      },
      take,
      select: {
        id: true,
        points: true,
        reason: true,
        createdAt: true,
        qrCode: {
          select: {
            id: true,
            qrCodeData: true,
            campaign: {
              select: {
                id: true,
                name: true,
                slug: true,
                brand: {
                  select: {
                    id: true,
                    name: true,
                    slug: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  if (!user) {
    return null;
  }

  const qrPoints = transactions
    .filter((item) => item.reason === "QR_SCAN")
    .reduce((total, item) => total + item.points, 0);

  const bonusPoints = transactions
    .filter((item) => item.reason === "BONUS")
    .reduce((total, item) => total + item.points, 0);

  const referralPoints = transactions
    .filter((item) => item.reason === "REFERRAL")
    .reduce((total, item) => total + item.points, 0);

  return {
    user,
    totals: {
      currentPoints: user.points,
      transactionCount: transactions.length,
      qrPoints,
      bonusPoints,
      referralPoints,
    },
    transactions: transactions.map((item) => ({
      id: item.id,
      points: item.points,
      reason: item.reason,
      createdAt: item.createdAt,
      qrCodeData: item.qrCode?.qrCodeData || null,
      campaign: item.qrCode?.campaign
        ? {
            id: item.qrCode.campaign.id,
            name: item.qrCode.campaign.name,
            slug: item.qrCode.campaign.slug,
            brand: item.qrCode.campaign.brand,
          }
        : null,
    })),
  };
}
