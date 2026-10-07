import "./env-setup";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { readFileSync } from "node:fs";
import { withCommerce7ReconciliationClaim, Commerce7ReconciliationBusyError, type ReconciliationClaimStore } from "../src/lib/commerce/providers/commerce7-reconciliation-claim";
import { runCommerce7ReconciliationWorker, COMMERCE7_WORKER_CONNECTION_LIMIT } from "../src/lib/commerce/providers/commerce7-reconciliation-worker";
import { commerce7ReconciliationWorkerPostImpl } from "../src/app/api/internal/commerce7-reconciliation-worker/route";
import { runCatchUpStep, runCustomRangeStep } from "../src/lib/commerce/providers/commerce7-order-reconciliation";

const owner = { brandId: "brand-a", connectionId: "connection-a" };
function fakeClaims() {
  const claims = new Map<string, string>();
  const store: ReconciliationClaimStore = {
    acquire: async (input, runId) => {
      if (claims.has(input.connectionId)) return false;
      claims.set(input.connectionId, runId); return true;
    },
    release: async (input, runId) => {
      if (claims.get(input.connectionId) === runId) claims.delete(input.connectionId);
    },
  };
  return { claims, store };
}
function progress() {
  return { status: "PROGRESS" as const, reconciledThrough: new Date("2026-10-06"), target: new Date("2026-10-07"), reachedTarget: false, chunk: null, ordersFetched: 1, ordersProcessed: 1, error: null };
}

test("durable claims deny overlap for the same connection and permit different connections", async () => {
  const { claims, store } = fakeClaims();
  let release = () => {};
  let started = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const first = withCommerce7ReconciliationClaim(owner, async () => { started(); await gate; return "done"; }, store);
  await ready;
  await assert.rejects(withCommerce7ReconciliationClaim(owner, async () => assert.fail("overlap"), store), Commerce7ReconciliationBusyError);
  assert.equal(await withCommerce7ReconciliationClaim({ ...owner, connectionId: "connection-b" }, async () => "other", store), "other");
  release(); assert.equal(await first, "done"); assert.equal(claims.size, 0);
  await assert.rejects(withCommerce7ReconciliationClaim(owner, async () => { throw new Error("failed"); }, store));
  assert.equal(claims.size, 0);
});

test("claims have no timed takeover and release cannot erase a different owner's claim", async () => {
  const { claims, store } = fakeClaims();
  claims.set(owner.connectionId, "abandoned-run");
  await assert.rejects(withCommerce7ReconciliationClaim(owner, async () => assert.fail(), store), Commerce7ReconciliationBusyError);
  await store.release(owner, "different-run");
  assert.equal(claims.get(owner.connectionId), "abandoned-run");
  assert.doesNotMatch(readFileSync("src/lib/commerce/providers/commerce7-reconciliation-claim.ts", "utf8"), /setTimeout|expiresAt|staleBefore/);
});

test("Catch Up and Custom Range acquire a whole-step claim before any checkpoint/provider work", async () => {
  const denied = async <T,>(): Promise<T> => { throw new Commerce7ReconciliationBusyError(); };
  const deps = { withRunClaim: denied, runInTransaction: async <T,>(): Promise<T> => assert.fail("must not enter"), fetchOrders: async () => assert.fail("must not fetch") };
  await assert.rejects(runCatchUpStep(owner, deps), Commerce7ReconciliationBusyError);
  await assert.rejects(runCustomRangeStep({ ...owner, from: new Date("2026-10-06"), to: new Date("2026-10-07") }, deps), Commerce7ReconciliationBusyError);
});

test("worker is bounded to one connection and returns sanitized counts only", async () => {
  const called: string[] = [];
  const counts = await runCommerce7ReconciliationWorker({
    listCandidates: async (limit) => { assert.equal(limit, COMMERCE7_WORKER_CONNECTION_LIMIT); return [owner, { ...owner, connectionId: "extra" }]; },
    catchUp: async (input) => { called.push(input.connectionId); return progress(); },
  });
  assert.deepEqual(called, [owner.connectionId]);
  assert.deepEqual(counts, { attempted: 1, progressed: 1, upToDate: 0, busy: 0, failed: 0, ordersFetched: 1, ordersProcessed: 1 });
  assert.doesNotMatch(JSON.stringify(counts), /brand-a|connection-a/);
});

for (const mode of ["busy", "failed", "throw", "upToDate", "empty"] as const) {
  test(`worker reports ${mode} without sensitive errors or checkpoint guessing`, async () => {
    const counts = await runCommerce7ReconciliationWorker({
      listCandidates: async () => mode === "empty" ? [] : [owner],
      catchUp: async () => {
        if (mode === "busy") throw new Commerce7ReconciliationBusyError();
        if (mode === "throw") throw new Error("token email credentials raw query");
        return { ...progress(), status: mode === "failed" ? "FAILED" : "UP_TO_DATE", reachedTarget: mode !== "failed", error: "private" };
      },
    });
    assert.equal(counts.attempted, mode === "empty" ? 0 : 1);
    assert.equal(counts.busy, mode === "busy" ? 1 : 0);
    assert.equal(counts.failed, mode === "failed" || mode === "throw" ? 1 : 0);
    assert.doesNotMatch(JSON.stringify(counts), /private|token|credentials|query/);
  });
}

