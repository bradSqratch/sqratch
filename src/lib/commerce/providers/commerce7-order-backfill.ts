/**
 * src/lib/commerce/providers/commerce7-order-backfill.ts
 *
 * PHASE 16 BIG ROUND / SUBPHASE 4 — OPTIONAL, BOUNDED Commerce7 order
 * backfill/reconciliation entrypoint.
 *
 * NEVER AUTO-RUN: this module is a plain, importable, DI-testable function.
 * It is not wired to any cron job or startup hook — nothing calls it
 * automatically. It IS wired to one authenticated, Brand-admin-triggered
 * route: `POST /api/brand/commerce/connections/[connectionId]/orders/reconcile`
 * (PHASE 18 PART 9 — see that route's own doc comment), which is the ONLY
 * caller in this codebase and never invokes this function on its own
 * initiative (no cron, no webhook, no startup hook triggers that route
 * either).
 *
 * WHY BOUNDED: Commerce7's `GET /order` list endpoint documents NO
 * cursor/pagination mechanism (a confirmed, genuine gap — see
 * `fetchCommerce7OrdersByDateRange`'s doc comment in `./commerce7-orders.ts`).
 * An unbounded historical importer against a provider with no pagination
 * could silently truncate or run forever, so this entrypoint REQUIRES an
 * explicit, finite `[updatedAtGte, updatedAtLte]` window and additionally
 * enforces a hard result-count ceiling
 * (`COMMERCE7_BACKFILL_MAX_RESULTS`) — it refuses to process more than that
 * many orders in one call rather than silently processing a prefix.
 *
 * IDEMPOTENCY WITHOUT A WEBHOOK DELIVERY: a backfill run has no raw request
 * body to hash the way a webhook delivery does. Its `providerEventId` is
 * instead deterministically derived from
 * `(connectionId, externalOrderId, providerUpdatedAt)` — so re-running the
 * SAME backfill window twice, with NO change on Commerce7's side, produces
 * the SAME event id both times and is safely recognized as already
 * processed by the existing `CommerceOrderEvent` claim machinery. If the
 * order's `updatedAt` genuinely changed between runs, a new event id is
 * produced and the update is applied — the same idempotency guarantee the
 * webhook path gets from a fresh HMAC/Basic-Auth delivery, derived here
 * from the provider's own reported timestamp instead.
 */

import { CommerceProvider, type CommerceConnectionStatus } from "@prisma/client";
import crypto from "node:crypto";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "../errors";
import { extractCurrencyCodeFromProviderMetadata } from "../connection-resolver";
import {
  ingestNormalizedOrder,
  type OrderIngestionDeps,
  type OrderIngestionOutcome,
} from "../order-ingestion";
import {
  fetchCommerce7OrdersByDateRange,
  COMMERCE7_BACKFILL_MAX_RESULTS,
  type Commerce7Fetch,
} from "./commerce7-orders";
import {
  prepareCommerce7OrderForIngestion,
  type PrepareCommerce7OrderForIngestionResult,
} from "./commerce7-order-refund-reconciliation";

export type Commerce7BackfillConnectionRow = {
  id: string;
  brandId: string;
  provider: CommerceProvider;
  status: CommerceConnectionStatus;
  externalAccountId: string;
  providerMetadata: unknown;
};

export type Commerce7OrderBackfillInput = {
  brandId: string;
  connectionId: string;
  /** Inclusive lower bound — required. */
  updatedAtGte: Date;
  /** Inclusive upper bound — required. */
  updatedAtLte: Date;
};

export type Commerce7OrderBackfillOutcome = {
  status: "COMPLETED" | "TRUNCATED";
  ordersFetched: number;
  ordersProcessed: number;
  outcomes: OrderIngestionOutcome[];
};

export type Commerce7OrderBackfillDeps = {
  loadConnection(connectionId: string): Promise<Commerce7BackfillConnectionRow | null>;
  fetchOrders: typeof fetchCommerce7OrdersByDateRange;
  ingest: typeof ingestNormalizedOrder;
  ingestionDeps: Partial<OrderIngestionDeps>;
  /**
   * PHASE 25 — the SAME refund-aware preparation
   * `./commerce7-order-webhook.ts` uses (see
   * `./commerce7-order-refund-reconciliation.ts`), so a missed refund
   * webhook is fully repairable by re-running Catch Up / a Custom Range
   * covering the refund's `updatedAt` — this round's explicit requirement
   * that live webhook and manual backfill never drift onto different
   * refund semantics.
   */
  prepareOrder: typeof prepareCommerce7OrderForIngestion;
  fetchImpl?: Commerce7Fetch;
};

async function defaultLoadConnection(
  connectionId: string,
): Promise<Commerce7BackfillConnectionRow | null> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.commerceConnection.findFirst({
    where: { id: connectionId, provider: CommerceProvider.COMMERCE7 },
    select: {
      id: true,
      brandId: true,
      provider: true,
      status: true,
      externalAccountId: true,
      providerMetadata: true,
    },
  });
}

const DEFAULT_DEPS: Commerce7OrderBackfillDeps = {
  loadConnection: defaultLoadConnection,
  fetchOrders: fetchCommerce7OrdersByDateRange,
  ingest: ingestNormalizedOrder,
  ingestionDeps: {},
  prepareOrder: prepareCommerce7OrderForIngestion,
};

