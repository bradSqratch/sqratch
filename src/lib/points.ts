import { Prisma, PointReason, PointSourceType, PointTransactionType } from "@prisma/client";
import prisma from "@/lib/prisma";

type PointDbClient = Prisma.TransactionClient | typeof prisma;

/**
 * Internal sentinel used to unwind a self-opened transaction when a ledger row
 * collides on a unique constraint (idempotency). Never leaks to callers — it is
 * translated into `{ applied: false, reason: "DUPLICATE" }`.
 */
class DuplicateLedgerRace extends Error {
  constructor() {
    super("DUPLICATE_LEDGER_RACE");
    this.name = "DuplicateLedgerRace";
  }
}

function isBaseClient(client: PointDbClient): client is typeof prisma {
  return typeof (client as typeof prisma).$transaction === "function";
}

// ---------------------------------------------------------------------------
// Pure balance math — exported for unit testing without a database.
// ---------------------------------------------------------------------------

export type PointLedgerType = "EARN" | "SPEND" | "REFUND" | "ADJUSTMENT";

export interface LedgerDeltas {
  /** Signed value written to PointTransaction.points. */
  ledgerPoints: number;
  /** Change to spendablePoints (can be negative). */
  dSpendable: number;
  /** Change to lifetimeEarnedPoints (never negative). */
  dLifetimeEarned: number;
  /** Change to lifetimeSpentPoints (never negative). */
  dLifetimeSpent: number;
  /** Change to lifetimeRefundedPoints (never negative). */
  dLifetimeRefunded: number;
}

export type ComputeLedgerDeltasResult =
  | { ok: true; deltas: LedgerDeltas }
  | { ok: false; error: string };

/**
 * Pure function: given a ledger event type and a points value, compute how the
 * aggregate account fields should move. Enforces sign rules per type.
 *
 * - EARN:   points must be a positive integer. Raises spendable + lifetime earned.
 * - REFUND: points must be a positive integer. Raises spendable + lifetime refunded.
 *           Does NOT raise lifetime earned.
 * - SPEND:  accepts a positive cost OR a negative value; normalised to a negative
 *           ledger row. Lowers spendable, raises lifetime spent.
 * - ADJUSTMENT: signed correction. Raises/lowers spendable only, unless
 *           `countsAsLifetimeEarned` is set (positive adjustments only).
 */
export function computeLedgerDeltas(
  type: PointLedgerType,
  points: number,
  options: { countsAsLifetimeEarned?: boolean } = {},
): ComputeLedgerDeltasResult {
  if (!Number.isInteger(points)) {
    return { ok: false, error: "points must be an integer" };
  }

  switch (type) {
    case "EARN": {
      if (points <= 0) return { ok: false, error: "EARN points must be positive" };
      return {
        ok: true,
        deltas: {
          ledgerPoints: points,
          dSpendable: points,
          dLifetimeEarned: points,
          dLifetimeSpent: 0,
          dLifetimeRefunded: 0,
        },
      };
    }
    case "REFUND": {
      if (points <= 0) return { ok: false, error: "REFUND points must be positive" };
      return {
        ok: true,
        deltas: {
          ledgerPoints: points,
          dSpendable: points,
          dLifetimeEarned: 0,
          dLifetimeSpent: 0,
          dLifetimeRefunded: points,
        },
      };
    }
    case "SPEND": {
      const magnitude = Math.abs(points);
      if (magnitude <= 0) return { ok: false, error: "SPEND points must be non-zero" };
      return {
        ok: true,
        deltas: {
          ledgerPoints: -magnitude,
          dSpendable: -magnitude,
          dLifetimeEarned: 0,
          dLifetimeSpent: magnitude,
          dLifetimeRefunded: 0,
        },
      };
    }
    case "ADJUSTMENT": {
      if (points === 0) return { ok: false, error: "ADJUSTMENT points must be non-zero" };
      const countsEarned = points > 0 && Boolean(options.countsAsLifetimeEarned);
      return {
        ok: true,
        deltas: {
          ledgerPoints: points,
          dSpendable: points,
          dLifetimeEarned: countsEarned ? points : 0,
          dLifetimeSpent: 0,
          dLifetimeRefunded: 0,
        },
      };
    }
    default:
      return { ok: false, error: "unknown ledger type" };
  }
}

// ---------------------------------------------------------------------------
// Account provisioning (self-healing).
// ---------------------------------------------------------------------------

export interface UserPointAccountShape {
  userId: string;
  spendablePoints: number;
  lifetimeEarnedPoints: number;
  lifetimeSpentPoints: number;
  lifetimeRefundedPoints: number;
  version: number;
}

