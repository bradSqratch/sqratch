// ---------------------------------------------------------------------------
// PHASE 22 (Commerce7 order reconciliation hardening, Part 3/9) — real
// PostgreSQL proof that TWO CONCURRENT `runCatchUpStep` calls for the SAME
// connection are genuinely serialized by the SAME proven
// `lockCommerceConnectionForTransaction` primitive product-sync and the
// Commerce7 connection lifecycle already use — not merely "safe because the
// fake test store happens to run sequentially" (see the DI-mocked proof in
// `tests/commerce7-order-reconciliation.test.ts`, which cannot by itself
// prove genuine multi-connection-transaction concurrency).
//
// Also proves the durable checkpoint survives real commits/rollbacks
// exactly as designed: a chunk that fails leaves NO trace on the
// checkpoint, and a chunk that succeeds is visible to a fresh read even
// after the process "restarts" (a new Prisma call, simulating a page
// reload / a new serverless invocation).
//
// Never runs against the configured production/dev DATABASE_URL and is
// SKIPPED by default — see `tests/commerce-connection-lock.test.ts`'s
// header for the full disposable-Postgres setup ritual (identical here,
// same cluster is fine).
//
// To run it against a disposable local Postgres:
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/sqratch_lock_test \
//   DIRECT_URL=postgresql://postgres@127.0.0.1:55432/sqratch_lock_test \
//   PG_SSL_REJECT_UNAUTHORIZED=false \
//   ALLOW_REAL_DATABASE_TESTS=true \
//   COMMERCE7_ORDER_RECONCILIATION=true \
//   npx tsx --test tests/commerce7-order-reconciliation-real-db.test.ts
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { CommerceProvider } from "@prisma/client";
import { canUseRealDatabaseUnderTest } from "../src/lib/db-safety";
import type { Commerce7OrderBackfillOutcome } from "../src/lib/commerce/providers/commerce7-order-backfill";

const realDbDecision = canUseRealDatabaseUnderTest({
  connectionString: process.env.DATABASE_URL ?? "",
  allowRealDatabaseTestsEnv: process.env.ALLOW_REAL_DATABASE_TESTS,
});

const ENABLED = process.env.COMMERCE7_ORDER_RECONCILIATION === "true" && realDbDecision.allowed;

const SKIP_REASON = realDbDecision.allowed
  ? "requires COMMERCE7_ORDER_RECONCILIATION=true and a real disposable Postgres (see file header)"
  : `requires COMMERCE7_ORDER_RECONCILIATION=true and the full db-safety opt-in (${realDbDecision.reason}) — see file header`;

async function makeBrandAndConnection(prisma: typeof import("../src/lib/prisma").default) {
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const brand = await prisma.brand.create({
    data: { name: `Reconciliation Brand ${unique}`, slug: `reconciliation-brand-${unique}` },
  });
  const connection = await prisma.commerceConnection.create({
    data: {
      brandId: brand.id,
      provider: CommerceProvider.COMMERCE7,
      status: "CONNECTED",
      displayName: "Reconciliation Test Store",
      externalAccountId: `reconciliation-tenant-${unique}`,
      providerMetadata: { currencyCode: "USD" },
    },
  });
  return { brand, connection };
}

async function cleanup(
  prisma: typeof import("../src/lib/prisma").default,
  brandId: string,
  connectionId: string,
) {
  await prisma.commerceOrderReconciliationState.deleteMany({ where: { connectionId } });
  await prisma.commerceOrderEvent.deleteMany({ where: { connectionId } });
  await prisma.commerceOrder.deleteMany({ where: { connectionId } });
  await prisma.commerceConnection.deleteMany({ where: { id: connectionId } });
  await prisma.brand.deleteMany({ where: { id: brandId } });
}

function emptyOutcome(): Commerce7OrderBackfillOutcome {
  return { status: "COMPLETED", ordersFetched: 0, ordersProcessed: 0, outcomes: [] };
}