/** Deterministic backfill dedup key — see file header. */
function backfillProviderEventId(
  connectionId: string,
  externalOrderId: string,
  providerUpdatedAt: string,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(`${connectionId}:${externalOrderId}:${providerUpdatedAt}`, "utf8")
    .digest("hex");
  return `backfill:${digest}`;
}

/**
 * Runs ONE bounded backfill pass. Requires an EXACT, owned, CONNECTED
 * Commerce7 connection (the same exact-connection boundary discipline as
 * every other Commerce7 entry point in this codebase) — a foreign or
 * missing `connectionId` throws `CommerceConnectionNotFoundError`, a
 * wrong-provider connection throws `CommerceConnectionMismatchError`, and a
 * non-CONNECTED Commerce7 connection throws `CommerceConnectionNotReadyError`.
 *
 * Truncates (rather than looping for more pages — there is no pagination to
 * loop through) at `COMMERCE7_BACKFILL_MAX_RESULTS` and reports
 * `status: "TRUNCATED"` so a caller can narrow the window and re-run rather
 * than silently believing the window was fully covered.
 */
export async function backfillCommerce7Orders(
  input: Commerce7OrderBackfillInput,
  deps: Partial<Commerce7OrderBackfillDeps> = {},
): Promise<Commerce7OrderBackfillOutcome> {
  const resolved: Commerce7OrderBackfillDeps = { ...DEFAULT_DEPS, ...deps };

  const connection = await resolved.loadConnection(input.connectionId);
  if (!connection || connection.brandId !== input.brandId) {
    throw new CommerceConnectionNotFoundError(input.connectionId);
  }
  if (connection.provider !== CommerceProvider.COMMERCE7) {
    throw new CommerceConnectionMismatchError(
      input.connectionId,
      CommerceProvider.COMMERCE7,
      connection.provider,
    );
  }
  if (connection.status !== "CONNECTED") {
    throw new CommerceConnectionNotReadyError(connection.id, connection.provider, connection.status);
  }

  const currencyCode = extractCurrencyCodeFromProviderMetadata(
    connection.providerMetadata as Parameters<typeof extractCurrencyCodeFromProviderMetadata>[0],
  );

  const page = await resolved.fetchOrders(
    {
      tenant: connection.externalAccountId,
      updatedAtGte: input.updatedAtGte,
      updatedAtLte: input.updatedAtLte,
    },
    { fetchImpl: resolved.fetchImpl },
  );

  const truncated = page.orders.length > COMMERCE7_BACKFILL_MAX_RESULTS;
  const ordersToProcess = page.orders.slice(0, COMMERCE7_BACKFILL_MAX_RESULTS);

  const outcomes: OrderIngestionOutcome[] = [];
  // A backfill window can legitimately contain BOTH a root order and one or
  // more of its own linked refund orders — the realistic repair case this
  // round exists for (see the round's brief, Part 20). Each such entry
  // independently resolves to the SAME root and reconciles the SAME
  // linked-order set via `prepareOrder`, so memoizing by root id within
  // this ONE pass avoids redundantly re-fetching and re-summing every
  // linked refund order once per raw entry that points at it. Purely an
  // in-memory, single-call optimization — never persisted, never shared
  // across separate backfill/Catch-Up invocations — and scoped ONLY to
  // orders that actually went through refund reconciliation, so an ordinary
  // (never-refunded) order's behavior is completely unaffected.
  const reconciledRootIds = new Set<string>();

  for (const raw of ordersToProcess) {
    const prepared: PrepareCommerce7OrderForIngestionResult = await resolved.prepareOrder(
      raw,
      {
        connectionId: connection.id,
        brandId: connection.brandId,
        provider: CommerceProvider.COMMERCE7,
        currencyCode,
      },
      connection.externalAccountId,
    );

    if (prepared.outcome === "TRANSIENT_FAILURE") {
      // Skip this one order for this pass rather than persist a
      // refund-blind guess. A later Catch Up / Custom Range run retries
      // it — the same self-healing property the rest of this backfill
      // entrypoint already relies on.
      continue;
    }

    const { order } = prepared;

    if (!order.externalOrderId || !order.providerUpdatedAt) {
      // Cannot form a stable dedup key without both — skip rather than
      // guess at an event id (see file header's IDEMPOTENCY section).
      continue;
    }

    if (prepared.refundReconciliationOutcome !== "NOT_APPLICABLE") {
      if (reconciledRootIds.has(order.externalOrderId)) {
        // Already reconciled and written this SAME root id from an earlier
        // entry in this same page — see the memoization note above.
        continue;
      }
      reconciledRootIds.add(order.externalOrderId);
    }

    const providerEventId = backfillProviderEventId(
      connection.id,
      order.externalOrderId,
      order.providerUpdatedAt.toISOString(),
    );
    const payloadDigest = crypto
      .createHash("sha256")
      .update(JSON.stringify(raw), "utf8")
      .digest("hex");

    const outcome = await resolved.ingest(
      {
        providerEventId,
        topic: "commerce7:order:backfill",
        payloadDigest,
        connectionId: connection.id,
        brandId: connection.brandId,
        provider: CommerceProvider.COMMERCE7,
      },
      order,
      resolved.ingestionDeps,
    );
    outcomes.push(outcome);
  }

  return {
    status: truncated ? "TRUNCATED" : "COMPLETED",
    ordersFetched: page.orders.length,
    ordersProcessed: outcomes.length,
    outcomes,
  };
}