/**
 * Derive lifetime aggregates for a user directly from the immutable ledger.
 * Mirrors the rules used by manual-production-backfill.sql exactly:
 *   earned   = positive QR_SCAN / BONUS / REFERRAL rows
 *   spent    = ABS of negative SHOPIFY_REWARD_REDEMPTION rows
 *   refunded = positive SHOPIFY_REWARD_REFUND rows
 */
async function deriveLifetimeFromLedger(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<{ earned: number; spent: number; refunded: number }> {
  const grouped = await tx.pointTransaction.groupBy({
    by: ["reason"],
    where: { userId },
    _sum: { points: true },
  });

  let earned = 0;
  let spent = 0;
  let refunded = 0;
  for (const row of grouped) {
    const sum = row._sum.points ?? 0;
    switch (row.reason) {
      case "QR_SCAN":
      case "BONUS":
      case "REFERRAL":
        if (sum > 0) earned += sum;
        break;
      case "SHOPIFY_REWARD_REDEMPTION":
        if (sum < 0) spent += Math.abs(sum);
        break;
      case "SHOPIFY_REWARD_REFUND":
        if (sum > 0) refunded += sum;
        break;
    }
  }
  return { earned, spent, refunded };
}

/**
 * Fetch the user's point account, creating it if missing. When created, lifetime
 * totals are self-healed from the existing ledger and spendable is seeded from
 * the legacy `User.points` balance so existing balances are never lost even if
 * the manual backfill has not run yet.
 */
async function ensureAccount(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<UserPointAccountShape> {
  const existing = await tx.userPointAccount.findUnique({ where: { userId } });
  if (existing) return existing;

  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { points: true },
  });
  if (!user) {
    throw new Error(`Cannot create point account: user ${userId} not found`);
  }

  const { earned, spent, refunded } = await deriveLifetimeFromLedger(tx, userId);

  try {
    return await tx.userPointAccount.create({
      data: {
        userId,
        spendablePoints: user.points,
        lifetimeEarnedPoints: earned,
        lifetimeSpentPoints: spent,
        lifetimeRefundedPoints: refunded,
        version: 0,
      },
    });
  } catch (error) {
    // Concurrent creation — re-read the row that won the race.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await tx.userPointAccount.findUnique({ where: { userId } });
      if (raced) return raced;
    }
    throw error;
  }
}

/**
 * Read the spendable balance from the point-account aggregate. If an older
 * account has not been provisioned yet, this uses the same self-healing path as
 * ledger writes so reward display and redemption share one balance source.
 */
export async function getUserSpendablePointBalance(options: {
  userId: string;
  db?: PointDbClient;
}): Promise<number> {
  const client = options.db ?? prisma;

  if (isBaseClient(client)) {
    const account = await client.$transaction((tx) =>
      ensureAccount(tx, options.userId),
    );
    return account.spendablePoints;
  }

  const account = await ensureAccount(client, options.userId);
  return account.spendablePoints;
}

// ---------------------------------------------------------------------------
// Central ledger event application.
// ---------------------------------------------------------------------------

export interface ApplyPointLedgerEventInput {
  userId: string;
  points: number;
  type: PointLedgerType;
  reason: PointReason;
  sourceType?: PointSourceType | null;
  sourceId?: string | null;
  idempotencyKey?: string | null;
  qrCodeId?: string | null;
  shopifyRewardRedemptionId?: string | null;
  metadata?: Prisma.InputJsonValue;
  createdById?: string | null;
  /** For positive ADJUSTMENT only: treat as a true earning that raises lifetime earned. */
  countsAsLifetimeEarned?: boolean;
  db?: PointDbClient;
}

export interface AppliedLedgerTransaction {
  id: string;
  points: number;
  type: PointTransactionType;
  reason: PointReason;
  sourceType: PointSourceType | null;
  balanceAfter: number | null;
  lifetimeEarnedAfter: number | null;
  createdAt: Date;
}

export type ApplyPointLedgerEventResult =
  | {
      applied: true;
      transaction: AppliedLedgerTransaction;
      account: UserPointAccountShape;
    }
  | {
      applied: false;
      reason: "DUPLICATE" | "INSUFFICIENT_POINTS" | "INVALID";
    };

