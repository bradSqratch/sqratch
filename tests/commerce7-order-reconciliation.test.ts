/**
 * tests/commerce7-order-reconciliation.test.ts
 *
 * PHASE 22 (Commerce7 order reconciliation hardening, Part 9) — the durable,
 * resumable, chunked reconciliation service
 * (`src/lib/commerce/providers/commerce7-order-reconciliation.ts`).
 *
 * Mirrors the established fake-transactional-store idiom used throughout
 * this codebase (`FakeConfigStore` in `commerce7-storefront-configuration.test.ts`,
 * `FakeLifecycleStore` in `commerce7-connection-lifecycle.test.ts`): a staged
 * copy of state that only commits when the callback resolves without
 * throwing, matching `prisma.$transaction`'s rollback guarantee without a
 * real database. See `tests/commerce7-order-reconciliation-real-db.test.ts`
 * for the REAL Postgres concurrency proof this file's fake store cannot by
 * itself provide.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import {
  runCatchUpStep,
  runCustomRangeStep,
  processOneChunk,
  DEFAULT_CHUNK_WIDTH_MS,
  type Commerce7ReconciliationConnectionRow,
  type Commerce7ReconciliationStateRow,
  type Commerce7ReconciliationTx,
  type Commerce7ReconciliationDeps,
} from "../src/lib/commerce/providers/commerce7-order-reconciliation";
import {
  backfillCommerce7Orders,
  type Commerce7OrderBackfillOutcome,
  type Commerce7BackfillConnectionRow,
} from "../src/lib/commerce/providers/commerce7-order-backfill";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "../src/lib/commerce/errors";

const CONNECTION_CREATED_AT = new Date("2026-07-01T00:00:00.000Z");

function connectionRow(overrides: Partial<Commerce7ReconciliationConnectionRow> = {}): Commerce7ReconciliationConnectionRow {
  return {
    id: "conn-1",
    brandId: "brand-a",
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    externalAccountId: "tenant-1",
    createdAt: CONNECTION_CREATED_AT,
    providerMetadata: { currencyCode: "USD" },
    ...overrides,
  };
}

const EMPTY_STATE: Commerce7ReconciliationStateRow = {
  reconciledThrough: null,
  targetThrough: null,
  lastAttemptedAt: null,
  lastRunOutcome: null,
  lastRunError: null,
  customRangeFrom: null,
  customRangeTo: null,
  customRangeCursor: null,
};

/**
 * Fake, deterministic Commerce7 order provider. Tests configure which date
 * windows contain how many "orders"; `completed()`/`truncated()` responses
 * are returned per-call according to that configuration, exactly matching
 * `backfillCommerce7Orders`'s own `Commerce7OrderBackfillOutcome` contract
 * so `processOneChunk` cannot tell the difference.
 */
class FakeOrderProvider {
  calls: Array<{ from: Date; to: Date }> = [];
  /** Call-index (0-based, across ALL calls made to this fake) that should throw instead of returning normally. */
  failOnCallIndex: number | null = null;
  failError: Error = new Error("simulated provider failure");
  /** Call-index that should report TRUNCATED regardless of window width — simulates an abnormally high-volume window. */
  truncateOnCallIndex: number | null = null;
  /** How many orders exist in [from, to] for each call, in the order the fake is invoked — defaults to 0 (empty interval) when exhausted. */
  ordersPerCallInOrder: number[] = [];

