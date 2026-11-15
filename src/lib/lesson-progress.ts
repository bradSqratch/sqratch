import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

type Db = Prisma.TransactionClient | typeof prisma;

export type LessonProgressOwner = { userId: string } | { sessionId: string };

export type LessonProgressSnapshot = {
  lessonId: string;
  lastPositionSeconds: number;
  isCompleted: boolean;
  updatedAt: Date;
};

const SNAPSHOT_SELECT = {
  lessonId: true,
  lastPositionSeconds: true,
  isCompleted: true,
  updatedAt: true,
} as const;

function ownerWhere(owner: LessonProgressOwner, lessonId: string) {
  return "userId" in owner
    ? { userId: owner.userId, lessonId }
    : { sessionId: owner.sessionId, lessonId };
}

/**
 * Raise-only progress write.
 *
 * Every statement here can only move a row forward: the position never
 * decreases and `isCompleted` never goes from true to false. Because each
 * statement is conditional and atomic, two concurrent writers (a progress save
 * and an anonymous transfer, or two transfers) cannot lose each other's update,
 * which a read-then-write `max()` cannot guarantee.
 */
export async function raiseLessonProgress(
  db: Db,
  owner: LessonProgressOwner,
  input: { lessonId: string; lastPositionSeconds: number; isCompleted: boolean },
): Promise<LessonProgressSnapshot> {
  const position = Math.max(0, Math.floor(Number.isFinite(input.lastPositionSeconds) ? input.lastPositionSeconds : 0));
  const where = ownerWhere(owner, input.lessonId);

  await db.lessonProgress.createMany({
    data: [{ ...where, lastPositionSeconds: position, isCompleted: input.isCompleted }],
    skipDuplicates: true,
  });
  if (position > 0) {
    await db.lessonProgress.updateMany({
      where: { ...where, lastPositionSeconds: { lt: position } },
      data: { lastPositionSeconds: position },
    });
  }
  if (input.isCompleted) {
    await db.lessonProgress.updateMany({
      where: { ...where, isCompleted: false },
      data: { isCompleted: true },
    });
  }

  const row = await db.lessonProgress.findFirst({ where, select: SNAPSHOT_SELECT });
  if (row) return row;

  // Only an anonymous row can vanish here: a concurrent sign-in transfer claimed
  // and deleted it after the create above, so the conditional updates above hit
  // nothing. Recreate it with this write's values; the next transfer moves it.
  // Never report a save that was not stored.
  if ("sessionId" in owner) {
    await db.lessonProgress.createMany({
      data: [{ ...where, lastPositionSeconds: position, isCompleted: input.isCompleted }],
      skipDuplicates: true,
    });
    const recreated = await db.lessonProgress.findFirst({ where, select: SNAPSHOT_SELECT });
    if (recreated) return recreated;
  }
  throw new Error("Lesson progress could not be saved.");
}