async function runLedgerEvent(
  tx: Prisma.TransactionClient,
  input: ApplyPointLedgerEventInput,
  ownsTransaction: boolean,
): Promise<ApplyPointLedgerEventResult> {
  const computed = computeLedgerDeltas(input.type, input.points, {
    countsAsLifetimeEarned: input.countsAsLifetimeEarned,
  });
  if (!computed.ok) {
    return { applied: false, reason: "INVALID" };
  }
  const deltas = computed.deltas;

  // 1. Idempotency pre-check (the common duplicate path never throws).
  if (input.idempotencyKey) {
    const existing = await tx.pointTransaction.findUnique({
      where: {
        uq_point_tx_user_idempotency_key: {
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      select: { id: true },
    });
    if (existing) {
      return { applied: false, reason: "DUPLICATE" };
    }
  }

  const account = await ensureAccount(tx, input.userId);

  // 2. Apply the balance change. Decreases use a conditional update so the
  //    spendable balance can never go negative.
  if (deltas.dSpendable < 0) {
    const magnitude = -deltas.dSpendable;
    const guarded = await tx.userPointAccount.updateMany({
      where: { userId: input.userId, spendablePoints: { gte: magnitude } },
      data: {
        spendablePoints: { decrement: magnitude },
        lifetimeSpentPoints: { increment: deltas.dLifetimeSpent },
        version: { increment: 1 },
      },
    });
    if (guarded.count !== 1) {
      return { applied: false, reason: "INSUFFICIENT_POINTS" };
    }
  } else {
    await tx.userPointAccount.update({
      where: { userId: input.userId },
      data: {
        spendablePoints: { increment: deltas.dSpendable },
        lifetimeEarnedPoints: { increment: deltas.dLifetimeEarned },
        lifetimeRefundedPoints: { increment: deltas.dLifetimeRefunded },
        version: { increment: 1 },
      },
    });
  }

  const newSpendable = account.spendablePoints + deltas.dSpendable;
  const newLifetimeEarned = account.lifetimeEarnedPoints + deltas.dLifetimeEarned;

  // 3. Create the immutable ledger row. Unique constraints are the ultimate
  //    idempotency guard against a concurrent duplicate slipping past step 1.
  let created;
  try {
    created = await tx.pointTransaction.create({
      data: {
        userId: input.userId,
        points: deltas.ledgerPoints,
        reason: input.reason,
        type: input.type,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
        idempotencyKey: input.idempotencyKey ?? null,
        qrCodeId: input.qrCodeId ?? null,
        shopifyRewardRedemptionId: input.shopifyRewardRedemptionId ?? null,
        metadata: input.metadata,
        balanceAfter: newSpendable,
        lifetimeEarnedAfter: newLifetimeEarned,
        createdById: input.createdById ?? null,
      },
      select: {
        id: true,
        points: true,
        type: true,
        reason: true,
        sourceType: true,
        balanceAfter: true,
        lifetimeEarnedAfter: true,
        createdAt: true,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // A duplicate slipped past the pre-check (race, or a historical row whose
      // idempotencyKey has not been backfilled).
      if (ownsTransaction) {
        // Unwind our own transaction and report the duplicate cleanly.
        throw new DuplicateLedgerRace();
      }
      // Caller owns the transaction: propagate so their tx rolls back the
      // balance mutation above. Preserves existing P2002-based exactly-once
      // handling (e.g. reconciliation refunds).
      throw error;
    }
    throw error;
  }

  // 4. Keep the legacy spendable balance mirror in sync.
  await tx.user.update({
    where: { id: input.userId },
    data: { points: newSpendable },
  });

  return {
    applied: true,
    transaction: created,
    account: {
      userId: input.userId,
      spendablePoints: newSpendable,
      lifetimeEarnedPoints: newLifetimeEarned,
      lifetimeSpentPoints: account.lifetimeSpentPoints + deltas.dLifetimeSpent,
      lifetimeRefundedPoints: account.lifetimeRefundedPoints + deltas.dLifetimeRefunded,
      version: account.version + 1,
    },
  };
}

/**
 * Central, atomic, idempotent point mutation. This is the ONLY place that writes
 * both a PointTransaction row and the UserPointAccount aggregate, keeping the
 * legacy `User.points` balance in sync.
 *
 * - If `db` is a transaction client, the mutation joins that transaction.
 * - Otherwise a transaction is opened internally.
 * - Returns `{ applied: false, reason }` for normal duplicate / insufficient
 *   cases; throws only on unexpected system errors.
 */
export async function applyPointLedgerEvent(
  input: ApplyPointLedgerEventInput,
): Promise<ApplyPointLedgerEventResult> {
  const client = input.db ?? prisma;

  if (isBaseClient(client)) {
    try {
      return await client.$transaction((tx) => runLedgerEvent(tx, input, true));
    } catch (error) {
      if (error instanceof DuplicateLedgerRace) {
        return { applied: false, reason: "DUPLICATE" };
      }
      throw error;
    }
  }

  return runLedgerEvent(client, input, false);
}

// ---------------------------------------------------------------------------
// Domain helpers — all route through applyPointLedgerEvent.
// ---------------------------------------------------------------------------

/**
 * Award exactly 1 point for a QR scan. Idempotent per (userId, qrCodeId).
 * Returns true when a point was newly awarded, false on duplicate/no-op.
 * Preserves the historical boolean contract used by scan + merge routes.
 */
export async function awardQrScanPoint(options: {
  userId: string;
  qrCodeId?: string | null;
  db?: PointDbClient;
}): Promise<boolean> {
  const { userId, qrCodeId, db } = options;
  if (!qrCodeId) {
    return false;
  }

  const result = await applyPointLedgerEvent({
    userId,
    points: 1,
    type: "EARN",
    reason: "QR_SCAN",
    sourceType: "QR_SCAN",
    sourceId: qrCodeId,
    idempotencyKey: `qr-scan:${qrCodeId}`,
    qrCodeId,
    db,
  });

  return result.applied;
}

/**
 * Debit spendable points for a Shopify reward redemption. Does not reduce
 * lifetime earned. Conditional so the balance can never go negative.
 */
export async function debitShopifyRewardPoints(options: {
  userId: string;
  pointsCost: number;
  shopifyRewardRedemptionId: string;
  db?: PointDbClient;
}): Promise<ApplyPointLedgerEventResult> {
  return applyPointLedgerEvent({
    userId: options.userId,
    points: options.pointsCost,
    type: "SPEND",
    reason: "SHOPIFY_REWARD_REDEMPTION",
    sourceType: "SHOPIFY_REWARD_REDEMPTION",
    sourceId: options.shopifyRewardRedemptionId,
    idempotencyKey: `shopify-reward-redemption:${options.shopifyRewardRedemptionId}`,
    shopifyRewardRedemptionId: options.shopifyRewardRedemptionId,
    db: options.db,
  });
}

/**
 * Refund spendable points for a reversed Shopify reward. Restores the spendable
 * balance and raises lifetime refunded, but never raises lifetime earned.
 */
export async function refundShopifyRewardPoints(options: {
  userId: string;
  points: number;
  shopifyRewardRedemptionId: string;
  db?: PointDbClient;
}): Promise<ApplyPointLedgerEventResult> {
  return applyPointLedgerEvent({
    userId: options.userId,
    points: options.points,
    type: "REFUND",
    reason: "SHOPIFY_REWARD_REFUND",
    sourceType: "SHOPIFY_REWARD_REFUND",
    sourceId: options.shopifyRewardRedemptionId,
    idempotencyKey: `shopify-reward-refund:${options.shopifyRewardRedemptionId}`,
    shopifyRewardRedemptionId: options.shopifyRewardRedemptionId,
    db: options.db,
  });
}

/**
 * Award a lesson's completion reward once per user per lesson. The reward value
 * is read from the database (never trusted from the client). No-op when the
 * lesson has no reward configured.
 */
export async function awardLessonCompletionPoints(options: {
  userId: string;
  lessonId: string;
  db?: PointDbClient;
}): Promise<ApplyPointLedgerEventResult> {
  const client = options.db ?? prisma;
  const lesson = await client.lesson.findUnique({
    where: { id: options.lessonId },
    select: { completionPointsReward: true },
  });
  const reward = lesson?.completionPointsReward ?? 0;
  if (reward <= 0) {
    return { applied: false, reason: "INVALID" };
  }

  return applyPointLedgerEvent({
    userId: options.userId,
    points: reward,
    type: "EARN",
    reason: "BONUS",
    sourceType: "LESSON_COMPLETION",
    sourceId: options.lessonId,
    idempotencyKey: `lesson-completion:${options.lessonId}`,
    db: options.db,
  });
}

/**
 * Award a course's completion reward once per user per course, but only when the
 * user has completed every active lesson in the course. The reward value is read
 * from the database. No-op for courses with no active lessons or no reward.
 */
export async function awardCourseCompletionPoints(options: {
  userId: string;
  courseId: string;
  db?: PointDbClient;
}): Promise<ApplyPointLedgerEventResult> {
  const client = options.db ?? prisma;

  const course = await client.course.findUnique({
    where: { id: options.courseId },
    select: {
      completionPointsReward: true,
      lessons: { where: { isActive: true }, select: { id: true } },
    },
  });

  const reward = course?.completionPointsReward ?? 0;
  const activeLessonIds = course?.lessons.map((lesson) => lesson.id) ?? [];

  if (reward <= 0 || activeLessonIds.length === 0) {
    return { applied: false, reason: "INVALID" };
  }

  const completedCount = await client.lessonProgress.count({
    where: {
      userId: options.userId,
      isCompleted: true,
      lessonId: { in: activeLessonIds },
    },
  });

  if (completedCount < activeLessonIds.length) {
    return { applied: false, reason: "INVALID" };
  }

  return applyPointLedgerEvent({
    userId: options.userId,
    points: reward,
    type: "EARN",
    reason: "BONUS",
    sourceType: "COURSE_COMPLETION",
    sourceId: options.courseId,
    idempotencyKey: `course-completion:${options.courseId}`,
    db: options.db,
  });
}

// ---------------------------------------------------------------------------
// Read model for the dashboard.
// ---------------------------------------------------------------------------

export async function getUserPointsOverview(userId: string, take = 25) {
  const [user, account, sourceTotals, reasonTotalsForNullSource, transactionCount, transactions] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, points: true },
      }),
      prisma.userPointAccount.findUnique({ where: { userId } }),
      prisma.pointTransaction.groupBy({
        by: ["sourceType"],
        where: { userId },
        _sum: { points: true },
      }),
      // Historical rows created before sourceType existed fall back to reason.
      prisma.pointTransaction.groupBy({
        by: ["reason"],
        where: { userId, sourceType: null },
        _sum: { points: true },
      }),
      prisma.pointTransaction.count({ where: { userId } }),
      prisma.pointTransaction.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take,
        select: {
          id: true,
          points: true,
          reason: true,
          type: true,
          sourceType: true,
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
                  brand: { select: { id: true, name: true, slug: true } },
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

  const bucket = {
    qrPoints: 0,
    bonusPoints: 0,
    referralPoints: 0,
    lessonCompletionPoints: 0,
    courseCompletionPoints: 0,
    shopifyRewardSpentPoints: 0,
    shopifyRewardRefundedPoints: 0,
  };

  const addToBucket = (sourceType: PointSourceType | null, reason: PointReason | null, sum: number) => {
    const key = sourceType ?? reason;
    switch (key) {
      case "QR_SCAN":
        bucket.qrPoints += Math.max(0, sum);
        break;
      case "BONUS":
        bucket.bonusPoints += Math.max(0, sum);
        break;
      case "REFERRAL":
        bucket.referralPoints += Math.max(0, sum);
        break;
      case "LESSON_COMPLETION":
        bucket.lessonCompletionPoints += Math.max(0, sum);
        break;
      case "COURSE_COMPLETION":
        bucket.courseCompletionPoints += Math.max(0, sum);
        break;
      case "SHOPIFY_REWARD_REDEMPTION":
        bucket.shopifyRewardSpentPoints += Math.abs(Math.min(0, sum));
        break;
      case "SHOPIFY_REWARD_REFUND":
        bucket.shopifyRewardRefundedPoints += Math.max(0, sum);
        break;
    }
  };

  for (const row of sourceTotals) {
    if (row.sourceType === null) continue; // handled via reason fallback below
    addToBucket(row.sourceType, null, row._sum.points ?? 0);
  }
  for (const row of reasonTotalsForNullSource) {
    addToBucket(null, row.reason, row._sum.points ?? 0);
  }

  // Prefer the aggregate account; fall back to legacy points / derived buckets.
  const spendablePoints = account?.spendablePoints ?? user.points;
  const lifetimeEarnedPoints =
    account?.lifetimeEarnedPoints ??
    bucket.qrPoints + bucket.bonusPoints + bucket.referralPoints +
      bucket.lessonCompletionPoints + bucket.courseCompletionPoints;
  const lifetimeSpentPoints = account?.lifetimeSpentPoints ?? bucket.shopifyRewardSpentPoints;
  const lifetimeRefundedPoints =
    account?.lifetimeRefundedPoints ?? bucket.shopifyRewardRefundedPoints;

  return {
    user,
    totals: {
      currentPoints: spendablePoints,
      spendablePoints,
      lifetimeEarnedPoints,
      lifetimeSpentPoints,
      lifetimeRefundedPoints,
      transactionCount,
      qrPoints: bucket.qrPoints,
      bonusPoints: bucket.bonusPoints,
      referralPoints: bucket.referralPoints,
      lessonCompletionPoints: bucket.lessonCompletionPoints,
      courseCompletionPoints: bucket.courseCompletionPoints,
      shopifyRewardSpentPoints: bucket.shopifyRewardSpentPoints,
      shopifyRewardRefundedPoints: bucket.shopifyRewardRefundedPoints,
    },
    transactions: transactions.map((item) => ({
      id: item.id,
      points: item.points,
      reason: item.reason,
      type: item.type,
      sourceType: item.sourceType,
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
