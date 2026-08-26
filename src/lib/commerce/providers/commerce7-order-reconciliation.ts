/**
 * src/lib/commerce/providers/commerce7-order-reconciliation.ts
 *
 * PHASE 22 — durable, resumable, chunked Commerce7 order reconciliation.
 * Replaces the fixed "reconcile last 24 hours" button with a durable
 * checkpoint (`CommerceOrderReconciliationState.reconciledThrough`) plus an
 * independent custom-range repair cursor. See that Prisma model's own doc
 * comment (`prisma/schema.prisma`) for the exact two-concerns-one-row shape.
 *
 * ===========================================================================
 * NO NEW SERVICE, NO DUPLICATED INGESTION LOGIC
 * ===========================================================================
 * This module adds ZERO new provider HTTP or ingestion code. Every chunk is
 * processed by the EXISTING, unmodified `backfillCommerce7Orders`
 * (`./commerce7-order-backfill.ts`) — the SAME function the legacy
 * `/orders/reconcile` route already used, and the SAME idempotent
 * `CommerceOrderEvent` ledger every other ingestion path (webhook, backfill)
 * shares. Both Catch Up and Custom Range call the ONE chunk processor below
 * (`processOneChunk`) — there is no second, parallel reconciliation
 * implementation to keep in sync.
 *
 * ===========================================================================
 * WHY CHUNKS ARE ADAPTIVE, NOT A FIXED CALENDAR WIDTH
 * ===========================================================================
 * Commerce7's `GET /order` list endpoint (see `./commerce7-orders.ts`'s own
 * header) accepts ONLY a lower bound (`updatedAt gte:`) server-side — there
 * is no documented server-side upper-bound query parameter, so EVERY call,
 * regardless of the caller's intended window width, asks Commerce7 for
 * "everything since `gte`" and the upper bound is enforced CLIENT-SIDE by
 * filtering the response. The real safety constraint is therefore
 * `COMMERCE7_BACKFILL_MAX_RESULTS` (500) and `backfillCommerce7Orders`'s own
 * `TRUNCATED` signal, not any particular calendar interval. This module
 * starts each chunk at `DEFAULT_CHUNK_WIDTH_MS` (24h, matching a
 * conservative first-version default) but treats that width as a STARTING
 * POINT ONLY: on a `TRUNCATED` result it halves the window and retries from
 * the SAME start (never advancing the checkpoint past an unproven point),
 * down to `MIN_CHUNK_WIDTH_MS` (1h). A chunk's checkpoint is only ever
 * advanced to a point the provider call PROVABLY (via `status: "COMPLETED"`)
 * covered completely.
 *
 * ===========================================================================
 * THE DURABLE CHECKPOINT VS. A CUSTOM-RANGE REPAIR — NEVER CONFLATED
 * ===========================================================================
 * `reconciledThrough` represents a CONTIGUOUS proven range starting from
 * this connection's creation. `runCatchUpStep` is the ONLY function that
 * ever advances it, and only forward (a conditional `updateMany` guards
 * against ever moving it backwards, on top of the real connection-row lock
 * that already serializes concurrent callers for the SAME connection).
 *
 * `runCustomRangeStep` reconciles an EXPLICIT, admin-chosen `[from, to]`
 * window that may be entirely disjoint from `reconciledThrough` (e.g. a
 * historical gap the admin wants to repair). It uses the identical chunk
 * processor and identical idempotent ingestion, but writes ONLY
 * `customRangeFrom`/`customRangeTo`/`customRangeCursor` — it NEVER reads or
 * writes `reconciledThrough`/`targetThrough`. Concretely: if the durable
 * checkpoint is Aug 5 and an admin reconciles Aug 20 -> Aug 21, the
 * checkpoint stays at Aug 5 afterward — reconciling one later window is not
 * proof the Aug 5 -> Aug 20 gap was ever checked.
 *
 * ===========================================================================
 * CONCURRENCY
 * ===========================================================================
 * Every state read-to-decide and every state write happens inside a
 * transaction that calls `lockCommerceConnectionForTransaction` FIRST (the
 * same real Postgres row lock `product-sync.ts`'s `claimProductSyncRun` and
 * `applyProductWrite` already use — see `../connection-row-lock.ts`) — never
 * held across the Commerce7 HTTP call in between. Two concurrent "Catch Up"
 * clicks for the SAME connection therefore fully serialize at the
 * checkpoint-decide and checkpoint-advance steps; two DIFFERENT connections'
 * reconciliation never contend with each other (per-row lock, not global).
 *
 * NO AGE-BASED "ASSUME ABANDONED" RECOVERY EXISTS ANYWHERE IN THIS MODULE —
 * see the `CommerceOrderReconciliationState` schema doc comment for why no
 * "in progress" flag is even stored. A stale/abandoned request simply never
 * advances anything; the durable checkpoint it would have advanced from is
 * exactly where the NEXT request (from anyone) resumes.
 */

