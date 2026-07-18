import "./env-setup"; // DATABASE_URL before points → prisma import
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { Prisma } from "@prisma/client";
import {
  computeLedgerDeltas,
  getUserSpendablePointBalance,
  applyPointLedgerEvent,
  awardQrScanPoint,
  debitShopifyRewardPoints,
  refundShopifyRewardPoints,
  awardLessonCompletionPoints,
  awardCourseCompletionPoints,
} from "../src/lib/points";

// ---------------------------------------------------------------------------
// Minimal in-memory fake of the Prisma methods the ledger uses. Passed as `db`
// so applyPointLedgerEvent runs directly against it (no real database).
// ---------------------------------------------------------------------------

type AccountRow = {
  userId: string;
  spendablePoints: number;
  lifetimeEarnedPoints: number;
  lifetimeSpentPoints: number;
  lifetimeRefundedPoints: number;
  version: number;
};
type TxRow = Record<string, unknown> & {
  id: string;
  userId: string;
  points: number;
  reason: string;
  idempotencyKey: string | null;
  qrCodeId: string | null;
  shopifyRewardRedemptionId: string | null;
};

function makeP2002(target: string[]) {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta: { target },
  });
}

function applyOps<T extends Record<string, unknown>>(
  current: T,
  data: Record<string, unknown>,
): T {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === "object" && "increment" in value) {
      next[key] = (next[key] as number) + (value as { increment: number }).increment;
    } else if (value && typeof value === "object" && "decrement" in value) {
      next[key] = (next[key] as number) - (value as { decrement: number }).decrement;
    } else {
      next[key] = value;
    }
  }
  return next as T;
}

interface FakeSeed {
  users?: Record<string, { points: number }>;
  accounts?: AccountRow[];
  transactions?: Partial<TxRow>[];
  lessons?: Record<string, { completionPointsReward: number }>;
  courses?: Record<string, { completionPointsReward: number; lessonIds: string[] }>;
  completedLessons?: Record<string, string[]>; // userId -> completed lessonIds
}

function makeFakeDb(seed: FakeSeed = {}) {
  const users: Record<string, { points: number }> = { ...(seed.users ?? {}) };
  const accounts = new Map<string, AccountRow>();
  for (const acc of seed.accounts ?? []) accounts.set(acc.userId, { ...acc });
  const txs: TxRow[] = (seed.transactions ?? []).map((t, i) => ({
    id: `seed-${i}`,
    userId: "",
    points: 0,
    reason: "QR_SCAN",
    idempotencyKey: null,
    qrCodeId: null,
    shopifyRewardRedemptionId: null,
    ...t,
  }));
  const lessons = seed.lessons ?? {};
  const courses = seed.courses ?? {};
  const completed = seed.completedLessons ?? {};

  const db = {
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        users[where.id] ? { points: users[where.id].points } : null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        users[where.id] = applyOps(users[where.id], data);
        return users[where.id];
      },
    },
    userPointAccount: {
      findUnique: async ({ where }: { where: { userId: string } }) => {
        const acc = accounts.get(where.userId);
        return acc ? { ...acc } : null;
      },
      create: async ({ data }: { data: AccountRow }) => {
        if (accounts.has(data.userId)) throw makeP2002(["userId"]);
        const row: AccountRow = { ...data };
        accounts.set(data.userId, row);
        return { ...row };
      },
      update: async ({ where, data }: { where: { userId: string }; data: Record<string, unknown> }) => {
        const acc = accounts.get(where.userId)!;
        const updated = applyOps(acc, data);
        accounts.set(where.userId, updated);
        return { ...updated };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { userId: string; spendablePoints?: { gte: number } };
        data: Record<string, unknown>;
      }) => {
        const acc = accounts.get(where.userId);
        if (!acc) return { count: 0 };
        if (where.spendablePoints && acc.spendablePoints < where.spendablePoints.gte) {
          return { count: 0 };
        }
        accounts.set(where.userId, applyOps(acc, data));
        return { count: 1 };
      },
    },
    pointTransaction: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) => {
        const key = where.uq_point_tx_user_idempotency_key as
          | { userId: string; idempotencyKey: string | null }
          | undefined;
        if (key && key.idempotencyKey != null) {
          const found = txs.find(
            (t) => t.userId === key.userId && t.idempotencyKey === key.idempotencyKey,
          );
          return found ? { id: found.id } : null;
        }
        return null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (
          data.idempotencyKey != null &&
          txs.some((t) => t.userId === data.userId && t.idempotencyKey === data.idempotencyKey)
        ) {
          throw makeP2002(["userId", "idempotencyKey"]);
        }
        if (
          data.qrCodeId != null &&
          txs.some((t) => t.userId === data.userId && t.qrCodeId === data.qrCodeId)
        ) {
          throw makeP2002(["userId", "qrCodeId"]);
        }
        if (
          data.shopifyRewardRedemptionId != null &&
          txs.some(
            (t) =>
              t.shopifyRewardRedemptionId === data.shopifyRewardRedemptionId &&
              t.reason === data.reason,
          )
        ) {
          throw makeP2002(["shopifyRewardRedemptionId", "reason"]);
        }
        const row = {
          id: `tx-${txs.length + 1}`,
          createdAt: new Date(),
          ...data,
        } as unknown as TxRow;
        txs.push(row);
        return row;
      },
      groupBy: async ({ where }: { where: { userId: string } }) => {
        const map = new Map<string, number>();
        for (const t of txs.filter((r) => r.userId === where.userId)) {
          map.set(t.reason, (map.get(t.reason) ?? 0) + t.points);
        }
        return Array.from(map.entries()).map(([reason, sum]) => ({
          reason,
          _sum: { points: sum },
        }));
      },
    },
    lesson: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        lessons[where.id] ? { completionPointsReward: lessons[where.id].completionPointsReward } : null,
    },
    course: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const c = courses[where.id];
        return c
          ? {
              completionPointsReward: c.completionPointsReward,
              lessons: c.lessonIds.map((id) => ({ id })),
            }
          : null;
      },
    },
    lessonProgress: {
      count: async ({
        where,
      }: {
        where: { userId: string; isCompleted: boolean; lessonId: { in: string[] } };
      }) => {
        const set = new Set(completed[where.userId] ?? []);
        return where.lessonId.in.filter((id) => set.has(id) && where.isCompleted).length;
      },
    },
  };

  return {
    db: db as unknown as Prisma.TransactionClient,
    accounts,
    txs,
    users,
  };
}

