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
//
// Deliberately has NO `user.update` method and the `user` fake only tracks
// existence (an id), never a points balance — UserPointAccount is the only
// balance store the ledger may write to. If a regression reintroduces a
// write to User.points, this mock throws "db.user.update is not a function"
// rather than silently succeeding.
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
  /** Users known to exist (existence only — no legacy balance). */
  userIds?: string[];
  accounts?: AccountRow[];
  transactions?: Partial<TxRow>[];
  lessons?: Record<string, { completionPointsReward: number }>;
  courses?: Record<string, { completionPointsReward: number; lessonIds: string[] }>;
  completedLessons?: Record<string, string[]>; // userId -> completed lessonIds
}

function makeFakeDb(seed: FakeSeed = {}) {
  const existingUserIds = new Set(seed.userIds ?? []);
  const accounts = new Map<string, AccountRow>();
  for (const acc of seed.accounts ?? []) accounts.set(acc.userId, { ...acc });
  const txs: TxRow[] = (seed.transactions ?? []).map((t, i) => ({
    id: `seed-${i}`,
    userId: "",
    points: 0,
    reason: "QR_SCAN",
    type: "EARN",
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
        existingUserIds.has(where.id) ? { id: where.id } : null,
      // No `update` method: the ledger must never write to the User table.
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
      upsert: async ({
        where,
        create,
      }: {
        where: { userId: string };
        update: Record<string, unknown>;
        create: AccountRow;
      }) => {
        // Mirrors real atomic upsert semantics: an existing row always wins
        // unchanged (the real call site always passes `update: {}`).
        const existing = accounts.get(where.userId);
        if (existing) return { ...existing };
        const row: AccountRow = { ...create };
        accounts.set(where.userId, row);
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
      groupBy: async ({ where, by }: { where: { userId: string }; by?: string[] }) => {
        const groupByType = Boolean(by?.includes("type"));
        const map = new Map<string, { reason: unknown; type: unknown; sum: number }>();
        for (const t of txs.filter((r) => r.userId === where.userId)) {
          const key = groupByType ? `${String(t.reason)}::${String(t.type)}` : String(t.reason);
          const existing = map.get(key);
          map.set(key, {
            reason: t.reason,
            type: t.type,
            sum: (existing?.sum ?? 0) + t.points,
          });
        }
        return Array.from(map.values()).map(({ reason, type, sum }) =>
          groupByType
            ? { reason, type, _sum: { points: sum } }
            : { reason, _sum: { points: sum } },
        );
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

  test("invariant: dSpendable always equals ledgerPoints for every type", () => {
    // This is the exact invariant `ensureAccount` relies on to self-heal a
    // missing account's spendable balance purely from SUM(PointTransaction.points) —
    // never from any other source.
    for (const [type, points] of [
      ["EARN", 5],
      ["REFUND", 8],
      ["SPEND", 30],
      ["ADJUSTMENT", -12],
    ] as const) {
      const r = computeLedgerDeltas(type, points);
      assert.ok(r.ok);
      assert.equal(r.ok && r.deltas.dSpendable, r.ok && r.deltas.ledgerPoints);
    }
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
  test("awards 1 spendable + 1 lifetime earned, updating only the point account", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      accounts: [seededAccount("u1", 3)],
    });
    const applied = await awardQrScanPoint({ userId: "u1", qrCodeId: "qr-1", db: f.db });
    assert.equal(applied, true);
    const acc = f.accounts.get("u1")!;
    assert.equal(acc.spendablePoints, 4);
    assert.equal(acc.lifetimeEarnedPoints, 4);
    assert.equal(f.txs.length, 1);
    assert.equal(f.txs[0].points, 1);
  });

  test("duplicate QR does not double-award", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      accounts: [seededAccount("u1", 0)],
    });
    const first = await awardQrScanPoint({ userId: "u1", qrCodeId: "qr-1", db: f.db });
    const second = await awardQrScanPoint({ userId: "u1", qrCodeId: "qr-1", db: f.db });
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(f.accounts.get("u1")!.spendablePoints, 1);
    assert.equal(f.txs.length, 1);
  });

  test("missing account is created safely, self-healed purely from ledger history (no legacy balance involved)", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      transactions: [{ userId: "u1", points: 10, reason: "QR_SCAN", qrCodeId: "old" }],
    });
    await awardQrScanPoint({ userId: "u1", qrCodeId: "new", db: f.db });
    const acc = f.accounts.get("u1")!;
    assert.equal(acc.spendablePoints, 11); // 10 from prior ledger row + 1 new
    assert.equal(acc.lifetimeEarnedPoints, 11); // derived from the same ledger rows
  });

  test("a genuinely new user (no prior ledger history) gets a zeroed account, never a fabricated balance", async () => {
    const f = makeFakeDb({ userIds: ["u1"] });
    const balance = await getUserSpendablePointBalance({ userId: "u1", db: f.db });
    assert.equal(balance, 0);
    const acc = f.accounts.get("u1")!;
    assert.equal(acc.spendablePoints, 0);
    assert.equal(acc.lifetimeEarnedPoints, 0);
    assert.equal(acc.lifetimeSpentPoints, 0);
    assert.equal(acc.lifetimeRefundedPoints, 0);
  });
});