import { CommerceProvider, type CommerceConnectionStatus } from "@prisma/client";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
  CommerceProviderApiError,
} from "../errors";
import { lockCommerceConnectionForTransaction } from "../connection-row-lock";
import {
  backfillCommerce7Orders,
  type Commerce7OrderBackfillOutcome,
} from "./commerce7-order-backfill";

/** Starting chunk width — see file header for why this is adaptive, not a hard safety bound. */
export const DEFAULT_CHUNK_WIDTH_MS = 24 * 60 * 60 * 1000;
/** Narrowing floor — a chunk this size that still truncates is reported as a genuine failure, never silently skipped. */
export const MIN_CHUNK_WIDTH_MS = 60 * 60 * 1000;
/** Bounds the narrowing loop itself — 24h -> 12h -> 6h -> 3h -> 1.5h -> clamped to the 1h floor. */
export const MAX_NARROWING_ATTEMPTS = 6;
/** A generous but bounded ceiling for one Custom Range request — chunked internally regardless. */
export const MAX_CUSTOM_RANGE_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

export type Commerce7ReconciliationConnectionRow = {
  id: string;
  brandId: string;
  provider: CommerceProvider;
  status: CommerceConnectionStatus;
  externalAccountId: string;
  createdAt: Date;
  providerMetadata: unknown;
};

export type Commerce7ReconciliationStateRow = {
  reconciledThrough: Date | null;
  targetThrough: Date | null;
  lastAttemptedAt: Date | null;
  lastRunOutcome: string | null;
  lastRunError: string | null;
  customRangeFrom: Date | null;
  customRangeTo: Date | null;
  customRangeCursor: Date | null;
};

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
 * Everything one locked critical section needs. Every method here MUST be
 * called only from inside `runInTransaction`'s callback, against the SAME
 * `tx` — see `../connection-row-lock.ts`'s usage contract (lock first,
 * never held across provider HTTP).
 */
export type Commerce7ReconciliationTx = {
  /** Real-locks the connection row FIRST, then reads the connection + reconciliation state (a missing state row reads as `EMPTY_STATE`, never null). */
  lockAndLoad(connectionId: string): Promise<{
    connection: Commerce7ReconciliationConnectionRow | null;
    state: Commerce7ReconciliationStateRow;
  }>;
  /** Upserts the row if missing. Never touches `reconciledThrough`/customRange fields. */
  setTargetThrough(connectionId: string, brandId: string, target: Date): Promise<void>;
  /** Conditional advance — a no-op if the stored value is already >= `through`. Never moves the checkpoint backwards. */
  advanceReconciledThrough(connectionId: string, brandId: string, through: Date): Promise<void>;
  recordCatchUpAttempt(
    connectionId: string,
    brandId: string,
    input: { outcome: string; error: string | null },
  ): Promise<void>;
  /** Upserts the row if missing, and RESETS the cursor to `from` — call only when starting a genuinely NEW custom range (different from/to than currently stored). */
  setCustomRange(connectionId: string, brandId: string, from: Date, to: Date, cursor: Date): Promise<void>;
  /** Conditional advance — same forward-only guarantee as `advanceReconciledThrough`, but for the independent custom-range cursor. */
  advanceCustomRangeCursor(connectionId: string, brandId: string, cursor: Date): Promise<void>;
  recordCustomRangeAttempt(
    connectionId: string,
    brandId: string,
    input: { outcome: string; error: string | null },
  ): Promise<void>;
};