// ---------------------------------------------------------------------------
// Pure delta math (mirrors manual-production-backfill.sql classification).
// ---------------------------------------------------------------------------

describe("computeLedgerDeltas", () => {
  test("EARN raises spendable + lifetime earned only", () => {
    const r = computeLedgerDeltas("EARN", 5);
    assert.ok(r.ok && r.deltas.ledgerPoints === 5);
    assert.deepEqual(r.ok && r.deltas, {
      ledgerPoints: 5,
      dSpendable: 5,
      dLifetimeEarned: 5,
      dLifetimeSpent: 0,
      dLifetimeRefunded: 0,
    });
  });

  test("REFUND raises spendable + lifetime refunded, NOT lifetime earned", () => {
    const r = computeLedgerDeltas("REFUND", 8);
    assert.ok(r.ok);
    assert.equal(r.ok && r.deltas.dLifetimeEarned, 0);
    assert.equal(r.ok && r.deltas.dLifetimeRefunded, 8);
    assert.equal(r.ok && r.deltas.dSpendable, 8);
  });

  test("SPEND normalises to a negative ledger row and raises lifetime spent", () => {
    const positive = computeLedgerDeltas("SPEND", 30);
    const negative = computeLedgerDeltas("SPEND", -30);
    assert.ok(positive.ok && negative.ok);
    assert.equal(positive.ok && positive.deltas.ledgerPoints, -30);
    assert.equal(negative.ok && negative.deltas.ledgerPoints, -30);
    assert.equal(positive.ok && positive.deltas.dLifetimeSpent, 30);
    assert.equal(positive.ok && positive.deltas.dLifetimeEarned, 0);
  });

  test("ADJUSTMENT does not raise lifetime earned unless flagged", () => {
    const plain = computeLedgerDeltas("ADJUSTMENT", 10);
    const flagged = computeLedgerDeltas("ADJUSTMENT", 10, { countsAsLifetimeEarned: true });
    assert.equal(plain.ok && plain.deltas.dLifetimeEarned, 0);
    assert.equal(flagged.ok && flagged.deltas.dLifetimeEarned, 10);
  });

  test("rejects invalid values", () => {
    assert.equal(computeLedgerDeltas("EARN", 0).ok, false);
    assert.equal(computeLedgerDeltas("EARN", -1).ok, false);
    assert.equal(computeLedgerDeltas("REFUND", -5).ok, false);
    assert.equal(computeLedgerDeltas("SPEND", 0).ok, false);
    assert.equal(computeLedgerDeltas("EARN", 1.5).ok, false);
    assert.equal(computeLedgerDeltas("ADJUSTMENT", 0).ok, false);
  });
});

function seededAccount(userId: string, spendable: number): AccountRow {
  return {
    userId,
    spendablePoints: spendable,
    lifetimeEarnedPoints: spendable,
    lifetimeSpentPoints: 0,
    lifetimeRefundedPoints: 0,
    version: 0,
  };
}