  async fetchOrders(input: {
    brandId: string;
    connectionId: string;
    updatedAtGte: Date;
    updatedAtLte: Date;
  }): Promise<Commerce7OrderBackfillOutcome> {
    const index = this.calls.length;
    this.calls.push({ from: input.updatedAtGte, to: input.updatedAtLte });

    if (this.failOnCallIndex === index) {
      throw this.failError;
    }
    if (this.truncateOnCallIndex === index) {
      return { status: "TRUNCATED", ordersFetched: 501, ordersProcessed: 500, outcomes: [] };
    }
    const orderCount = this.ordersPerCallInOrder[index] ?? 0;
    return {
      status: "COMPLETED",
      ordersFetched: orderCount,
      ordersProcessed: orderCount,
      outcomes: Array.from({ length: orderCount }, () => ({
        status: "CREATED" as const,
        reason: null,
        eventId: "evt-x",
        orderId: "order-x",
        lineItemCount: 1,
        attributionLinked: false,
        brandIdOverriddenFromConnection: false,
      })),
    };
  }
}

/** In-memory, rollback-capable store implementing `Commerce7ReconciliationTx` — see file header. */
class FakeReconciliationStore {
  connections = new Map<string, Commerce7ReconciliationConnectionRow>();
  states = new Map<string, Commerce7ReconciliationStateRow>();
  lockedConnectionIds: string[] = [];

  async runInTransaction<T>(fn: (tx: Commerce7ReconciliationTx) => Promise<T>): Promise<T> {
    const stagedStates = new Map(this.states);
    const tx: Commerce7ReconciliationTx = {
      lockAndLoad: async (connectionId) => {
        this.lockedConnectionIds.push(connectionId);
        return {
          connection: this.connections.get(connectionId) ?? null,
          state: stagedStates.get(connectionId) ?? { ...EMPTY_STATE },
        };
      },
      setTargetThrough: async (connectionId, _brandId, target) => {
        const existing = stagedStates.get(connectionId) ?? { ...EMPTY_STATE };
        stagedStates.set(connectionId, { ...existing, targetThrough: target });
      },
      advanceReconciledThrough: async (connectionId, _brandId, through) => {
        const existing = stagedStates.get(connectionId) ?? { ...EMPTY_STATE };
        if (!existing.reconciledThrough || existing.reconciledThrough.getTime() < through.getTime()) {
          stagedStates.set(connectionId, { ...existing, reconciledThrough: through });
        }
      },
      recordCatchUpAttempt: async (connectionId, _brandId, input) => {
        const existing = stagedStates.get(connectionId) ?? { ...EMPTY_STATE };
        stagedStates.set(connectionId, {
          ...existing,
          lastAttemptedAt: new Date(),
          lastRunOutcome: input.outcome,
          lastRunError: input.error,
        });
      },
      setCustomRange: async (connectionId, _brandId, from, to, cursor) => {
        const existing = stagedStates.get(connectionId) ?? { ...EMPTY_STATE };
        stagedStates.set(connectionId, {
          ...existing,
          customRangeFrom: from,
          customRangeTo: to,
          customRangeCursor: cursor,
        });
      },
      advanceCustomRangeCursor: async (connectionId, _brandId, cursor) => {
        const existing = stagedStates.get(connectionId) ?? { ...EMPTY_STATE };
        if (!existing.customRangeCursor || existing.customRangeCursor.getTime() < cursor.getTime()) {
          stagedStates.set(connectionId, { ...existing, customRangeCursor: cursor });
        }
      },
      recordCustomRangeAttempt: async (connectionId, _brandId, input) => {
        const existing = stagedStates.get(connectionId) ?? { ...EMPTY_STATE };
        stagedStates.set(connectionId, {
          ...existing,
          lastAttemptedAt: new Date(),
          lastRunOutcome: input.outcome,
          lastRunError: input.error,
        });
      },
    };

    const result = await fn(tx);
    this.states = stagedStates;
    return result;
  }
}

function depsFor(
  store: FakeReconciliationStore,
  provider: FakeOrderProvider,
): Partial<Commerce7ReconciliationDeps> {
  return {
    runInTransaction: (fn) => store.runInTransaction(fn),
    fetchOrders: (input) => provider.fetchOrders(input) as never,
    now: () => new Date("2026-08-10T00:00:00.000Z"),
  };
}