export type Commerce7ReconciliationDeps = {
  runInTransaction<T>(fn: (tx: Commerce7ReconciliationTx) => Promise<T>): Promise<T>;
  fetchOrders: typeof backfillCommerce7Orders;
  now(): Date;
};

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

function toStateRow(
  row: {
    reconciledThrough: Date | null;
    targetThrough: Date | null;
    lastAttemptedAt: Date | null;
    lastRunOutcome: string | null;
    lastRunError: string | null;
    customRangeFrom: Date | null;
    customRangeTo: Date | null;
    customRangeCursor: Date | null;
  } | null,
): Commerce7ReconciliationStateRow {
  if (!row) return EMPTY_STATE;
  return { ...row };
}

function buildTx(tx: import("@prisma/client").Prisma.TransactionClient): Commerce7ReconciliationTx {
  return {
    async lockAndLoad(connectionId) {
      await lockCommerceConnectionForTransaction(tx, connectionId);
      const connection = await tx.commerceConnection.findUnique({
        where: { id: connectionId },
        select: {
          id: true,
          brandId: true,
          provider: true,
          status: true,
          externalAccountId: true,
          createdAt: true,
          providerMetadata: true,
        },
      });
      const state = await tx.commerceOrderReconciliationState.findUnique({
        where: { connectionId },
      });
      return { connection, state: toStateRow(state) };
    },
    async setTargetThrough(connectionId, brandId, target) {
      await tx.commerceOrderReconciliationState.upsert({
        where: { connectionId },
        create: { connectionId, brandId, targetThrough: target },
        update: { targetThrough: target },
      });
    },
    async advanceReconciledThrough(connectionId, brandId, through) {
      const updated = await tx.commerceOrderReconciliationState.updateMany({
        where: {
          connectionId,
          OR: [{ reconciledThrough: null }, { reconciledThrough: { lt: through } }],
        },
        data: { reconciledThrough: through },
      });
      if (updated.count === 0) {
        // No existing row matched the conditional guard — either the row
        // doesn't exist yet (first-ever chunk) or it's already >= through
        // (a concurrent/duplicate call already advanced past this point,
        // which is the exact race this guard exists to make safe). Upsert
        // only creates a row when one is genuinely missing; it can never
        // regress an existing, already-more-advanced value, because the
        // `create` branch only fires when no row exists at all.
        await tx.commerceOrderReconciliationState.upsert({
          where: { connectionId },
          create: { connectionId, brandId, reconciledThrough: through },
          update: {},
        });
      }
    },
    async recordCatchUpAttempt(connectionId, brandId, input) {
      await tx.commerceOrderReconciliationState.upsert({
        where: { connectionId },
        create: {
          connectionId,
          brandId,
          lastAttemptedAt: new Date(),
          lastRunOutcome: input.outcome,
          lastRunError: input.error,
        },
        update: {
          lastAttemptedAt: new Date(),
          lastRunOutcome: input.outcome,
          lastRunError: input.error,
        },
      });
    },
    async setCustomRange(connectionId, brandId, from, to, cursor) {
      await tx.commerceOrderReconciliationState.upsert({
        where: { connectionId },
        create: { connectionId, brandId, customRangeFrom: from, customRangeTo: to, customRangeCursor: cursor },
        update: { customRangeFrom: from, customRangeTo: to, customRangeCursor: cursor },
      });
    },
    async advanceCustomRangeCursor(connectionId, brandId, cursor) {
      const updated = await tx.commerceOrderReconciliationState.updateMany({
        where: {
          connectionId,
          OR: [{ customRangeCursor: null }, { customRangeCursor: { lt: cursor } }],
        },
        data: { customRangeCursor: cursor },
      });
      if (updated.count === 0) {
        await tx.commerceOrderReconciliationState.upsert({
          where: { connectionId },
          create: { connectionId, brandId, customRangeCursor: cursor },
          update: {},
        });
      }
    },
    async recordCustomRangeAttempt(connectionId, brandId, input) {
      await tx.commerceOrderReconciliationState.upsert({
        where: { connectionId },
        create: {
          connectionId,
          brandId,
          lastAttemptedAt: new Date(),
          lastRunOutcome: input.outcome,
          lastRunError: input.error,
        },
        update: {
          lastAttemptedAt: new Date(),
          lastRunOutcome: input.outcome,
          lastRunError: input.error,
        },
      });
    },
  };
}

