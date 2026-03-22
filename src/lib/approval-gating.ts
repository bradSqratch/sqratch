import prisma from "@/lib/prisma";

export async function hasPendingApproval(userId: string) {
  const [creatorRequest, brandRequest] = await Promise.all([
    prisma.creatorRequest.findFirst({
      where: {
        userId,
        status: "PENDING",
      },
      select: {
        id: true,
      },
    }),
    prisma.brandRequest.findFirst({
      where: {
        userId,
        status: "PENDING",
      },
      select: {
        id: true,
      },
    }),
  ]);

  return Boolean(creatorRequest || brandRequest);
}