describe("Part 9: Normal Catch Up", () => {
  test("checkpoint A, orders between A and B, successful reconciliation advances checkpoint toward B across multiple chunks", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", { ...EMPTY_STATE, reconciledThrough: new Date("2026-08-01T00:00:00.000Z") });

    const provider = new FakeOrderProvider();
    provider.ordersPerCallInOrder = [3, 2, 0, 1, 0, 0, 0, 0, 0];
    const deps = depsFor(store, provider);

    let last;
    let iterations = 0;
    do {
      last = await runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, deps);
      iterations += 1;
    } while (!last.reachedTarget && iterations < 20);

    assert.equal(last.reachedTarget, true, "must eventually reach the target (now)");
    assert.equal(last.status === "UP_TO_DATE" || last.status === "PROGRESS", true);
    const finalState = store.states.get("conn-1")!;
    assert.equal(
      finalState.reconciledThrough?.toISOString(),
      new Date("2026-08-10T00:00:00.000Z").toISOString(),
      "checkpoint must land exactly at the target",
    );
  });

  test("each chunk call advances the checkpoint by AT MOST the default chunk width", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", { ...EMPTY_STATE, reconciledThrough: new Date("2026-08-01T00:00:00.000Z") });
    const provider = new FakeOrderProvider();
    const deps = depsFor(store, provider);

    const result = await runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, deps);
    assert.equal(result.status, "PROGRESS");
    const advancedBy = result.reconciledThrough!.getTime() - new Date("2026-08-01T00:00:00.000Z").getTime();
    assert.ok(advancedBy <= DEFAULT_CHUNK_WIDTH_MS, "one chunk call must never advance more than the default width");
  });
});

describe("Part 9: Empty interval", () => {
  test("checkpoint A, ZERO orders A -> B, successful reconciliation still advances checkpoint to B", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", { ...EMPTY_STATE, reconciledThrough: new Date("2026-08-09T00:00:00.000Z") });
    const provider = new FakeOrderProvider();
    provider.ordersPerCallInOrder = [0]; // no orders exist in this window at all
    const deps = depsFor(store, provider);

    const result = await runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, deps);

    assert.equal(result.status, "PROGRESS", "a zero-order chunk is still a successfully COMPLETED chunk");
    assert.equal(result.ordersFetched, 0);
    assert.ok(
      result.reconciledThrough!.getTime() > new Date("2026-08-09T00:00:00.000Z").getTime(),
      "the checkpoint must advance even though nothing was fetched — absence of orders is not absence of progress",
    );
  });

  test("already caught up (chunkStart >= target) reports UP_TO_DATE without ever calling the provider", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", { ...EMPTY_STATE, reconciledThrough: new Date("2026-08-10T00:00:00.000Z") });
    const provider = new FakeOrderProvider();
    const deps = depsFor(store, provider);

    const result = await runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, deps);

    assert.equal(result.status, "UP_TO_DATE");
    assert.equal(result.reachedTarget, true);
    assert.equal(provider.calls.length, 0, "no provider HTTP when there is nothing to reconcile");
  });
});

describe("Part 9: Partial failure", () => {
  test("chunk 1 succeeds, chunk 2 succeeds, chunk 3 fails — checkpoint reflects the END of chunk 2, never chunk 3, never the final target", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", { ...EMPTY_STATE, reconciledThrough: new Date("2026-08-01T00:00:00.000Z") });
    const provider = new FakeOrderProvider();
    provider.ordersPerCallInOrder = [1, 1];
    provider.failOnCallIndex = 2; // the 3rd call (0-indexed) throws
    const deps = depsFor(store, provider);

    const r1 = await runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, deps);
    assert.equal(r1.status, "PROGRESS");
    const afterChunk1 = store.states.get("conn-1")!.reconciledThrough!;
    assert.equal(afterChunk1.toISOString(), new Date("2026-08-02T00:00:00.000Z").toISOString());

    const r2 = await runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, deps);
    assert.equal(r2.status, "PROGRESS");
    const afterChunk2 = store.states.get("conn-1")!.reconciledThrough!;
    assert.equal(afterChunk2.toISOString(), new Date("2026-08-03T00:00:00.000Z").toISOString());

    const r3 = await runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, deps);
    assert.equal(r3.status, "FAILED", "chunk 3 must be reported as a genuine failure, not silently swallowed");
    assert.ok(r3.error, "a sanitized error must be present");

    const finalState = store.states.get("conn-1")!;
    assert.equal(
      finalState.reconciledThrough!.toISOString(),
      afterChunk2.toISOString(),
      "checkpoint must remain EXACTLY at the end of chunk 2 — never chunk 3's window, never the final target",
    );
  });
});