describe("Shopify redemption debit", () => {
  test("reads the spendable balance from the existing point account, never re-derived", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
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
      userIds: ["u1"],
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
    assert.equal(f.txs[0].points, -40); // negative ledger row
  });

  test("insufficient balance does not create a transaction", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
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

  test("records a deterministic campaignId in metadata without changing point math", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      accounts: [seededAccount("u1", 100)],
    });
    const res = await debitShopifyRewardPoints({
      userId: "u1",
      pointsCost: 40,
      shopifyRewardRedemptionId: "r1",
      campaignId: "camp-1",
      db: f.db,
    });
    assert.equal(res.applied, true);
    assert.deepEqual(f.txs[0].metadata, { campaignId: "camp-1" });
    assert.equal(f.accounts.get("u1")!.spendablePoints, 60);
    assert.equal(f.txs[0].points, -40);
  });

  test("omits metadata when no deterministic campaign was resolved", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      accounts: [seededAccount("u1", 100)],
    });
    await debitShopifyRewardPoints({
      userId: "u1",
      pointsCost: 40,
      shopifyRewardRedemptionId: "r1",
      campaignId: null,
      db: f.db,
    });
    assert.equal(f.txs[0].metadata, undefined);
  });
});

describe("Shopify refund", () => {
  test("restores spendable + lifetime refunded, lifetime earned unchanged", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
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
      userIds: ["u1"],
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

  test("records a deterministic campaignId in metadata without changing refund math", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      accounts: [seededAccount("u1", 60)],
    });
    const res = await refundShopifyRewardPoints({
      userId: "u1",
      points: 40,
      shopifyRewardRedemptionId: "r1",
      campaignId: "camp-1",
      db: f.db,
    });
    assert.equal(res.applied, true);
    assert.deepEqual(f.txs[0].metadata, { campaignId: "camp-1" });
    assert.equal(f.accounts.get("u1")!.spendablePoints, 100);
    assert.equal(f.accounts.get("u1")!.lifetimeEarnedPoints, 60); // still NOT raised
  });
});

describe("Lesson completion", () => {
  test("awards once when reward > 0", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
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
      userIds: ["u1"],
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
      userIds: ["u1"],
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
    userIds: ["u1"],
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
      userIds: ["u1"],
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
      userIds: ["u1"],
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
      userIds: ["u1"],
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

describe("Account creation never touches the User table", () => {
  test("ensureAccount only reads the user's existence (id), never a balance field", async () => {
    // The fake db's `user.findUnique` only ever returns `{ id }` — if
    // `ensureAccount` tried to read a balance field from it, this test's
    // seed intentionally provides no such field, so any accidental read
    // would surface as `undefined` flowing into the new account instead of
    // 0, which the assertions below would catch.
    const f = makeFakeDb({ userIds: ["u1"] });
    await getUserSpendablePointBalance({ userId: "u1", db: f.db });
    const acc = f.accounts.get("u1")!;
    assert.equal(acc.spendablePoints, 0);
    assert.notEqual(acc.spendablePoints, undefined);
  });

  test("an existing account is returned as-is and is never overwritten by any other source", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      accounts: [seededAccount("u1", 42)],
      // Ledger history disagrees with the account (would sum to 999 if ever
      // re-derived) — proves the existing account row wins outright and is
      // never recomputed from the ledger while it already exists.
      transactions: [{ userId: "u1", points: 999, reason: "BONUS" }],
    });
    const balance = await getUserSpendablePointBalance({ userId: "u1", db: f.db });
    assert.equal(balance, 42);
  });
});

