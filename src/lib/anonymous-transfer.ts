import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import {
  awardCourseCompletionPoints,
  awardLessonCompletionPoints,
  awardQrScanPoint,
} from "@/lib/points";
import { redeemQrCodeForUser } from "@/lib/qr-redemption";
import { raiseLessonProgress } from "@/lib/lesson-progress";
import { isValidSessionId } from "@/lib/session-id";

export type TransferStatus = "complete" | "retry_required";

export type AnonymousTransferResult = {
  status: TransferStatus;
  mergedLessons: number;
  mergedUnlocks: number;
  /** Number of point awards newly applied by this call (QR, lesson or course). */
  pointsAwarded: number;
};

type Tx = Prisma.TransactionClient;

/**
 * Moves anonymous (cookie-keyed) progress and unlocks to a signed-in account,
 * and settles any completion rewards the account has earned but not yet been
 * paid. It is used by BOTH email verification and sign-in.
 *
 * Properties the callers rely on:
 *  - Idempotent and safe to run concurrently: every anonymous row is claimed
 *    under a row lock inside its own transaction, so exactly one caller moves it.
 *  - Only rows it claimed are removed. Rows written after the initial read stay
 *    in place and move on the next call.
 *  - A failure never loses anything: the failing unit rolls back (its anonymous
 *    row stays), the rest continue, and the result is `retry_required`. The
 *    durable state is simply the remaining anonymous rows plus the committed
 *    account rows, so a later call finishes the work without any consumed
 *    verification code.
 *  - Point awards keep their existing ledger idempotency keys. Owner,
 *    inactive-content and unpublished-experience restrictions are enforced by
 *    the award helpers in `points.ts`.
 *  - `unlockKeys` and `sessionId` must come from the caller's own cookies,
 *    never from a request body.
 */