describe("Part 9: Retry", () => {
  test("retrying after a failure resumes from the last durable SUCCESSFUL checkpoint, not from scratch and not from where the failed attempt tried to reach", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", { ...EMPTY_STATE, reconciledThrough: new Date("2026-08-01T00:00:00.000Z") });
    const provider = new FakeOrderProvider();
    provider.failOnCallIndex = 0; // the very first chunk fails
    const deps = depsFor(store, provider);

    const failed = await runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, deps);
    assert.equal(failed.status, "FAILED");
    assert.equal(
      store.states.get("conn-1")!.reconciledThrough!.toISOString(),
      new Date("2026-08-01T00:00:00.000Z").toISOString(),
      "a failed first chunk leaves the checkpoint completely untouched",
    );

    // Retry: the provider is now healthy.
    provider.failOnCallIndex = null;
    const retried = await runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, deps);
    assert.equal(retried.status, "PROGRESS");
    assert.equal(
      retried.chunk!.from.toISOString(),
      new Date("2026-08-01T00:00:00.000Z").toISOString(),
      "the retry must start from the SAME durable checkpoint the failed attempt never advanced past",
    );
  });
});

describe("Part 9: Custom range", () => {
  test("a custom historical range succeeds WITHOUT moving the contiguous Catch Up checkpoint", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    // Main checkpoint is at Aug 5 — Order #1002-style scenario: admin wants
    // to repair Aug 20 -> Aug 21, a window strictly AFTER the checkpoint.
    store.states.set("conn-1", { ...EMPTY_STATE, reconciledThrough: new Date("2026-08-05T00:00:00.000Z") });
    const provider = new FakeOrderProvider();
    provider.ordersPerCallInOrder = [1];
    const deps = depsFor(store, provider);

    const from = new Date("2026-08-20T00:00:00.000Z");
    const to = new Date("2026-08-21T00:00:00.000Z");
    const result = await runCustomRangeStep({ brandId: "brand-a", connectionId: "conn-1", from, to }, deps);

    assert.equal(result.status, "PROGRESS");
    assert.equal(result.reachedTarget, true);

    const finalState = store.states.get("conn-1")!;
    assert.equal(
      finalState.reconciledThrough!.toISOString(),
      new Date("2026-08-05T00:00:00.000Z").toISOString(),
      "the PRIMARY contiguous checkpoint must be completely untouched by a custom-range repair",
    );
    assert.equal(finalState.customRangeCursor!.toISOString(), to.toISOString());
  });

  test("custom range resumes from its OWN durable cursor across multiple calls with the SAME from/to", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", { ...EMPTY_STATE });
    const provider = new FakeOrderProvider();
    const deps = depsFor(store, provider);

    const from = new Date("2026-06-01T00:00:00.000Z");
    const to = new Date("2026-06-05T00:00:00.000Z"); // 4 days -> multiple 24h chunks

    let last;
    let iterations = 0;
    do {
      last = await runCustomRangeStep({ brandId: "brand-a", connectionId: "conn-1", from, to }, deps);
      iterations += 1;
    } while (!last.reachedTarget && iterations < 10);

    assert.equal(last.reachedTarget, true);
    assert.equal(last.cursor!.toISOString(), to.toISOString());
    assert.ok(iterations > 1, "a 4-day range at a 24h default chunk width must take more than one call");
  });

  test("a DIFFERENT from/to than the currently in-progress custom range starts a FRESH sequence, resetting the cursor", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", {
      ...EMPTY_STATE,
      customRangeFrom: new Date("2026-01-01T00:00:00.000Z"),
      customRangeTo: new Date("2026-01-10T00:00:00.000Z"),
      customRangeCursor: new Date("2026-01-05T00:00:00.000Z"),
    });
    const provider = new FakeOrderProvider();
    const deps = depsFor(store, provider);

    const newFrom = new Date("2026-08-20T00:00:00.000Z");
    const newTo = new Date("2026-08-21T00:00:00.000Z");
    const result = await runCustomRangeStep(
      { brandId: "brand-a", connectionId: "conn-1", from: newFrom, to: newTo },
      deps,
    );

    assert.equal(provider.calls[0].from.toISOString(), newFrom.toISOString(), "must start from the NEW range's own from, not the old cursor");
    assert.equal(result.status, "PROGRESS");
  });

  test("a range wider than the default chunk cannot corrupt the checkpoint even under a mid-sequence failure", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", { ...EMPTY_STATE, reconciledThrough: new Date("2026-08-05T00:00:00.000Z") });
    const provider = new FakeOrderProvider();
    provider.failOnCallIndex = 1; // second chunk of the custom range fails
    const deps = depsFor(store, provider);

    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-01-05T00:00:00.000Z");

    await runCustomRangeStep({ brandId: "brand-a", connectionId: "conn-1", from, to }, deps); // chunk 1: ok
    const failed = await runCustomRangeStep({ brandId: "brand-a", connectionId: "conn-1", from, to }, deps); // chunk 2: fails

    assert.equal(failed.status, "FAILED");
    assert.equal(
      store.states.get("conn-1")!.reconciledThrough!.toISOString(),
      new Date("2026-08-05T00:00:00.000Z").toISOString(),
      "the primary checkpoint must remain untouched regardless of custom-range outcomes",
    );
  });
});