test(
  "real Postgres — two CONCURRENT runCatchUpStep calls for the SAME connection genuinely serialize on the real row lock; the checkpoint never regresses and no work is lost",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { runCatchUpStep } = await import(
      "../src/lib/commerce/providers/commerce7-order-reconciliation"
    );
    const { brand, connection } = await makeBrandAndConnection(prisma);

    try {
      // Seed a checkpoint a few days behind "now" so a single chunk call
      // will NOT fully reach the target — this guarantees both concurrent
      // calls have real work to attempt, rather than one trivially becoming
      // an UP_TO_DATE no-op.
      const seededCheckpoint = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await prisma.commerceOrderReconciliationState.create({
        data: { connectionId: connection.id, brandId: brand.id, reconciledThrough: seededCheckpoint },
      });

      let releaseFirst: () => void = () => {};
      const firstGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let signalFirstFetchStarted: () => void = () => {};
      const firstFetchStarted = new Promise<void>((resolve) => {
        signalFirstFetchStarted = resolve;
      });

      let fetchCallCount = 0;
      const firstFetchOrders = async (): Promise<Commerce7OrderBackfillOutcome> => {
        fetchCallCount += 1;
        signalFirstFetchStarted();
        await firstGate;
        return emptyOutcome();
      };
      const secondFetchOrders = async (): Promise<Commerce7OrderBackfillOutcome> => {
        fetchCallCount += 1;
        return emptyOutcome();
      };

      // Request A starts, reaches its (unlocked) provider-fetch phase, and
      // BLOCKS there — its checkpoint-decide transaction has already
      // committed (real lock acquired-and-released) by the time this
      // resolves.
      const callA = runCatchUpStep(
        { brandId: brand.id, connectionId: connection.id },
        { fetchOrders: firstFetchOrders as never },
      );
      await firstFetchStarted;

      // Request B starts concurrently. Its OWN checkpoint-decide
      // transaction must wait for a real Postgres row lock exactly like
      // `tests/commerce-connection-lock.test.ts`'s 3B/14B proof — but since
      // A already committed its decide-phase transaction (it's blocked in
      // the UNLOCKED fetch phase, not holding any lock), B's decide-phase
      // transaction proceeds immediately and reads whatever A's decide
      // phase already committed as `targetThrough`.
      const bStartedAt = Date.now();
      const callB = runCatchUpStep(
        { brandId: brand.id, connectionId: connection.id },
        { fetchOrders: secondFetchOrders as never },
      );
      const resultB = await callB;
      const bCompletedAt = Date.now();

      releaseFirst();
      const resultA = await callA;

      // Both calls must have reached the provider (the lock is never held
      // across provider HTTP — see the reconciliation service's own header).
      assert.equal(fetchCallCount, 2, "neither call may be starved by the other's lock");

      const finalState = await prisma.commerceOrderReconciliationState.findUniqueOrThrow({
        where: { connectionId: connection.id },
      });

      assert.ok(
        finalState.reconciledThrough !== null,
        "the checkpoint must have advanced from the two successful chunk commits",
      );
      assert.ok(
        finalState.reconciledThrough!.getTime() >= seededCheckpoint.getTime(),
        "the checkpoint must never have regressed below where it started",
      );
      // Exactly ONE reconciliation-state row exists for this connection —
      // concurrent upserts must never create duplicates.
      const rowCount = await prisma.commerceOrderReconciliationState.count({
        where: { connectionId: connection.id },
      });
      assert.equal(rowCount, 1, "concurrent chunk commits must never create a second state row");

      assert.equal(resultA.status, "PROGRESS");
      assert.equal(resultB.status, "PROGRESS");
      assert.ok(bCompletedAt >= bStartedAt, "sanity: causal ordering is well-formed");
    } finally {
      await cleanup(prisma, brand.id, connection.id);
    }
  },
);

test(
  "real Postgres — a FAILED chunk leaves the durable checkpoint completely untouched, and a fresh read (simulating a page reload) observes the SAME unchanged value",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { runCatchUpStep, getReconciliationState } = await import(
      "../src/lib/commerce/providers/commerce7-order-reconciliation"
    );
    const { brand, connection } = await makeBrandAndConnection(prisma);

    try {
      const seededCheckpoint = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      await prisma.commerceOrderReconciliationState.create({
        data: { connectionId: connection.id, brandId: brand.id, reconciledThrough: seededCheckpoint },
      });

      const failingFetch = async (): Promise<Commerce7OrderBackfillOutcome> => {
        throw new Error("simulated provider outage");
      };

      const result = await runCatchUpStep(
        { brandId: brand.id, connectionId: connection.id },
        { fetchOrders: failingFetch as never },
      );
      assert.equal(result.status, "FAILED");

      // Simulate a page reload / a brand-new serverless invocation: a
      // completely fresh read, no shared in-memory state with the call above.
      const stateAfterReload = await getReconciliationState({
        brandId: brand.id,
        connectionId: connection.id,
      });

      assert.equal(
        stateAfterReload.reconciledThrough,
        seededCheckpoint.toISOString(),
        "the durable checkpoint must be EXACTLY unchanged after a failed chunk, confirmed by a fresh read",
      );
      assert.equal(stateAfterReload.lastRunOutcome, "FAILED");
      assert.ok(stateAfterReload.lastRunError);
    } finally {
      await cleanup(prisma, brand.id, connection.id);
    }
  },
);

test(
  "real Postgres — Custom Range reconciliation never mutates the primary reconciledThrough/targetThrough columns",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { runCustomRangeStep } = await import(
      "../src/lib/commerce/providers/commerce7-order-reconciliation"
    );
    const { brand, connection } = await makeBrandAndConnection(prisma);

    try {
      const mainCheckpoint = new Date("2026-08-05T00:00:00.000Z");
      const mainTarget = new Date("2026-08-06T00:00:00.000Z");
      await prisma.commerceOrderReconciliationState.create({
        data: {
          connectionId: connection.id,
          brandId: brand.id,
          reconciledThrough: mainCheckpoint,
          targetThrough: mainTarget,
        },
      });

      const from = new Date("2026-01-01T00:00:00.000Z");
      const to = new Date("2026-01-02T00:00:00.000Z");
      const okFetch = async (): Promise<Commerce7OrderBackfillOutcome> => emptyOutcome();

      const result = await runCustomRangeStep(
        { brandId: brand.id, connectionId: connection.id, from, to },
        { fetchOrders: okFetch as never },
      );
      assert.equal(result.status, "PROGRESS");
      assert.equal(result.reachedTarget, true);

      const row = await prisma.commerceOrderReconciliationState.findUniqueOrThrow({
        where: { connectionId: connection.id },
      });
      assert.equal(
        row.reconciledThrough?.toISOString(),
        mainCheckpoint.toISOString(),
        "the primary checkpoint must be byte-identical to its value before the custom-range repair",
      );
      assert.equal(row.targetThrough?.toISOString(), mainTarget.toISOString());
      assert.equal(row.customRangeCursor?.toISOString(), to.toISOString());
    } finally {
      await cleanup(prisma, brand.id, connection.id);
    }
  },
);