test("internal endpoint authenticates before enumeration; missing/incorrect secret is denied", async () => {
  const previous = process.env.CRON_SECRET;
  let called = false;
  const run = async () => { called = true; return runCommerce7ReconciliationWorker({ listCandidates: async () => [] }); };
  try {
    delete process.env.CRON_SECRET;
    assert.equal((await commerce7ReconciliationWorkerPostImpl(new Request("https://test"), run)).status, 401);
    process.env.CRON_SECRET = "worker-test-secret";
    assert.equal((await commerce7ReconciliationWorkerPostImpl(new Request("https://test", { headers: { "x-cron-secret": "wrong" } }), run)).status, 401);
    assert.equal(called, false);
    const res = await commerce7ReconciliationWorkerPostImpl(new Request("https://test", { headers: { "x-cron-secret": "worker-test-secret" } }), run);
    assert.equal(res.status, 200); assert.equal(called, true);
    assert.doesNotMatch(JSON.stringify(await res.json()), /worker-test-secret/);
  } finally { if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous; }
});

test("endpoint reports failed work as retryable 503 and never logs raw exceptions", async () => {
  const previous = process.env.CRON_SECRET; process.env.CRON_SECRET = "worker-test-secret";
  const logs: unknown[][] = [];
  const log = mock.method(console, "error", (...args: unknown[]) => logs.push(args));
  try {
    const request = new Request("https://test", { headers: { "x-cron-secret": "worker-test-secret" } });
    const partial = await commerce7ReconciliationWorkerPostImpl(request, () => runCommerce7ReconciliationWorker({ listCandidates: async () => [owner], catchUp: async () => ({ ...progress(), status: "FAILED" }) }));
    assert.equal(partial.status, 503);
    const failed = await commerce7ReconciliationWorkerPostImpl(request, async () => { throw new Error("SECRET PII query"); });
    assert.equal(failed.status, 500);
    assert.doesNotMatch(JSON.stringify(logs), /SECRET|PII|query/);
  } finally { log.mock.restore(); if (previous === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = previous; }
});

test("default worker selection is connected Commerce7 only, unclaimed, fair, and bounded; no schedule installed", () => {
  const source = readFileSync("src/lib/commerce/providers/commerce7-reconciliation-worker.ts", "utf8");
  assert.match(source, /provider: CommerceProvider.COMMERCE7, status: "CONNECTED"/);
  assert.match(source, /activeRunId: null/);
  assert.match(source, /lastAttemptedAt: \{ sort: "asc", nulls: "first" \}/);
  assert.match(source, /take: limit/);
  const migration = readFileSync("prisma/migrations/20261007010000_commerce7_reconciliation_claim/migration.sql", "utf8");
  assert.match(migration, /ADD COLUMN "activeRunId" TEXT/);
  assert.doesNotMatch(migration, /DROP|DELETE|TRUNCATE|cron/i);
});

test("default claim storage uses only validated owner columns, locks before reads, and releases by owner", async () => {
  const { default: prisma } = await import("../src/lib/prisma");
  const previousTransaction = prisma.$transaction;
  const previousRelease = prisma.commerceOrderReconciliationState.updateMany;
  const actions: string[] = [];
  let savedRun: string | null = null;
  const ownerKeys = ["activeRunId", "activeRunStartedAt", "brandId", "connectionId", "lastAttemptedAt"];
  const fake = {
    commerceConnection: {
      update: async () => { actions.push("lock"); return { id: owner.connectionId, updatedAt: new Date() }; },
      findUnique: async () => { actions.push("connection"); return { id: owner.connectionId, brandId: owner.brandId, provider: "COMMERCE7", status: "CONNECTED" }; },
    },
    commerceOrderReconciliationState: {
      findUnique: async () => { actions.push("state"); return { activeRunId: savedRun }; },
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        assert.deepEqual(Object.keys(create).sort(), ownerKeys.sort());
        savedRun = create.activeRunId as string;
        actions.push("claim");
      },
    },
  };
  prisma.$transaction = (async (callback: (tx: unknown) => Promise<unknown>) => callback(fake)) as typeof prisma.$transaction;
  prisma.commerceOrderReconciliationState.updateMany = (async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    assert.deepEqual(Object.keys(where).sort(), ["activeRunId", "brandId", "connectionId"]);
    assert.equal(where.activeRunId, savedRun);
    assert.deepEqual(data, { activeRunId: null, activeRunStartedAt: null });
    actions.push("release"); savedRun = null; return { count: 1 };
  }) as unknown as typeof previousRelease;
  try {
    const input = { ...owner, from: new Date(), to: new Date(), updatedAtGte: new Date(), untrusted: "never forwarded" };
    assert.equal(await withCommerce7ReconciliationClaim(input, async () => { actions.push("work"); return 42; }), 42);
    assert.deepEqual(actions, ["lock", "connection", "state", "claim", "work", "release"]);
  } finally { prisma.$transaction = previousTransaction; prisma.commerceOrderReconciliationState.updateMany = previousRelease; }
});