async function defaultRunInTransaction<T>(
  fn: (tx: Commerce7ReconciliationTx) => Promise<T>,
): Promise<T> {
  const prisma = await getPrisma();
  return prisma.$transaction((tx) => fn(buildTx(tx)));
}

const DEFAULT_DEPS: Commerce7ReconciliationDeps = {
  runInTransaction: defaultRunInTransaction,
  fetchOrders: backfillCommerce7Orders,
  now: () => new Date(),
};

function assertOwnedConnectedCommerce7(
  connectionId: string,
  brandId: string,
  connection: Commerce7ReconciliationConnectionRow | null,
): asserts connection is Commerce7ReconciliationConnectionRow {
  if (!connection || connection.brandId !== brandId) {
    throw new CommerceConnectionNotFoundError(connectionId);
  }
  if (connection.provider !== CommerceProvider.COMMERCE7) {
    throw new CommerceConnectionMismatchError(connectionId, CommerceProvider.COMMERCE7, connection.provider);
  }
  if (connection.status !== "CONNECTED") {
    throw new CommerceConnectionNotReadyError(connection.id, connection.provider, connection.status);
  }
}

/** Sanitized classification only — never a raw provider message/body. */
function classifyChunkError(error: unknown): string {
  if (error instanceof CommerceProviderApiError) {
    return error.message;
  }
  return "An unexpected error occurred while reconciling orders.";
}

export type Commerce7ReconciliationChunkAttempt = {
  achievedThrough: Date | null;
  outcome: "PROGRESS" | "FAILED";
  error: string | null;
  ordersFetched: number;
  ordersProcessed: number;
  chunk: { from: Date; to: Date };
};

/**
 * Processes ONE requested window `[from, to]`, narrowing adaptively on a
 * `TRUNCATED` provider result until a PROVABLY complete (narrower) sub-window
 * succeeds, or the narrowing floor is reached — see file header. Never holds
 * any lock; this is the unlocked, provider-HTTP phase of one reconciliation
 * step. Idempotent regardless of how many times a window is retried (see
 * `backfillCommerce7Orders`'s own dedup discipline).
 */