export async function transferAnonymousState(input: {
  userId: string;
  userEmail?: string | null;
  sessionId?: string | null;
  unlockKeys?: readonly string[];
}): Promise<AnonymousTransferResult> {
  const { userId, userEmail } = input;
  const sessionId = isValidSessionId(input.sessionId) ? input.sessionId : null;
  const unlockKeys = [
    ...new Set([...(sessionId ? [sessionId] : []), ...(input.unlockKeys ?? [])]),
  ].filter(isValidSessionId);

  const result: AnonymousTransferResult = {
    status: "complete",
    mergedLessons: 0,
    mergedUnlocks: 0,
    pointsAwarded: 0,
  };
  const fail = (scope: string, error: unknown) => {
    result.status = "retry_required";
    const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined;
    // Conflicts and timeouts (P2002, P2034, P2028) are expected under
    // concurrency and heal on the next call; anything else deserves attention.
    const expected = code === "P2002" || code === "P2034" || code === "P2028";
    (expected ? console.warn : console.error)("[anonymous-transfer] step failed; retry required", { scope, code });
  };

  if (sessionId) {
    try {
      const rows = await prisma.lessonProgress.findMany({
        where: { sessionId },
        select: { id: true },
        orderBy: { updatedAt: "desc" },
      });
      for (const row of rows) {
        try {
          const moved = await prisma.$transaction((tx) =>
            moveLessonProgressRow(tx, { rowId: row.id, sessionId, userId }),
          );
          if (moved) result.mergedLessons += 1;
        } catch (error) {
          fail("lesson", error);
        }
      }
    } catch (error) {
      fail("lessons", error);
    }
  }

  for (const key of unlockKeys) {
    try {
      const unlocks = await prisma.campaignUnlock.findMany({
        where: { anonKey: key, userId: null },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      for (const unlock of unlocks) {
        try {
          const outcome = await prisma.$transaction((tx) =>
            moveUnlock(tx, { unlockId: unlock.id, userId, userEmail }),
          );
          if (outcome.merged) result.mergedUnlocks += 1;
          if (outcome.pointAwarded) result.pointsAwarded += 1;
        } catch (error) {
          fail("unlock", error);
        }
      }
    } catch (error) {
      fail("unlocks", error);
    }
  }

  try {
    result.pointsAwarded += await settleOutstandingCompletionAwards(userId, (error) =>
      fail("award", error),
    );
  } catch (error) {
    fail("settle", error);
  }

  if (sessionId) {
    try {
      await prisma.userSession.updateMany({
        where: { id: sessionId },
        data: { userId, lastSeenAt: new Date() },
      });
    } catch (error) {
      fail("session-link", error);
    }
  }

  return result;
}

/**
 * Claims one anonymous progress row under a row lock and folds it into the
 * account's row with raise-only writes. The lock also guarantees the values
 * read are the latest committed ones, so a concurrent anonymous save is never
 * lost by a stale read.
 */
async function moveLessonProgressRow(
  tx: Tx,
  { rowId, sessionId, userId }: { rowId: string; sessionId: string; userId: string },
): Promise<boolean> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "LessonProgress"
    WHERE id = ${rowId} AND "sessionId" = ${sessionId} FOR UPDATE`;
  if (!locked[0]) return false; // Already claimed by a concurrent transfer.
  // Read AFTER taking the lock: the row cannot change now, so these are the
  // latest committed values and a concurrent anonymous save is never lost.
  const row = await tx.lessonProgress.findUniqueOrThrow({
    where: { id: rowId },
    select: { lessonId: true, lastPositionSeconds: true, isCompleted: true },
  });

  await tx.lessonProgress.delete({ where: { id: rowId } });
  await raiseLessonProgress(tx, { userId }, row);
  return true;
}

/**
 * Moves one anonymous campaign unlock to the account. The unlock row is locked
 * first so a concurrent transfer cannot convert it and then have this one
 * delete the converted row. Behavior otherwise matches the previous per-route
 * logic: a code already redeemed by someone else drops the anonymous unlock; an
 * existing account unlock absorbs it.
 */
async function moveUnlock(
  tx: Tx,
  { unlockId, userId, userEmail }: { unlockId: string; userId: string; userEmail?: string | null },
): Promise<{ merged: boolean; pointAwarded: boolean }> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "CampaignUnlock"
    WHERE id = ${unlockId} AND "userId" IS NULL FOR UPDATE`;
  if (!locked[0]) return { merged: false, pointAwarded: false };
  const unlock = await tx.campaignUnlock.findUniqueOrThrow({
    where: { id: unlockId },
    select: { campaignId: true, qrCodeId: true },
  });

  const existingUserUnlock = await tx.campaignUnlock.findFirst({
    where: { campaignId: unlock.campaignId, userId },
    select: { id: true },
  });

  if (existingUserUnlock) {
    let pointAwarded = false;
    if (unlock.qrCodeId) {
      const redemption = await redeemQrCodeForUser({
        qrCodeId: unlock.qrCodeId,
        userId,
        userEmail,
        db: tx,
      });
      if (redemption.redeemed) {
        pointAwarded = await awardQrPointOnce(tx, userId, unlock.qrCodeId);
      }
    }
    await tx.campaignUnlock.delete({ where: { id: unlockId } });
    return { merged: false, pointAwarded };
  }

  if (unlock.qrCodeId) {
    const redemption = await redeemQrCodeForUser({
      qrCodeId: unlock.qrCodeId,
      userId,
      userEmail,
      db: tx,
    });
    if (!redemption.redeemed) {
      await tx.campaignUnlock.delete({ where: { id: unlockId } });
      return { merged: false, pointAwarded: false };
    }
  }

  await tx.campaignUnlock.update({ where: { id: unlockId }, data: { userId } });
  const pointAwarded = unlock.qrCodeId
    ? await awardQrPointOnce(tx, userId, unlock.qrCodeId)
    : false;
  return { merged: true, pointAwarded };
}

/**
 * Historical ledger rows can predate idempotency keys. They slip past the key
 * pre-check in `applyPointLedgerEvent` and then violate
 * `@@unique([userId, qrCodeId])` on every retry, so treat an existing row for
 * the same user and code as "already awarded".
 */
async function awardQrPointOnce(tx: Tx, userId: string, qrCodeId: string): Promise<boolean> {
  const existing = await tx.pointTransaction.findFirst({
    where: { userId, qrCodeId },
    select: { id: true },
  });
  if (existing) return false;
  return awardQrScanPoint({ userId, qrCodeId, db: tx });
}

/**
 * Pays completion rewards the account has earned but not been paid. Derived
 * entirely from committed account rows, so a later call completes whatever an
 * earlier failed call could not. Eligibility (active content, published
 * experience, creator is not the learner) is applied here to keep the scan
 * small and again, authoritatively, inside the award helpers.
 */
export async function settleOutstandingCompletionAwards(
  userId: string,
  onError: (error: unknown) => void = () => undefined,
): Promise<number> {
  const visible = {
    isActive: true,
    experience: { isActive: true, creator: { userId: { not: userId } } },
  } as const;
  let awarded = 0;

  const lessonRows = await prisma.lessonProgress.findMany({
    where: {
      userId,
      isCompleted: true,
      lesson: { isActive: true, completionPointsReward: { gt: 0 }, course: visible },
    },
    select: { lessonId: true },
  });
  const lessonIds = [...new Set(lessonRows.map((row) => row.lessonId))];
  if (lessonIds.length) {
    const paid = await prisma.pointTransaction.findMany({
      where: { userId, idempotencyKey: { in: lessonIds.map((id) => `lesson-completion:${id}`) } },
      select: { idempotencyKey: true },
    });
    const paidKeys = new Set(paid.map((row) => row.idempotencyKey));
    for (const lessonId of lessonIds) {
      if (paidKeys.has(`lesson-completion:${lessonId}`)) continue;
      try {
        const outcome = await awardLessonCompletionPoints({ userId, lessonId });
        if (outcome.applied) awarded += 1;
      } catch (error) {
        onError(error);
      }
    }
  }

  const courseRows = await prisma.lessonProgress.findMany({
    where: {
      userId,
      isCompleted: true,
      lesson: { isActive: true, course: { ...visible, completionPointsReward: { gt: 0 } } },
    },
    select: { lesson: { select: { courseId: true } } },
  });
  const courseIds = [...new Set(courseRows.map((row) => row.lesson.courseId))];
  if (courseIds.length) {
    const paid = await prisma.pointTransaction.findMany({
      where: { userId, idempotencyKey: { in: courseIds.map((id) => `course-completion:${id}`) } },
      select: { idempotencyKey: true },
    });
    const paidKeys = new Set(paid.map((row) => row.idempotencyKey));
    for (const courseId of courseIds) {
      if (paidKeys.has(`course-completion:${courseId}`)) continue;
      try {
        const outcome = await awardCourseCompletionPoints({ userId, courseId });
        if (outcome.applied) awarded += 1;
      } catch (error) {
        onError(error);
      }
    }
  }

  return awarded;
}
