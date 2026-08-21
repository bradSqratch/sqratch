import assert from "node:assert/strict";
import { test } from "node:test";
import { canUseRealDatabaseUnderTest } from "../src/lib/db-safety";

// ---------------------------------------------------------------------------
// This test exercises real PostgreSQL uniqueness-constraint and transaction
// behavior (concurrent races, aborted-transaction semantics) that an
// in-memory fake Prisma client cannot faithfully reproduce. It requires a
// real, disposable Postgres database — never the configured production/dev
// DATABASE_URL — and is SKIPPED by default so `npm test`/`npm run verify`
// stay fully mockable and safe to run without any database available.
//
// The documented invariant this code enforces (do not weaken this without
// updating both): POINT_ACCOUNT_CONCURRENCY=true alone is NOT sufficient to
// run these tests for real. Running against a real database additionally
// requires the full three-part opt-in from src/lib/db-safety.ts's
// canUseRealDatabaseUnderTest — (a) ALLOW_REAL_DATABASE_TESTS=true, (b) a
// loopback/local DATABASE_URL host (never a production Supabase host), and
// (c) a database name ending in "_test". This ensures that setting
// POINT_ACCOUNT_CONCURRENCY=true by itself (e.g. by mistake, or via a stale
// shell export) can never cause a real write against whatever DATABASE_URL
// happens to be configured — it merely requests the test; the db-safety gate
// separately decides whether a real database may actually be touched.
//
// IMPORTANT: canUseRealDatabaseUnderTest's three conditions are evaluated
// UNCONDITIONALLY — this gate does NOT depend on test-mode detection (there
// is no "isTestEnvironment" input to it at all). That is deliberate: this
// file's own header tells a developer to run it directly with
// `npx tsx --test tests/point-account-concurrency.test.ts`, but if it were
// ever invoked WITHOUT `--test` (e.g. `npx tsx tests/point-account-...`),
// Node's test-mode signals would not be present, and this repo's local dev
// shells deliberately export a PRODUCTION DATABASE_URL. If the ENABLED gate
// below depended on test-mode detection succeeding, that misconfiguration
// would silently no-op the detection layer and fall through to running real
// writes against production. Because canUseRealDatabaseUnderTest ignores
// detection state entirely and fails closed on host/db-name/opt-in alone, a
// production or non-"_test" DATABASE_URL is refused regardless of how this
// file is invoked.
//
// To run it against a disposable local Postgres:
//
//   1. Start a throwaway cluster, e.g.:
//        initdb -D /tmp/sqratch-concurrency-pgdata --no-locale
//        pg_ctl -D /tmp/sqratch-concurrency-pgdata \
//          -o "-p 5547 -k /tmp/sqratch-concurrency-sock -h 127.0.0.1" start
//        createdb -h 127.0.0.1 -p 5547 sqratch_concurrency_test
//   2. Sync the schema: DATABASE_URL=postgresql://postgres@127.0.0.1:5547/sqratch_concurrency_test \
//        npx prisma db push --accept-data-loss
//   3. Enable SSL on that cluster (src/lib/prisma.ts requires it by default;
//      a self-signed cert + `ssl = on` in postgresql.conf is sufficient with
//      PG_SSL_REJECT_UNAUTHORIZED=false, see below).
//   4. Run (note the database name ends in "_test" — required by condition
//      (c) above — and ALLOW_REAL_DATABASE_TESTS=true is required by
//      condition (a); DATABASE_URL's loopback host satisfies condition (b)):
//        DATABASE_URL=postgresql://postgres@127.0.0.1:5547/sqratch_concurrency_test \
//        DIRECT_URL=postgresql://postgres@127.0.0.1:5547/sqratch_concurrency_test \
//        PG_SSL_REJECT_UNAUTHORIZED=false \
//        ALLOW_REAL_DATABASE_TESTS=true \
//        POINT_ACCOUNT_CONCURRENCY=true \
//        npx tsx --test tests/point-account-concurrency.test.ts
// ---------------------------------------------------------------------------

const realDbDecision = canUseRealDatabaseUnderTest({
  connectionString: process.env.DATABASE_URL ?? "",
  allowRealDatabaseTestsEnv: process.env.ALLOW_REAL_DATABASE_TESTS,
});

const ENABLED =
  process.env.POINT_ACCOUNT_CONCURRENCY === "true" && realDbDecision.allowed;

const SKIP_REASON = realDbDecision.allowed
  ? "requires POINT_ACCOUNT_CONCURRENCY=true and a real disposable Postgres (see file header)"
  : `requires POINT_ACCOUNT_CONCURRENCY=true and the full db-safety opt-in (${realDbDecision.reason}) — see file header`;

test(
  "two concurrent missing-account requests result in exactly one account, with no transaction-aborted error",
  { skip: !ENABLED && SKIP_REASON },
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
  { skip: !ENABLED && SKIP_REASON },
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
        { userId: user.id, points: -40, reason: "COMMERCE_REWARD_REDEMPTION", type: "SPEND", idempotencyKey: `shopify-reward-redemption:${user.id}-b` },
        { userId: user.id, points: 40, reason: "COMMERCE_REWARD_REFUND", type: "REFUND", idempotencyKey: `shopify-reward-refund:${user.id}-b` },
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