export async function processOneChunk(
  input: { brandId: string; connectionId: string; from: Date; to: Date },
  deps: Commerce7ReconciliationDeps,
): Promise<Commerce7ReconciliationChunkAttempt> {
  let width = input.to.getTime() - input.from.getTime();
  let totalFetched = 0;
  let totalProcessed = 0;

  for (let attempt = 0; attempt <= MAX_NARROWING_ATTEMPTS; attempt += 1) {
    const chunkTo = new Date(Math.min(input.from.getTime() + width, input.to.getTime()));

    let outcome: Commerce7OrderBackfillOutcome;
    try {
      outcome = await deps.fetchOrders({
        brandId: input.brandId,
        connectionId: input.connectionId,
        updatedAtGte: input.from,
        updatedAtLte: chunkTo,
      });
    } catch (error) {
      // A genuine provider/network failure — narrowing cannot help this,
      // only a truncated RESULT set benefits from a smaller window.
      return {
        achievedThrough: null,
        outcome: "FAILED",
        error: classifyChunkError(error),
        ordersFetched: totalFetched,
        ordersProcessed: totalProcessed,
        chunk: { from: input.from, to: chunkTo },
      };
    }

    totalFetched += outcome.ordersFetched;
    totalProcessed += outcome.ordersProcessed;

    if (outcome.status === "COMPLETED") {
      return {
        achievedThrough: chunkTo,
        outcome: "PROGRESS",
        error: null,
        ordersFetched: totalFetched,
        ordersProcessed: totalProcessed,
        chunk: { from: input.from, to: chunkTo },
      };
    }

    // TRUNCATED: some orders in [from, chunkTo] were ingested (safely,
    // idempotently) but completeness for the FULL window is unproven — the
    // checkpoint must never advance to chunkTo on this basis.
    if (width <= MIN_CHUNK_WIDTH_MS) {
      return {
        achievedThrough: null,
        outcome: "FAILED",
        error:
          "Too many orders changed in the minimum reconciliation window to fetch completely. Try a narrower Custom Range.",
        ordersFetched: totalFetched,
        ordersProcessed: totalProcessed,
        chunk: { from: input.from, to: chunkTo },
      };
    }
    width = Math.max(Math.floor(width / 2), MIN_CHUNK_WIDTH_MS);
  }

  return {
    achievedThrough: null,
    outcome: "FAILED",
    error: "Exceeded the maximum number of narrowing attempts for this chunk.",
    ordersFetched: totalFetched,
    ordersProcessed: totalProcessed,
    chunk: { from: input.from, to: input.to },
  };
}

export type Commerce7ReconciliationStepStatus = "UP_TO_DATE" | "PROGRESS" | "FAILED";

export type Commerce7CatchUpStepResult = {
  status: Commerce7ReconciliationStepStatus;
  reconciledThrough: Date | null;
  target: Date;
  reachedTarget: boolean;
  chunk: { from: Date; to: Date } | null;
  ordersFetched: number;
  ordersProcessed: number;
  error: string | null;
};

/**
 * Runs ONE bounded chunk of the primary, contiguous "Catch Up" sequence for
 * an exact, owned, CONNECTED Commerce7 connection. Safe to call repeatedly —
 * each call processes at most one (adaptively-narrowed) chunk and returns
 * immediately; the caller decides whether to call again (`reachedTarget:
 * false`) or stop. Throws the standard ownership/provider/status errors;
 * never throws for an ordinary provider/truncation failure — that is
 * reported as `status: "FAILED"` with a sanitized `error`.
 */