describe("Part 9: Concurrent attempts (logical serialization proof)", () => {
  test("two overlapping runCatchUpStep calls for the SAME connection can never move the checkpoint BACKWARDS", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", { ...EMPTY_STATE, reconciledThrough: new Date("2026-08-01T00:00:00.000Z") });
    const providerA = new FakeOrderProvider();
    const providerB = new FakeOrderProvider();

    // Two independent "requests" racing for the same connection — the fake
    // store's Map staging still processes each `runInTransaction` callback
    // to completion before the next starts (JS single-threaded event loop +
    // no real interleaving inside one fake transaction), which is exactly
    // the property the REAL Postgres row lock guarantees for real
    // concurrent requests — see the real-DB test file for genuine
    // multi-connection proof.
    const [resultA, resultB] = await Promise.all([
      runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store, providerA)),
      runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store, providerB)),
    ]);

    const finalCheckpoint = store.states.get("conn-1")!.reconciledThrough!;
    // Regardless of interleaving, the final checkpoint must be >= what EITHER individual result reported.
    assert.ok(finalCheckpoint.getTime() >= resultA.reconciledThrough!.getTime());
    assert.ok(finalCheckpoint.getTime() >= resultB.reconciledThrough!.getTime());
    assert.ok(
      finalCheckpoint.getTime() >= new Date("2026-08-01T00:00:00.000Z").getTime(),
      "the checkpoint can never end up BEFORE where it started",
    );
  });

  test("advanceReconciledThrough is a no-op (never regresses) when the stored value is already ahead", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", { ...EMPTY_STATE, reconciledThrough: new Date("2026-08-05T00:00:00.000Z") });

    await store.runInTransaction(async (tx) => {
      await tx.advanceReconciledThrough("conn-1", "brand-a", new Date("2026-08-03T00:00:00.000Z"));
    });

    assert.equal(
      store.states.get("conn-1")!.reconciledThrough!.toISOString(),
      new Date("2026-08-05T00:00:00.000Z").toISOString(),
      "an earlier value must never overwrite a later, already-durable checkpoint",
    );
  });
});

