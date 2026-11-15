import type { Prisma, Role } from "@prisma/client";
import prisma from "@/lib/prisma";

const userSelect = {
  id: true, name: true, email: true, role: true, isEmailVerified: true,
  createdAt: true, isActive: true,
  creatorProfile: { select: { id: true } },
  brandMembers: { select: { id: true, role: true, brand: { select: { id: true, name: true, slug: true } } }, take: 3, orderBy: { createdAt: "asc" as const } },
} satisfies Prisma.UserSelect;

async function serializable<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(work, { isolationLevel: "Serializable" });
    } catch (error) {
      const conflict = (error as { code?: string }).code === "P2034" || (error instanceof Error && error.name === "DriverAdapterError" && (error as Error & { cause?: { kind?: string } }).cause?.kind === "TransactionWriteConflict");
      if (!conflict || attempt >= 3) throw error;
    }
  }
}

async function assertRemovalAllowed(tx: Prisma.TransactionClient, actorId: string, target: { id: string; role: Role; isActive: boolean }, removesAccess: boolean) {
  if (!removesAccess) return;
  if (actorId === target.id) throw new Error("SELF_CHANGE");
  if (target.role === "ADMIN" && target.isActive) {
    const others = await tx.user.count({ where: { id: { not: target.id }, role: "ADMIN", isActive: true } });
    if (others === 0) throw new Error("LAST_ADMIN");
  }
}

async function assertActiveAdmin(tx: Prisma.TransactionClient, actorId: string) {
  const actor = await tx.user.findUnique({ where: { id: actorId }, select: { role: true, isActive: true } });
  if (!actor || actor.role !== "ADMIN" || !actor.isActive) throw new Error("ACTOR_NOT_ADMIN");
}

export async function changeUserAccess(input: { actorId: string; targetId: string; role?: Role; isActive?: boolean; name?: string; email?: string }) {
  return serializable(async (tx) => {
    await assertActiveAdmin(tx, input.actorId);
    const existing = await tx.user.findUnique({ where: { id: input.targetId }, select: { id: true, name: true, email: true, role: true, isActive: true } });
    if (!existing) throw new Error("USER_NOT_FOUND");
    if (input.email !== undefined && existing.email.toLowerCase() !== input.email) throw new Error("EMAIL_CHANGE_NOT_ALLOWED");
    const removesAccess = (existing.role === "ADMIN" && input.role !== undefined && input.role !== "ADMIN") || (existing.isActive && input.isActive === false);
    await assertRemovalAllowed(tx, input.actorId, existing, removesAccess);
    const user = await tx.user.update({ where: { id: input.targetId }, data: { role: input.role, isActive: input.isActive, name: input.name }, select: userSelect });
    if (input.role === "CREATOR") {
      const displayName = input.name || existing.name?.trim() || existing.email.split("@")[0];
      user.creatorProfile = await tx.creatorProfile.upsert({ where: { userId: input.targetId }, update: { displayName, isActive: true }, create: { userId: input.targetId, displayName, isActive: true }, select: { id: true } });
    }
    return user;
  });
}

export async function deleteUser(input: { actorId: string; targetId: string }) {
  return serializable(async (tx) => {
    await assertActiveAdmin(tx, input.actorId);
    const user = await tx.user.findUnique({ where: { id: input.targetId }, select: { id: true, role: true, isActive: true, imageUrl: true } });
    if (!user) throw new Error("USER_NOT_FOUND");
    await assertRemovalAllowed(tx, input.actorId, user, true);
    const [campaigns, qrCodes, points, redemptions] = await Promise.all([
      tx.campaign.count({ where: { createdById: input.targetId } }),
      tx.qRCode.count({ where: { OR: [{ createdById: input.targetId }, { redeemedById: input.targetId }] } }),
      tx.pointTransaction.count({ where: { userId: input.targetId } }),
      tx.commerceRewardRedemption.count({ where: { userId: input.targetId } }),
    ]);
    if (campaigns || qrCodes || points || redemptions) throw new Error("USER_HAS_HISTORY");
    await tx.user.delete({ where: { id: input.targetId } });
    return user;
  });
}

export function adminMutationError(error: unknown): { code: string; error: string } | null {
  if (!(error instanceof Error)) return null;
  const messages: Record<string, string> = {
    LAST_ADMIN: "The last active administrator cannot be removed. Add another active administrator first.",
    SELF_CHANGE: "You cannot remove your own administrator access or delete your own account.",
    USER_HAS_HISTORY: "Cannot delete user: their history must be retained. Deactivate the account instead.",
  };
  return messages[error.message] ? { code: error.message, error: messages[error.message] } : null;
}