describe("QR scan award", () => {
  test("awards 1 spendable + 1 lifetime earned and keeps User.points synced", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 3 } },
      accounts: [seededAccount("u1", 3)],
    });
    const applied = await awardQrScanPoint({ userId: "u1", qrCodeId: "qr-1", db: f.db });
    assert.equal(applied, true);
    const acc = f.accounts.get("u1")!;
    assert.equal(acc.spendablePoints, 4);
    assert.equal(acc.lifetimeEarnedPoints, 4);
    assert.equal(f.users.u1.points, 4); // legacy mirror
    assert.equal(f.txs.length, 1);
    assert.equal(f.txs[0].points, 1);
  });

  test("duplicate QR does not double-award", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 0 } },
      accounts: [seededAccount("u1", 0)],
    });
    const first = await awardQrScanPoint({ userId: "u1", qrCodeId: "qr-1", db: f.db });
    const second = await awardQrScanPoint({ userId: "u1", qrCodeId: "qr-1", db: f.db });
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(f.accounts.get("u1")!.spendablePoints, 1);
    assert.equal(f.txs.length, 1);
  });

  test("self-heals a missing account from legacy points + ledger", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 10 } },
      transactions: [{ userId: "u1", points: 10, reason: "QR_SCAN", qrCodeId: "old" }],
    });
    await awardQrScanPoint({ userId: "u1", qrCodeId: "new", db: f.db });
    const acc = f.accounts.get("u1")!;
    assert.equal(acc.spendablePoints, 11); // 10 legacy + 1
    assert.equal(acc.lifetimeEarnedPoints, 11); // 10 derived + 1
  });
});

describe("Shopify redemption debit", () => {
  test("reads the point-account spendable balance instead of the legacy User.points mirror", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 999 } },
      accounts: [seededAccount("u1", 12)],
    });

    const balance = await getUserSpendablePointBalance({
      userId: "u1",
      db: f.db,
    });

    assert.equal(balance, 12);
  });

  test("decreases spendable + lifetime spent, lifetime earned unchanged", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 100 } },
      accounts: [seededAccount("u1", 100)],
    });
    const res = await debitShopifyRewardPoints({
      userId: "u1",
      pointsCost: 40,
      shopifyRewardRedemptionId: "r1",
      db: f.db,
    });
    assert.equal(res.applied, true);
    const acc = f.accounts.get("u1")!;
    assert.equal(acc.spendablePoints, 60);
    assert.equal(acc.lifetimeSpentPoints, 40);
    assert.equal(acc.lifetimeEarnedPoints, 100); // unchanged
    assert.equal(f.users.u1.points, 60);
    assert.equal(f.txs[0].points, -40); // negative ledger row
  });

  test("insufficient balance does not create a transaction", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 10 } },
      accounts: [seededAccount("u1", 10)],
    });
    const res = await debitShopifyRewardPoints({
      userId: "u1",
      pointsCost: 50,
      shopifyRewardRedemptionId: "r1",
      db: f.db,
    });
    assert.equal(res.applied, false);
    assert.equal(res.applied === false && res.reason, "INSUFFICIENT_POINTS");
    assert.equal(f.accounts.get("u1")!.spendablePoints, 10);
    assert.equal(f.txs.length, 0);
  });
});

describe("Shopify refund", () => {
  test("restores spendable + lifetime refunded, lifetime earned unchanged", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 60 } },
      accounts: [
        {
          userId: "u1",
          spendablePoints: 60,
          lifetimeEarnedPoints: 100,
          lifetimeSpentPoints: 40,
          lifetimeRefundedPoints: 0,
          version: 1,
        },
      ],
    });
    const res = await refundShopifyRewardPoints({
      userId: "u1",
      points: 40,
      shopifyRewardRedemptionId: "r1",
      db: f.db,
    });
    assert.equal(res.applied, true);
    const acc = f.accounts.get("u1")!;
    assert.equal(acc.spendablePoints, 100);
    assert.equal(acc.lifetimeRefundedPoints, 40);
    assert.equal(acc.lifetimeEarnedPoints, 100); // NOT raised
  });

  test("duplicate refund does not double-increment", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 60 } },
      accounts: [seededAccount("u1", 60)],
    });
    const first = await refundShopifyRewardPoints({
      userId: "u1",
      points: 40,
      shopifyRewardRedemptionId: "r1",
      db: f.db,
    });
    const second = await refundShopifyRewardPoints({
      userId: "u1",
      points: 40,
      shopifyRewardRedemptionId: "r1",
      db: f.db,
    });
    assert.equal(first.applied, true);
    assert.equal(second.applied, false);
    assert.equal(f.accounts.get("u1")!.spendablePoints, 100); // +40 once only
    assert.equal(f.txs.length, 1);
  });
});