describe("Missing-account lifetime reconstruction — classified by (reason, type), not reason alone", () => {
  test("includes lesson completion earnings (reason=BONUS, sourceType=LESSON_COMPLETION, type=EARN)", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      transactions: [
        {
          userId: "u1",
          points: 10,
          reason: "BONUS",
          type: "EARN",
          sourceType: "LESSON_COMPLETION",
          sourceId: "lesson-1",
        },
      ],
    });
    const balance = await getUserSpendablePointBalance({ userId: "u1", db: f.db });
    const acc = f.accounts.get("u1")!;
    assert.equal(balance, 10);
    assert.equal(acc.spendablePoints, 10);
    assert.equal(acc.lifetimeEarnedPoints, 10);
  });

  test("includes course completion earnings (reason=BONUS, sourceType=COURSE_COMPLETION, type=EARN)", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      transactions: [
        {
          userId: "u1",
          points: 50,
          reason: "BONUS",
          type: "EARN",
          sourceType: "COURSE_COMPLETION",
          sourceId: "course-1",
        },
      ],
    });
    const balance = await getUserSpendablePointBalance({ userId: "u1", db: f.db });
    const acc = f.accounts.get("u1")!;
    assert.equal(balance, 50);
    assert.equal(acc.spendablePoints, 50);
    assert.equal(acc.lifetimeEarnedPoints, 50);
  });

  test("lesson and course completions combine correctly alongside QR scans", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      transactions: [
        { userId: "u1", points: 1, reason: "QR_SCAN", type: "EARN", qrCodeId: "qr-1" },
        { userId: "u1", points: 10, reason: "BONUS", type: "EARN", sourceType: "LESSON_COMPLETION" },
        { userId: "u1", points: 50, reason: "BONUS", type: "EARN", sourceType: "COURSE_COMPLETION" },
      ],
    });
    const acc0 = await getUserSpendablePointBalance({ userId: "u1", db: f.db });
    const acc = f.accounts.get("u1")!;
    assert.equal(acc0, 61);
    assert.equal(acc.spendablePoints, 61);
    assert.equal(acc.lifetimeEarnedPoints, 61);
  });

  test("spendable equals the signed sum of every ledger row, including SPEND and REFUND rows", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      transactions: [
        { userId: "u1", points: 100, reason: "BONUS", type: "EARN" },
        {
          userId: "u1",
          points: -40,
          reason: "SHOPIFY_REWARD_REDEMPTION",
          type: "SPEND",
          shopifyRewardRedemptionId: "r1",
        },
        {
          userId: "u1",
          points: 40,
          reason: "SHOPIFY_REWARD_REFUND",
          type: "REFUND",
          shopifyRewardRedemptionId: "r1",
        },
      ],
    });
    const balance = await getUserSpendablePointBalance({ userId: "u1", db: f.db });
    const acc = f.accounts.get("u1")!;
    assert.equal(balance, 100); // 100 - 40 + 40
    assert.equal(acc.spendablePoints, 100);
    assert.equal(acc.lifetimeEarnedPoints, 100);
    assert.equal(acc.lifetimeSpentPoints, 40);
    assert.equal(acc.lifetimeRefundedPoints, 40);
  });

  test("ADJUSTMENT rows affect spendable but are never counted as lifetime earned, even with reason=BONUS", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      transactions: [
        { userId: "u1", points: 10, reason: "BONUS", type: "EARN" },
        // A manual adjustment that happens to carry reason=BONUS. Must not
        // be conflated with a genuine EARN just because the reason matches.
        { userId: "u1", points: 5, reason: "BONUS", type: "ADJUSTMENT" },
      ],
    });
    const balance = await getUserSpendablePointBalance({ userId: "u1", db: f.db });
    const acc = f.accounts.get("u1")!;
    assert.equal(balance, 15); // 10 + 5 — adjustment still affects spendable
    assert.equal(acc.spendablePoints, 15);
    assert.equal(acc.lifetimeEarnedPoints, 10); // the ADJUSTMENT's +5 excluded
  });

  test("a negative ADJUSTMENT lowers spendable without touching any lifetime bucket", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      transactions: [
        { userId: "u1", points: 20, reason: "BONUS", type: "EARN" },
        { userId: "u1", points: -8, reason: "BONUS", type: "ADJUSTMENT" },
      ],
    });
    const balance = await getUserSpendablePointBalance({ userId: "u1", db: f.db });
    const acc = f.accounts.get("u1")!;
    assert.equal(balance, 12); // 20 - 8
    assert.equal(acc.lifetimeEarnedPoints, 20);
    assert.equal(acc.lifetimeSpentPoints, 0);
    assert.equal(acc.lifetimeRefundedPoints, 0);
  });
});

describe("Concurrent account creation (atomic upsert)", () => {
  test("upsert never overwrites a pre-existing account with freshly-derived ledger values", async () => {
    const f = makeFakeDb({
      userIds: ["u1"],
      accounts: [seededAccount("u1", 7)],
      transactions: [{ userId: "u1", points: 999, reason: "BONUS", type: "EARN" }],
    });
    const balance = await getUserSpendablePointBalance({ userId: "u1", db: f.db });
    assert.equal(balance, 7);
    assert.equal(f.accounts.get("u1")!.spendablePoints, 7);
  });

  test("does not throw when the account row is created between the existence check and the upsert", async () => {
    const f = makeFakeDb({ userIds: ["u1"] });
    // Simulate a concurrent request winning the race right before this
    // call's upsert runs.
    f.accounts.set("u1", seededAccount("u1", 3));
    const balance = await getUserSpendablePointBalance({ userId: "u1", db: f.db });
    assert.equal(balance, 3);
  });
});
