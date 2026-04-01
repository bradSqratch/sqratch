import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

type RedemptionDbClient = Prisma.TransactionClient | typeof prisma;

export async function redeemQrCodeForUser(options: {
  qrCodeId?: string | null;
  userId: string;
  userEmail?: string | null;
  db?: RedemptionDbClient;
}) {
  const { qrCodeId, userId, userEmail } = options;

  if (!qrCodeId) {
    return {
      redeemed: false,
      alreadyRedeemed: false,
      alreadyRedeemedByViewer: false,
    };
  }

  const db = options.db || prisma;
  const usedAt = new Date();

  const result = await db.qRCode.updateMany({
    where: {
      id: qrCodeId,
      status: "NEW",
    },
    data: {
      status: "USED",
      redeemedById: userId,
      email: userEmail || undefined,
      usedAt,
    },
  });

  if (result.count > 0) {
    return {
      redeemed: true,
      alreadyRedeemed: false,
      alreadyRedeemedByViewer: false,
    };
  }

  const existing = await db.qRCode.findUnique({
    where: { id: qrCodeId },
    select: {
      redeemedById: true,
      status: true,
    },
  });

  const alreadyRedeemed = existing?.status === "USED";
  const alreadyRedeemedByViewer = existing?.redeemedById === userId;

  return {
    redeemed: alreadyRedeemedByViewer,
    alreadyRedeemed,
    alreadyRedeemedByViewer,
  };
}