export async function runCatchUpStep(
  input: { brandId: string; connectionId: string },
  deps: Partial<Commerce7ReconciliationDeps> = {},
): Promise<Commerce7CatchUpStepResult> {
  const resolved: Commerce7ReconciliationDeps = { ...DEFAULT_DEPS, ...deps };

  const decision = await resolved.runInTransaction(async (tx) => {
    const { connection, state } = await tx.lockAndLoad(input.connectionId);
    assertOwnedConnectedCommerce7(input.connectionId, input.brandId, connection);

    const now = resolved.now();
    // Reuse the existing in-flight target unless it has already been fully
    // reached (or never set) — this is what makes a resumed/second click
    // converge on the SAME target instead of perpetually chasing "now".
    const target =
      state.targetThrough && (!state.reconciledThrough || state.reconciledThrough < state.targetThrough)
        ? state.targetThrough
        : now;

    const chunkStart = state.reconciledThrough ?? connection.createdAt;
    if (chunkStart.getTime() >= target.getTime()) {
      return { kind: "UP_TO_DATE" as const, reconciledThrough: state.reconciledThrough, target };
    }

    const chunkEnd = new Date(Math.min(chunkStart.getTime() + DEFAULT_CHUNK_WIDTH_MS, target.getTime()));
    await tx.setTargetThrough(input.connectionId, input.brandId, target);

    return { kind: "CHUNK" as const, chunkStart, chunkEnd, target };
  });

  if (decision.kind === "UP_TO_DATE") {
    return {
      status: "UP_TO_DATE",
      reconciledThrough: decision.reconciledThrough,
      target: decision.target,
      reachedTarget: true,
      chunk: null,
      ordersFetched: 0,
      ordersProcessed: 0,
      error: null,
    };
  }

  const attempt = await processOneChunk(
    { brandId: input.brandId, connectionId: input.connectionId, from: decision.chunkStart, to: decision.chunkEnd },
    resolved,
  );

  return resolved.runInTransaction(async (tx) => {
    if (attempt.achievedThrough) {
      await tx.advanceReconciledThrough(input.connectionId, input.brandId, attempt.achievedThrough);
    }
    await tx.recordCatchUpAttempt(input.connectionId, input.brandId, {
      outcome: attempt.outcome === "PROGRESS" ? "SUCCEEDED" : "FAILED",
      error: attempt.error,
    });
    const { state: finalState } = await tx.lockAndLoad(input.connectionId);
    return {
      status: attempt.outcome,
      reconciledThrough: finalState.reconciledThrough,
      target: decision.target,
      reachedTarget: Boolean(
        finalState.reconciledThrough && finalState.reconciledThrough.getTime() >= decision.target.getTime(),
      ),
      chunk: attempt.chunk,
      ordersFetched: attempt.ordersFetched,
      ordersProcessed: attempt.ordersProcessed,
      error: attempt.error,
    };
  });
}

export type Commerce7CustomRangeStepResult = {
  status: Commerce7ReconciliationStepStatus;
  cursor: Date | null;
  from: Date;
  to: Date;
  reachedTarget: boolean;
  chunk: { from: Date; to: Date } | null;
  ordersFetched: number;
  ordersProcessed: number;
  error: string | null;
};

/**
 * Runs ONE bounded chunk of an explicit, admin-requested custom-range
 * repair — see file header for why this NEVER touches the primary
 * `reconciledThrough`/`targetThrough` checkpoint. Calling this again with
 * the SAME `[from, to]` resumes from `customRangeCursor`; calling it with a
 * DIFFERENT `[from, to]` starts a fresh custom-range sequence (resets the
 * cursor to the new `from`).
 */
export async function runCustomRangeStep(
  input: { brandId: string; connectionId: string; from: Date; to: Date },
  deps: Partial<Commerce7ReconciliationDeps> = {},
): Promise<Commerce7CustomRangeStepResult> {
  const resolved: Commerce7ReconciliationDeps = { ...DEFAULT_DEPS, ...deps };

  const decision = await resolved.runInTransaction(async (tx) => {
    const { connection, state } = await tx.lockAndLoad(input.connectionId);
    assertOwnedConnectedCommerce7(input.connectionId, input.brandId, connection);

    const isSameRange =
      state.customRangeFrom?.getTime() === input.from.getTime() &&
      state.customRangeTo?.getTime() === input.to.getTime();
    const cursor = isSameRange && state.customRangeCursor ? state.customRangeCursor : input.from;

    if (!isSameRange || !state.customRangeCursor) {
      await tx.setCustomRange(input.connectionId, input.brandId, input.from, input.to, cursor);
    }

    if (cursor.getTime() >= input.to.getTime()) {
      return { kind: "UP_TO_DATE" as const, cursor };
    }

    const chunkEnd = new Date(Math.min(cursor.getTime() + DEFAULT_CHUNK_WIDTH_MS, input.to.getTime()));
    return { kind: "CHUNK" as const, chunkStart: cursor, chunkEnd };
  });

  if (decision.kind === "UP_TO_DATE") {
    return {
      status: "UP_TO_DATE",
      cursor: decision.cursor,
      from: input.from,
      to: input.to,
      reachedTarget: true,
      chunk: null,
      ordersFetched: 0,
      ordersProcessed: 0,
      error: null,
    };
  }

  const attempt = await processOneChunk(
    { brandId: input.brandId, connectionId: input.connectionId, from: decision.chunkStart, to: decision.chunkEnd },
    resolved,
  );

  return resolved.runInTransaction(async (tx) => {
    if (attempt.achievedThrough) {
      await tx.advanceCustomRangeCursor(input.connectionId, input.brandId, attempt.achievedThrough);
    }
    await tx.recordCustomRangeAttempt(input.connectionId, input.brandId, {
      outcome: attempt.outcome === "PROGRESS" ? "SUCCEEDED" : "FAILED",
      error: attempt.error,
    });
    const { state: finalState } = await tx.lockAndLoad(input.connectionId);
    return {
      status: attempt.outcome,
      cursor: finalState.customRangeCursor,
      from: input.from,
      to: input.to,
      reachedTarget: Boolean(
        finalState.customRangeCursor && finalState.customRangeCursor.getTime() >= input.to.getTime(),
      ),
      chunk: attempt.chunk,
      ordersFetched: attempt.ordersFetched,
      ordersProcessed: attempt.ordersProcessed,
      error: attempt.error,
    };
  });
}

