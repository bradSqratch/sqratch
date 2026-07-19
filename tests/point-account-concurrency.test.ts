import assert from "node:assert/strict";
import { test } from "node:test";

// ---------------------------------------------------------------------------
// This test exercises real PostgreSQL uniqueness-constraint and transaction
// behavior (concurrent races, aborted-transaction semantics) that an
// in-memory fake Prisma client cannot faithfully reproduce. It requires a
// real, disposable Postgres database — never the configured production/dev
// DATABASE_URL — and is SKIPPED by default so `npm test`/`npm run verify`
// stay fully mockable and safe to run without any database available.
//
// To run it against a disposable local Postgres:
//
//   1. Start a throwaway cluster, e.g.:
//        initdb -D /tmp/sqratch-concurrency-pgdata --no-locale
//        pg_ctl -D /tmp/sqratch-concurrency-pgdata \
//          -o "-p 5547 -k /tmp/sqratch-concurrency-sock -h 127.0.0.1" start
//        createdb -h 127.0.0.1 -p 5547 sqratch_concurrency
//   2. Sync the schema: DATABASE_URL=postgresql://postgres@127.0.0.1:5547/sqratch_concurrency \
//        npx prisma db push --accept-data-loss
//   3. Enable SSL on that cluster (src/lib/prisma.ts requires it by default;
//      a self-signed cert + `ssl = on` in postgresql.conf is sufficient with
//      PG_SSL_REJECT_UNAUTHORIZED=false, see below).
//   4. Run:
//        DATABASE_URL=postgresql://postgres@127.0.0.1:5547/sqratch_concurrency \
//        DIRECT_URL=postgresql://postgres@127.0.0.1:5547/sqratch_concurrency \
//        PG_SSL_REJECT_UNAUTHORIZED=false \
//        POINT_ACCOUNT_CONCURRENCY=true \
//        npx tsx --test tests/point-account-concurrency.test.ts
// ---------------------------------------------------------------------------

const ENABLED = process.env.POINT_ACCOUNT_CONCURRENCY === "true";

test(
  "two concurrent missing-account requests result in exactly one account, with no transaction-aborted error",
  { skip: !ENABLED && "requires POINT_ACCOUNT_CONCURRENCY=true and a real disposable Postgres (see file header)" },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { getUserSpendablePointBalance } = await import("../src/lib/points");

    const user = await prisma.user.create({
      data: {
        name: "Concurrency Test User",
        email: `concurrency-${Date.now()}@test.local`,
        isEmailVerified: true,
        isActive: true,
        role: "USER",
      },
    });

    await prisma.pointTransaction.createMany({
      data: [
        { userId: user.id, points: 1, reason: "QR_SCAN", type: "EARN", idempotencyKey: `qr-scan:${user.id}-a` },
        { userId: user.id, points: 10, reason: "BONUS", type: "EARN", idempotencyKey: `lesson-completion:${user.id}-a` },
      ],
    });

    // No UserPointAccount row exists yet. Fire many concurrent requests for
    // the same missing account and confirm they all succeed and converge.
    const concurrency = 12;
    const results = await Promise.allSettled(
      Array.from({ length: concurrency }, () =>
        getUserSpendablePointBalance({ userId: user.id }),
      ),
    );

    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(
      rejected.length,
      0,
      `expected no rejections, got: ${rejected.map((r) => (r as PromiseRejectedResult).reason).join("; ")}`,
    );

    const values = results.map((r) => (r as PromiseFulfilledResult<number>).value);
    for (const value of values) {
      assert.equal(value, 11); // 1 + 10
    }

    const accountRows = await prisma.userPointAccount.findMany({ where: { userId: user.id } });
    assert.equal(accountRows.length, 1, "expected exactly one UserPointAccount row after the race");
    assert.equal(accountRows[0].spendablePoints, 11);
    assert.equal(accountRows[0].lifetimeEarnedPoints, 11);

    await prisma.pointTransaction.deleteMany({ where: { userId: user.id } });
    await prisma.userPointAccount.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  },
);

test(
  "getUserPointsOverview and ensureAccount (via getUserSpendablePointBalance) produce matching reconstructed lifetime totals",
  { skip: !ENABLED && "requires POINT_ACCOUNT_CONCURRENCY=true and a real disposable Postgres (see file header)" },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { getUserSpendablePointBalance, getUserPointsOverview } = await import("../src/lib/points");

    const user = await prisma.user.create({
      data: {
        name: "Matching Totals User",
        email: `matching-totals-${Date.now()}@test.local`,
        isEmailVerified: true,
        isActive: true,
        role: "USER",
      },
    });

    await prisma.pointTransaction.createMany({
      data: [
        { userId: user.id, points: 1, reason: "QR_SCAN", type: "EARN", idempotencyKey: `qr-scan:${user.id}-b` },
        { userId: user.id, points: 10, reason: "BONUS", type: "EARN", sourceType: "LESSON_COMPLETION", idempotencyKey: `lesson-completion:${user.id}-b` },
        { userId: user.id, points: 50, reason: "BONUS", type: "EARN", sourceType: "COURSE_COMPLETION", idempotencyKey: `course-completion:${user.id}-b` },
        { userId: user.id, points: -40, reason: "SHOPIFY_REWARD_REDEMPTION", type: "SPEND", idempotencyKey: `shopify-reward-redemption:${user.id}-b` },
        { userId: user.id, points: 40, reason: "SHOPIFY_REWARD_REFUND", type: "REFUND", idempotencyKey: `shopify-reward-refund:${user.id}-b` },
      ],
    });

    // No UserPointAccount row yet — getUserPointsOverview exercises its own
    // missing-account fallback derivation (never persists a row).
    const overview = await getUserPointsOverview(user.id);
    assert.ok(overview);

    const accountBefore = await prisma.userPointAccount.findUnique({ where: { userId: user.id } });
    assert.equal(accountBefore, null, "getUserPointsOverview must not persist an account row");

    // Now trigger the real self-heal path, which does persist a row.
    const spendable = await getUserSpendablePointBalance({ userId: user.id });
    const account = await prisma.userPointAccount.findUnique({ where: { userId: user.id } });
    assert.ok(account, "expected ensureAccount to have persisted a UserPointAccount row");

    assert.equal(spendable, 61); // 1 + 10 + 50 - 40 + 40
    assert.equal(overview!.totals.spendablePoints, account!.spendablePoints);
    assert.equal(overview!.totals.lifetimeEarnedPoints, account!.lifetimeEarnedPoints);
    assert.equal(overview!.totals.lifetimeSpentPoints, account!.lifetimeSpentPoints);
    assert.equal(overview!.totals.lifetimeRefundedPoints, account!.lifetimeRefundedPoints);

    assert.equal(account!.spendablePoints, 61);
    assert.equal(account!.lifetimeEarnedPoints, 61);
    assert.equal(account!.lifetimeSpentPoints, 40);
    assert.equal(account!.lifetimeRefundedPoints, 40);

    await prisma.pointTransaction.deleteMany({ where: { userId: user.id } });
    await prisma.userPointAccount.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  },
);