describe("Part 9: Fulfillment via reconciliation", () => {
  test("a chunk that reports orders processed reflects that count through the reconciliation step's own result", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", { ...EMPTY_STATE, reconciledThrough: new Date("2026-08-09T00:00:00.000Z") });
    const provider = new FakeOrderProvider();
    provider.ordersPerCallInOrder = [1];
    const deps = depsFor(store, provider);

    const result = await runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, deps);
    assert.equal(result.ordersProcessed, 1);
  });

  test("end to end through the REAL backfillCommerce7Orders + normalizer: an order Commerce7 now reports Fulfilled reaches ingestion as canonical FULFILLED, driven entirely by runCatchUpStep", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow());
    store.states.set("conn-1", { ...EMPTY_STATE, reconciledThrough: new Date("2026-08-09T00:00:00.000Z") });

    const capturedOrders: Array<{ externalOrderId: string | null; fulfillmentStatus: string | null }> = [];

    const backfillConnection: Commerce7BackfillConnectionRow = {
      id: "conn-1",
      brandId: "brand-a",
      provider: CommerceProvider.COMMERCE7,
      status: "CONNECTED",
      externalAccountId: "tenant-1",
      providerMetadata: { currencyCode: "USD" },
    };

    const realBackfill = (input: Parameters<typeof backfillCommerce7Orders>[0]) =>
      backfillCommerce7Orders(input, {
        loadConnection: async () => backfillConnection,
        fetchOrders: async () => ({
          orders: [
            {
              id: "c7-order-1002",
              orderNumber: 1002,
              subTotal: 5000,
              shipTotal: 0,
              taxTotal: 0,
              total: 5000,
              paymentStatus: "Paid",
              // The exact scenario from the live report: previously
              // UNFULFILLED, Commerce7 now reports it as Fulfilled.
              fulfillmentStatus: "Fulfilled",
              createdAt: "2026-08-09T12:00:00.000Z",
              updatedAt: "2026-08-09T13:00:00.000Z",
              items: [],
            },
          ],
          total: 1,
        }),
        ingest: async (_claim, order) => {
          capturedOrders.push({
            externalOrderId: order.externalOrderId,
            fulfillmentStatus: order.fulfillmentStatus,
          });
          return {
            status: "CREATED",
            reason: null,
            eventId: "evt-1",
            orderId: "order-1",
            lineItemCount: 0,
            attributionLinked: false,
            brandIdOverriddenFromConnection: false,
          };
        },
      });

    const result = await runCatchUpStep(
      { brandId: "brand-a", connectionId: "conn-1" },
      { runInTransaction: (fn) => store.runInTransaction(fn), fetchOrders: realBackfill, now: () => new Date("2026-08-10T00:00:00.000Z") },
    );

    assert.equal(result.status, "PROGRESS");
    assert.equal(capturedOrders.length, 1);
    assert.equal(capturedOrders[0].externalOrderId, "c7-order-1002");
    assert.equal(
      capturedOrders[0].fulfillmentStatus,
      "FULFILLED",
      "the canonical order passed to ingestion must carry FULFILLED — the real normalizer's own mapping, exercised through the full reconciliation chain",
    );
  });
});