export type Commerce7ReconciliationStateView = {
  reconciledThrough: string | null;
  targetThrough: string | null;
  lastAttemptedAt: string | null;
  lastRunOutcome: string | null;
  lastRunError: string | null;
  customRangeFrom: string | null;
  customRangeTo: string | null;
  customRangeCursor: string | null;
};

/**
 * Read-only state fetch for page load/reload — never creates a row, never
 * locks, never touches Commerce7. A connection that has never had a
 * reconciliation attempt simply reads back every field as `null`.
 */
export async function getReconciliationState(
  input: { brandId: string; connectionId: string },
  deps: { loadConnection?: (connectionId: string) => Promise<Commerce7ReconciliationConnectionRow | null> } = {},
): Promise<Commerce7ReconciliationStateView> {
  const prisma = await getPrisma();
  const loadConnection =
    deps.loadConnection ??
    (async (connectionId: string) =>
      prisma.commerceConnection.findUnique({
        where: { id: connectionId },
        select: {
          id: true,
          brandId: true,
          provider: true,
          status: true,
          externalAccountId: true,
          createdAt: true,
          providerMetadata: true,
        },
      }));

  const connection = await loadConnection(input.connectionId);
  assertOwnedCommerce7Readonly(input.connectionId, input.brandId, connection);

  const row = await prisma.commerceOrderReconciliationState.findUnique({
    where: { connectionId: input.connectionId },
  });
  const state = toStateRow(row);

  return {
    reconciledThrough: state.reconciledThrough?.toISOString() ?? null,
    targetThrough: state.targetThrough?.toISOString() ?? null,
    lastAttemptedAt: state.lastAttemptedAt?.toISOString() ?? null,
    lastRunOutcome: state.lastRunOutcome,
    lastRunError: state.lastRunError,
    customRangeFrom: state.customRangeFrom?.toISOString() ?? null,
    customRangeTo: state.customRangeTo?.toISOString() ?? null,
    customRangeCursor: state.customRangeCursor?.toISOString() ?? null,
  };
}

/** Same ownership/provider checks as the write paths, but permits a non-CONNECTED status (a Brand Admin reading state for a DISCONNECTED connection is a normal, safe read). */
function assertOwnedCommerce7Readonly(
  connectionId: string,
  brandId: string,
  connection: Commerce7ReconciliationConnectionRow | null,
): asserts connection is Commerce7ReconciliationConnectionRow {
  if (!connection || connection.brandId !== brandId) {
    throw new CommerceConnectionNotFoundError(connectionId);
  }
  if (connection.provider !== CommerceProvider.COMMERCE7) {
    throw new CommerceConnectionMismatchError(connectionId, CommerceProvider.COMMERCE7, connection.provider);
  }
}