describe("Lesson completion", () => {
  test("awards once when reward > 0", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 0 } },
      accounts: [seededAccount("u1", 0)],
      lessons: { l1: { completionPointsReward: 25 } },
    });
    const res = await awardLessonCompletionPoints({ userId: "u1", lessonId: "l1", db: f.db });
    assert.equal(res.applied, true);
    assert.equal(f.accounts.get("u1")!.spendablePoints, 25);
    assert.equal(f.accounts.get("u1")!.lifetimeEarnedPoints, 25);
  });

  test("repeat completion does not double-award", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 0 } },
      accounts: [seededAccount("u1", 0)],
      lessons: { l1: { completionPointsReward: 25 } },
    });
    await awardLessonCompletionPoints({ userId: "u1", lessonId: "l1", db: f.db });
    const second = await awardLessonCompletionPoints({ userId: "u1", lessonId: "l1", db: f.db });
    assert.equal(second.applied, false);
    assert.equal(f.accounts.get("u1")!.spendablePoints, 25);
    assert.equal(f.txs.length, 1);
  });

  test("reward of 0 creates no transaction", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 0 } },
      accounts: [seededAccount("u1", 0)],
      lessons: { l1: { completionPointsReward: 0 } },
    });
    const res = await awardLessonCompletionPoints({ userId: "u1", lessonId: "l1", db: f.db });
    assert.equal(res.applied, false);
    assert.equal(f.txs.length, 0);
  });
});

describe("Course completion", () => {
  const base = () => ({
    users: { u1: { points: 0 } },
    accounts: [seededAccount("u1", 0)],
    courses: { c1: { completionPointsReward: 100, lessonIds: ["l1", "l2"] } },
  });

  test("awards once when all active lessons complete", async () => {
    const f = makeFakeDb({ ...base(), completedLessons: { u1: ["l1", "l2"] } });
    const res = await awardCourseCompletionPoints({ userId: "u1", courseId: "c1", db: f.db });
    assert.equal(res.applied, true);
    assert.equal(f.accounts.get("u1")!.spendablePoints, 100);
  });

  test("does not award when course incomplete", async () => {
    const f = makeFakeDb({ ...base(), completedLessons: { u1: ["l1"] } });
    const res = await awardCourseCompletionPoints({ userId: "u1", courseId: "c1", db: f.db });
    assert.equal(res.applied, false);
    assert.equal(f.txs.length, 0);
  });

  test("course with zero active lessons does not award", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 0 } },
      accounts: [seededAccount("u1", 0)],
      courses: { c1: { completionPointsReward: 100, lessonIds: [] } },
      completedLessons: { u1: [] },
    });
    const res = await awardCourseCompletionPoints({ userId: "u1", courseId: "c1", db: f.db });
    assert.equal(res.applied, false);
  });

  test("duplicate course completion does not double-award", async () => {
    const f = makeFakeDb({ ...base(), completedLessons: { u1: ["l1", "l2"] } });
    await awardCourseCompletionPoints({ userId: "u1", courseId: "c1", db: f.db });
    const second = await awardCourseCompletionPoints({ userId: "u1", courseId: "c1", db: f.db });
    assert.equal(second.applied, false);
    assert.equal(f.accounts.get("u1")!.spendablePoints, 100);
    assert.equal(f.txs.length, 1);
  });
});

describe("Progress-merge idempotency guarantee", () => {
  // Merge re-runs the same award helpers; a reward already granted before the
  // merge must never be granted a second time.
  test("re-awarding an already-granted lesson is a no-op", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 25 } },
      accounts: [seededAccount("u1", 25)],
      lessons: { l1: { completionPointsReward: 25 } },
      transactions: [
        {
          userId: "u1",
          points: 25,
          reason: "BONUS",
          idempotencyKey: "lesson-completion:l1",
        },
      ],
    });
    const res = await awardLessonCompletionPoints({ userId: "u1", lessonId: "l1", db: f.db });
    assert.equal(res.applied, false);
    assert.equal(f.accounts.get("u1")!.spendablePoints, 25);
    assert.equal(f.txs.length, 1);
  });
});

describe("applyPointLedgerEvent invalid input", () => {
  test("negative EARN is rejected without mutation", async () => {
    const f = makeFakeDb({
      users: { u1: { points: 5 } },
      accounts: [seededAccount("u1", 5)],
    });
    const res = await applyPointLedgerEvent({
      userId: "u1",
      points: -5,
      type: "EARN",
      reason: "BONUS",
      db: f.db,
    });
    assert.equal(res.applied, false);
    assert.equal(res.applied === false && res.reason, "INVALID");
    assert.equal(f.txs.length, 0);
    assert.equal(f.accounts.get("u1")!.spendablePoints, 5);
  });
});