describe("Part 9: ownership / authorization", () => {
  test("a foreign-brand connectionId throws CommerceConnectionNotFoundError before any provider HTTP", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow({ brandId: "brand-OTHER" }));
    const provider = new FakeOrderProvider();
    await assert.rejects(
      () => runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store, provider)),
      CommerceConnectionNotFoundError,
    );
    assert.equal(provider.calls.length, 0);
  });

  test("a Shopify connection throws CommerceConnectionMismatchError", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow({ provider: CommerceProvider.SHOPIFY }));
    const provider = new FakeOrderProvider();
    await assert.rejects(
      () => runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store, provider)),
      CommerceConnectionMismatchError,
    );
  });

  test("a non-CONNECTED connection throws CommerceConnectionNotReadyError", async () => {
    const store = new FakeReconciliationStore();
    store.connections.set("conn-1", connectionRow({ status: "DISCONNECTED" }));
    const provider = new FakeOrderProvider();
    await assert.rejects(
      () => runCatchUpStep({ brandId: "brand-a", connectionId: "conn-1" }, depsFor(store, provider)),
      CommerceConnectionNotReadyError,
    );
  });
});

describe("processOneChunk: adaptive narrowing on TRUNCATED", () => {
  test("a TRUNCATED result at the default width narrows and retries until a COMPLETED sub-window is found", async () => {
    const provider = new FakeOrderProvider();
    provider.truncateOnCallIndex = 0; // first (widest) attempt truncates
    // second (narrower) attempt succeeds — leave ordersPerCallInOrder default (0 orders, COMPLETED)

    const result = await processOneChunk(
      { brandId: "brand-a", connectionId: "conn-1", from: new Date("2026-08-01T00:00:00.000Z"), to: new Date("2026-08-02T00:00:00.000Z") },
      { runInTransaction: (fn) => fn(null as never), fetchOrders: (i) => provider.fetchOrders(i) as never, now: () => new Date() },
    );

    assert.equal(result.outcome, "PROGRESS");
    assert.ok(provider.calls.length >= 2, "must have retried with a narrower window after truncation");
    const secondCallWidth = provider.calls[1].to.getTime() - provider.calls[1].from.getTime();
    const firstCallWidth = provider.calls[0].to.getTime() - provider.calls[0].from.getTime();
    assert.ok(secondCallWidth < firstCallWidth, "the retry window must be narrower than the original");
    assert.ok(
      result.achievedThrough!.getTime() <= provider.calls[1].to.getTime(),
      "the achieved checkpoint must never exceed what was PROVEN complete",
    );
  });

  test("TRUNCATED even at the minimum narrowing floor reports a genuine, honest FAILED result — never silently accepted", async () => {
    // Truncate on every single call, forcing narrowing all the way to the floor and beyond.
    let calls = 0;
    const alwaysTruncate = {
      fetchOrders: async () => {
        calls += 1;
        return { status: "TRUNCATED" as const, ordersFetched: 501, ordersProcessed: 500, outcomes: [] };
      },
    };

    const result = await processOneChunk(
      { brandId: "brand-a", connectionId: "conn-1", from: new Date("2026-08-01T00:00:00.000Z"), to: new Date("2026-08-02T00:00:00.000Z") },
      { runInTransaction: (fn) => fn(null as never), fetchOrders: alwaysTruncate.fetchOrders as never, now: () => new Date() },
    );

    assert.equal(result.outcome, "FAILED");
    assert.equal(result.achievedThrough, null, "never advance on an unproven, always-truncated window");
    assert.ok(result.error);
    assert.ok(calls > 1, "narrowing must have actually been attempted before giving up");
  });

  test("a genuine provider error (not truncation) fails immediately without narrowing retries", async () => {
    const provider = new FakeOrderProvider();
    provider.failOnCallIndex = 0;

    const result = await processOneChunk(
      { brandId: "brand-a", connectionId: "conn-1", from: new Date("2026-08-01T00:00:00.000Z"), to: new Date("2026-08-02T00:00:00.000Z") },
      { runInTransaction: (fn) => fn(null as never), fetchOrders: (i) => provider.fetchOrders(i) as never, now: () => new Date() },
    );

    assert.equal(result.outcome, "FAILED");
    assert.equal(provider.calls.length, 1, "a real error must not trigger narrowing retries — narrowing only helps a TRUNCATED result count");
  });
});
