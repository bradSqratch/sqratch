/**
 * tests/commerce7-refund-repair-pipeline.test.ts
 *
 * PHASE 27 — FULL-PIPELINE regression for the exact production failure.
 *
 * WHY THIS FILE EXISTS. Phase 25/26 tested `prepareCommerce7OrderForIngestion`
 * in isolation and every one of those tests passed — yet production still did
 * not repair Commerce7 order #1002. The failure was downstream of prepare, at
 * the GENERIC INGESTION boundary: the reconciled snapshot carried the same
 * `providerUpdatedAt` as the stored row, and `decideOrderStaleness` correctly
 * (by its old rule) called that STALE. No isolated prepare test could have
 * caught it.
 *
 * So this file wires the REAL modules together —
 * `backfillCommerce7Orders` -> the REAL `prepareCommerce7OrderForIngestion`
 * -> the REAL `ingestNormalizedOrder` -> the REAL `decideOrderStaleness` —
 * over an in-memory storage seam, and asserts the CANONICAL ROW's final
 * state. Only the database and the Commerce7 HTTP client are faked; every
 * decision under test is made by production code.
 *
 * The fixtures reproduce the verified sandbox chronology exactly:
 *   canonical #1002 stored at  T = 2026-08-26T18:11:55.847Z (PAID, refunded 0)
 *   provider root #1002 at     T                            (linkedOrders -> #1003)
 *   provider refund #1003 at   T - 635ms                    (settled -3277)
 *
 * No customer name, email, phone, address, IP or card data appears anywhere.
 */
import "./env-setup";

process.env.COMMERCE7_APP_ID = "test-app-id";
process.env.COMMERCE7_APP_SECRET = "test-app-secret";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import {
  CommerceProvider,
  type CommerceOrderFinancialStatus,
  type Prisma,
} from "@prisma/client";

import {
  backfillCommerce7Orders,
  COMMERCE7_REFUND_RECONCILIATION_SEMANTICS_VERSION,
  type Commerce7BackfillConnectionRow,
} from "../src/lib/commerce/providers/commerce7-order-backfill";
import { prepareCommerce7OrderForIngestion } from "../src/lib/commerce/providers/commerce7-order-refund-reconciliation";
import {
  ingestNormalizedOrder,
  decideOrderStaleness,
  type OrderEventClaim,
  type OrderIngestionConnection,
  type OrderIngestionOutcome,
} from "../src/lib/commerce/order-ingestion";
import { CommerceProviderApiError } from "../src/lib/commerce/errors";

// ---------------------------------------------------------------------------
// The verified production chronology.
// ---------------------------------------------------------------------------

const ROOT_UPDATED_AT = "2026-08-26T18:11:55.847Z";
/** 635ms BEFORE the root — the real sandbox ordering. */
const REFUND_UPDATED_AT = "2026-08-26T18:11:55.212Z";

const ROOT_ID = "c93ea68d-ee3e-43da-897b-3d28e8da1ec8";
const REFUND_ID = "57391df9-8d44-4295-a55d-a731d1e38782";
const TENANT = "sqratch-inc";
const CONNECTION_ID = "conn-1";
const BRAND_ID = "brand-a";

function providerRootOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROOT_ID,
    orderNumber: 1002,
    paymentStatus: "Paid",
    fulfillmentStatus: "Fulfilled",
    subTotal: 8700,
    taxTotal: 1131,
    total: 9831,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: ROOT_UPDATED_AT,
    // The original order NEVER gains a Refund tender — this is the whole
    // reason a separate refund document has to be consulted.
    tenders: [{ id: "tender-sale-1", chargeType: "Sale", chargeStatus: "Success", amountTendered: 9831 }],
    linkedOrders: [{ orderId: REFUND_ID, orderNumber: 1003, purchaseType: "Refund" }],
    items: [
      { id: "line-1", productId: "prod-2015-chardonnay", productTitle: "Sample - 2015 Chardonnay", sku: "2015C", quantity: 1, price: 2900, tax: 377 },
      { id: "line-2", productId: "prod-2016-rose", productTitle: "Sample - 2016 Rose", sku: "2016R", quantity: 1, price: 1900, tax: 247 },
      { id: "line-3", productId: "prod-2016-reserve", productTitle: "Sample - 2016 Reserve Chardonnay", sku: "2016RC", quantity: 1, price: 3900, tax: 507 },
    ],
    ...overrides,
  };
}

function providerRefundOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: REFUND_ID,
    orderNumber: 1003,
    purchaseType: "Refund",
    previousOrderId: ROOT_ID,
    previousOrderNumber: 1002,
    paymentStatus: "Paid",
    subTotal: -2900,
    taxTotal: -377,
    total: -3277,
    createdAt: REFUND_UPDATED_AT,
    updatedAt: REFUND_UPDATED_AT,
    tenders: [{ id: "tender-refund-1", chargeType: "Refund", chargeStatus: "Success", amountTendered: -3277 }],
    items: [
      { id: "refund-line-1", productId: "prod-2015-chardonnay", productTitle: "Sample - 2015 Chardonnay", sku: "2015C", quantity: -1, price: 2900, tax: -377 },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory storage seam. Only the DB is faked; every decision is real code.
// ---------------------------------------------------------------------------

type StoredOrder = {
  id: string;
  connectionId: string;
  externalOrderId: string | null;
  totalMinor: bigint | null;
  totalRefundedMinor: bigint;
  netRevenueMinor: bigint | null;
  financialStatus: CommerceOrderFinancialStatus | null;
  fulfillmentStatus: string | null;
  providerUpdatedAt: Date | null;
  providerCreatedAt: Date | null;
  currencyCode: string | null;
  minorUnitExponent: number | null;
  subtotalMinor: bigint | null;
  discountsMinor: bigint | null;
  shippingMinor: bigint | null;
  taxMinor: bigint | null;
  orderNumber: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  attributionId: string | null;
};

type StoredLine = { orderId: string; sku: string | null; quantity: number; externalProductId: string | null };

/** Terminal statuses, mirroring `decideOrderEventClaim`'s own classification. */
const TERMINAL_EVENT_STATUSES = new Set(["PROCESSED", "SKIPPED_STALE", "SKIPPED_DISCONNECTED"]);

class FakeStore {
  nextId = 1;
  orders = new Map<string, StoredOrder>();
  lines: StoredLine[] = [];
  /** providerEventId -> status. Models `CommerceOrderEvent`'s claim column. */
  events = new Map<string, string>();
  claimedEventIds: string[] = [];

  seedOrder(row: Partial<StoredOrder> & { externalOrderId: string }): StoredOrder {
    const id = `order-row-${this.nextId++}`;
    const complete: StoredOrder = {
      id,
      connectionId: CONNECTION_ID,
      totalMinor: null,
      totalRefundedMinor: BigInt(0),
      netRevenueMinor: null,
      financialStatus: null,
      fulfillmentStatus: null,
      providerUpdatedAt: null,
      providerCreatedAt: null,
      currencyCode: null,
      minorUnitExponent: null,
      subtotalMinor: null,
      discountsMinor: null,
      shippingMinor: null,
      taxMinor: null,
      orderNumber: null,
      cancelledAt: null,
      cancelReason: null,
      attributionId: null,
      ...row,
    };
    this.orders.set(id, complete);
    return complete;
  }

  find(externalOrderId: string): StoredOrder | null {
    for (const row of this.orders.values()) {
      if (row.connectionId === CONNECTION_ID && row.externalOrderId === externalOrderId) return row;
    }
    return null;
  }

  linesFor(orderId: string): StoredLine[] {
    return this.lines.filter((l) => l.orderId === orderId);
  }

  /** Faithful stand-in for the four-state claim machine. */
  claim(providerEventId: string): OrderEventClaim {
    this.claimedEventIds.push(providerEventId);
    const existing = this.events.get(providerEventId);
    if (existing === undefined) {
      this.events.set(providerEventId, "RECEIVED");
      return { status: "CLAIMED", eventId: providerEventId };
    }
    if (TERMINAL_EVENT_STATUSES.has(existing)) {
      return { status: "COMPLETED_DUPLICATE", eventId: providerEventId };
    }
    if (existing === "FAILED") {
      this.events.set(providerEventId, "RECEIVED");
      return { status: "RECLAIMED", eventId: providerEventId };
    }
    return { status: "IN_FLIGHT", eventId: providerEventId };
  }

  /**
   * Stands in for `finalizeEvent`, which deliberately bypasses the DI object
   * and always imports the real Prisma client (there is an existing test in
   * `order-ingestion.test.ts` documenting exactly that). The test therefore
   * applies the terminal status itself, from the outcome production code
   * actually returned.
   */
  finalizeFromOutcomes(outcomes: readonly OrderIngestionOutcome[]): void {
    for (const outcome of outcomes) {
      if (!outcome.eventId) continue;
      const terminal =
        outcome.status === "SKIPPED_STALE"
          ? "SKIPPED_STALE"
          : outcome.status === "CREATED" || outcome.status === "UPDATED"
            ? "PROCESSED"
            : outcome.status === "FAILED"
              ? "FAILED"
              : null;
      if (terminal) this.events.set(outcome.eventId, terminal);
    }
  }

  tx(): Prisma.TransactionClient {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- captured for closures below.
    const store = this;
    const fake = {
      commerceOrder: {
        async findUnique({ where }: { where: { connectionId_externalOrderId: { connectionId: string; externalOrderId: string } } }) {
          return store.find(where.connectionId_externalOrderId.externalOrderId);
        },
        async updateMany({ where, data }: { where: { id: string; providerUpdatedAt: Date | null }; data: Record<string, unknown> }) {
          const row = store.orders.get(where.id);
          const storedTime = row?.providerUpdatedAt?.getTime() ?? null;
          const expectedTime = where.providerUpdatedAt?.getTime() ?? null;
          if (!row || storedTime !== expectedTime) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
        async create({ data }: { data: Record<string, unknown> }) {
          const created = store.seedOrder(data as Partial<StoredOrder> & { externalOrderId: string });
          return { id: created.id };
        },
        async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
          const row = store.orders.get(where.id);
          if (row) Object.assign(row, data);
          return row;
        },
      },
      commerceOrderLineItem: {
        async deleteMany({ where }: { where: { orderId: string } }) {
          store.lines = store.lines.filter((l) => l.orderId !== where.orderId);
          return { count: 0 };
        },
        async createMany({ data }: { data: StoredLine[] }) {
          store.lines.push(...data);
          return { count: data.length };
        },
      },
      connectedCommerceProduct: {
        async findMany() {
          return [];
        },
      },
      commerceClickAttribution: {
        async findUnique() {
          return null;
        },
        async updateMany() {
          return { count: 0 };
        },
      },
    };
    return fake as unknown as Prisma.TransactionClient;
  }
}

const CONNECTION: OrderIngestionConnection = {
  id: CONNECTION_ID,
  brandId: BRAND_ID,
  provider: CommerceProvider.COMMERCE7,
  status: "CONNECTED",
};

const BACKFILL_CONNECTION: Commerce7BackfillConnectionRow = {
  id: CONNECTION_ID,
  brandId: BRAND_ID,
  provider: CommerceProvider.COMMERCE7,
  status: "CONNECTED",
  externalAccountId: TENANT,
  providerMetadata: { currencyCode: "CAD" },
};

/**
 * Runs ONE real Custom-Range/Catch-Up backfill pass over `page`, with the
 * REAL prepare and REAL ingestion wired to the in-memory store.
 */
async function runBackfill(
  store: FakeStore,
  page: Record<string, unknown>[],
  providerOrdersById: Record<string, Record<string, unknown>>,
) {
  const result = await backfillCommerce7Orders(
    {
      brandId: BRAND_ID,
      connectionId: CONNECTION_ID,
      updatedAtGte: new Date("2026-08-25T04:47:00.000Z"),
      updatedAtLte: new Date("2026-08-27T04:47:00.000Z"),
    },
    {
      loadConnection: async () => BACKFILL_CONNECTION,
      fetchOrders: async () => ({ orders: page, total: page.length }),
      // THE REAL prepare — only its Commerce7 HTTP client and its stored-state
      // read are faked, so classification, linked-refund union, reconciliation,
      // monotonicity and the repair authorization are all production code.
      prepareOrder: (raw, context, tenant) =>
        prepareCommerce7OrderForIngestion(raw, context, tenant, {
          fetchOrder: async ({ externalOrderId }) => {
            const found = providerOrdersById[externalOrderId];
            if (!found) {
              throw new CommerceProviderApiError(CommerceProvider.COMMERCE7, "not found", undefined, 404);
            }
            return found;
          },
          loadStoredFinancialState: async ({ externalOrderId }) => {
            const row = store.find(externalOrderId);
            return row
              ? { totalRefundedMinor: row.totalRefundedMinor, financialStatus: row.financialStatus }
              : null;
          },
        }),
      // THE REAL generic ingestion, including the real staleness decision.
      ingest: ingestNormalizedOrder,
      ingestionDeps: {
        claimEvent: async (input) => store.claim(input.providerEventId),
        loadConnection: async () => CONNECTION,
        runTransaction: async (fn) => fn(store.tx()),
      },
    },
  );
  store.finalizeFromOutcomes(result.outcomes);
  return result;
}

function seedBrokenCanonicalOrder(store: FakeStore): StoredOrder {
  return store.seedOrder({
    externalOrderId: ROOT_ID,
    orderNumber: "1002",
    currencyCode: "CAD",
    minorUnitExponent: 2,
    totalMinor: BigInt(9831),
    totalRefundedMinor: BigInt(0),
    netRevenueMinor: BigInt(9831),
    financialStatus: "PAID",
    fulfillmentStatus: "FULFILLED",
    providerUpdatedAt: new Date(ROOT_UPDATED_AT),
  });
}

// ---------------------------------------------------------------------------
// THE MANDATORY PRODUCTION REGRESSION
// ---------------------------------------------------------------------------

describe("PHASE 27 — full pipeline: equal-version Commerce7 refund repair", () => {
  test("THE PRODUCTION CASE: stored #1002 at T, provider root at T, refund child at T-635ms -> canonical row REPAIRS without any fabricated timestamp", async () => {
    const store = new FakeStore();
    const stored = seedBrokenCanonicalOrder(store);

    const result = await runBackfill(
      store,
      [providerRootOrder(), providerRefundOrder()],
      { [ROOT_ID]: providerRootOrder(), [REFUND_ID]: providerRefundOrder() },
    );

    // The root was written, not skipped.
    const rootOutcome = result.outcomes.find((o) => o.orderId === stored.id);
    assert.ok(rootOutcome, "expected an ingestion outcome for the root order");
    assert.equal(rootOutcome?.status, "UPDATED", "the repair must APPLY, not be SKIPPED_STALE");

    const repaired = store.find(ROOT_ID);
    assert.ok(repaired);
    assert.equal(repaired?.financialStatus, "PARTIALLY_REFUNDED");
    assert.equal(repaired?.totalMinor, BigInt(9831));
    assert.equal(repaired?.totalRefundedMinor, BigInt(3277));
    assert.equal(repaired?.netRevenueMinor, BigInt(6554));
    assert.equal(repaired?.fulfillmentStatus, "FULFILLED");

    // NO FABRICATED TIMESTAMP — providerUpdatedAt is still exactly the
    // provider's own T, unchanged by the repair.
    assert.equal(repaired?.providerUpdatedAt?.toISOString(), ROOT_UPDATED_AT);
  });

  test("I. the refund child NEVER becomes its own canonical CommerceOrder", async () => {
    const store = new FakeStore();
    seedBrokenCanonicalOrder(store);
    await runBackfill(
      store,
      [providerRootOrder(), providerRefundOrder()],
      { [ROOT_ID]: providerRootOrder(), [REFUND_ID]: providerRefundOrder() },
    );
    assert.equal(store.find(REFUND_ID), null, "#1003 must never be persisted as a canonical order");
    assert.equal(store.orders.size, 1, "exactly one canonical order row must exist");
  });

  test("J. the original three line items remain authoritative — never replaced by the refund's negative line", async () => {
    const store = new FakeStore();
    const stored = seedBrokenCanonicalOrder(store);
    await runBackfill(
      store,
      [providerRootOrder(), providerRefundOrder()],
      { [ROOT_ID]: providerRootOrder(), [REFUND_ID]: providerRefundOrder() },
    );
    const lines = store.linesFor(stored.id);
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((l) => l.sku).sort(), ["2015C", "2016R", "2016RC"]);
    assert.ok(lines.every((l) => l.quantity > 0), "no negative refund line may be persisted");
  });

  test("G. a pre-existing OLD-interpretation SKIPPED_STALE event does NOT block the new semantic-version repair", async () => {
    const store = new FakeStore();
    seedBrokenCanonicalOrder(store);

    // Reproduce the terminal event the failed production run already wrote,
    // under the OLD (unversioned) id derivation.
    const crypto = await import("node:crypto");
    const oldId = `backfill:${crypto
      .createHash("sha256")
      .update(`${CONNECTION_ID}:${ROOT_ID}:${ROOT_UPDATED_AT}`, "utf8")
      .digest("hex")}`;
    store.events.set(oldId, "SKIPPED_STALE");

    await runBackfill(
      store,
      [providerRootOrder(), providerRefundOrder()],
      { [ROOT_ID]: providerRootOrder(), [REFUND_ID]: providerRefundOrder() },
    );

    // The historical row is untouched...
    assert.equal(store.events.get(oldId), "SKIPPED_STALE", "historical audit event must not be mutated");
    // ...and the repair still landed under a DIFFERENT, versioned id.
    assert.ok(
      store.claimedEventIds.some((id) => id !== oldId),
      "the repair must claim a new, semantically-versioned event id",
    );
    assert.equal(store.find(ROOT_ID)?.totalRefundedMinor, BigInt(3277));
  });

  test("K. the historical FAILED #1003 webhook event is never touched by the repair run", async () => {
    const store = new FakeStore();
    seedBrokenCanonicalOrder(store);

    // The real historical event: a WEBHOOK delivery for the refund child,
    // recorded FAILED/CONTRADICTORY_FINANCIAL_SNAPSHOT under the old
    // interpretation. Its id is a webhook body digest, structurally unrelated
    // to any backfill id, so a repair run cannot collide with or mutate it.
    const historicalWebhookEventId = "digest:historical-1003-failed-event";
    store.events.set(historicalWebhookEventId, "FAILED");

    await runBackfill(
      store,
      [providerRootOrder(), providerRefundOrder()],
      { [ROOT_ID]: providerRootOrder(), [REFUND_ID]: providerRefundOrder() },
    );

    assert.equal(
      store.events.get(historicalWebhookEventId),
      "FAILED",
      "the historical FAILED audit event must remain exactly as recorded",
    );
    assert.ok(
      !store.claimedEventIds.includes(historicalWebhookEventId),
      "the repair run must never claim the historical webhook event",
    );
    // ...and the repair still succeeded alongside it.
    assert.equal(store.find(ROOT_ID)?.totalRefundedMinor, BigInt(3277));
  });

  test("H. repeating the SAME repair run deduplicates — the versioned id is deterministic, never random or time-based", async () => {
    const store = new FakeStore();
    seedBrokenCanonicalOrder(store);

    const first = await runBackfill(
      store,
      [providerRootOrder(), providerRefundOrder()],
      { [ROOT_ID]: providerRootOrder(), [REFUND_ID]: providerRefundOrder() },
    );
    const idsAfterFirst = [...store.claimedEventIds];
    const repairedRefund = store.find(ROOT_ID)?.totalRefundedMinor;

    const second = await runBackfill(
      store,
      [providerRootOrder(), providerRefundOrder()],
      { [ROOT_ID]: providerRootOrder(), [REFUND_ID]: providerRefundOrder() },
    );

    // Identical derivation across runs.
    const newIds = store.claimedEventIds.slice(idsAfterFirst.length);
    assert.deepEqual(newIds, idsAfterFirst, "the same unchanged snapshot must derive the same event ids");

    // Second run is a no-op duplicate, and state is unchanged.
    assert.ok(
      second.outcomes.every((o) => o.status === "ALREADY_PROCESSED"),
      "a repeated identical run must deduplicate, never re-write",
    );
    assert.equal(store.find(ROOT_ID)?.totalRefundedMinor, repairedRefund);
    assert.equal(first.outcomes.length, second.outcomes.length);
  });

  test("F. an already-correct order replayed under a fresh event id stays idempotent (no harmful rewrite)", async () => {
    const store = new FakeStore();
    // Seed the ALREADY-REPAIRED state.
    store.seedOrder({
      externalOrderId: ROOT_ID,
      orderNumber: "1002",
      currencyCode: "CAD",
      minorUnitExponent: 2,
      totalMinor: BigInt(9831),
      totalRefundedMinor: BigInt(3277),
      netRevenueMinor: BigInt(6554),
      financialStatus: "PARTIALLY_REFUNDED",
      fulfillmentStatus: "FULFILLED",
      providerUpdatedAt: new Date(ROOT_UPDATED_AT),
    });

    const result = await runBackfill(
      store,
      [providerRootOrder(), providerRefundOrder()],
      { [ROOT_ID]: providerRootOrder(), [REFUND_ID]: providerRefundOrder() },
    );

    // Incoming refund (3277) is NOT strictly greater than stored (3277), so
    // the equal-version exception does not fire and this stays stale.
    const rootOutcome = result.outcomes.find((o) => o.orderId !== null);
    assert.equal(rootOutcome?.status, "SKIPPED_STALE");
    const row = store.find(ROOT_ID);
    assert.equal(row?.totalRefundedMinor, BigInt(3277));
    assert.equal(row?.financialStatus, "PARTIALLY_REFUNDED");
    assert.equal(row?.netRevenueMinor, BigInt(6554));
  });

  test("E. an equal-version reconciliation that would DECREASE the stored refund is refused", async () => {
    const store = new FakeStore();
    // Stored shows TWO refunds (5424); the provider root currently links only
    // one (3277) — incomplete evidence, not an un-refund.
    store.seedOrder({
      externalOrderId: ROOT_ID,
      orderNumber: "1002",
      currencyCode: "CAD",
      minorUnitExponent: 2,
      totalMinor: BigInt(9831),
      totalRefundedMinor: BigInt(5424),
      netRevenueMinor: BigInt(4407),
      financialStatus: "PARTIALLY_REFUNDED",
      fulfillmentStatus: "FULFILLED",
      providerUpdatedAt: new Date(ROOT_UPDATED_AT),
    });

    await runBackfill(
      store,
      [providerRootOrder(), providerRefundOrder()],
      { [ROOT_ID]: providerRootOrder(), [REFUND_ID]: providerRefundOrder() },
    );

    const row = store.find(ROOT_ID);
    assert.equal(row?.totalRefundedMinor, BigInt(5424), "a decrease must never be written");
    assert.equal(row?.netRevenueMinor, BigInt(4407));
  });

  test("B. an ordinary (non-refund) Commerce7 order at an equal timestamp remains SKIPPED_STALE", async () => {
    const store = new FakeStore();
    store.seedOrder({
      externalOrderId: ROOT_ID,
      orderNumber: "1002",
      currencyCode: "CAD",
      minorUnitExponent: 2,
      totalMinor: BigInt(9831),
      totalRefundedMinor: BigInt(0),
      netRevenueMinor: BigInt(9831),
      financialStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      providerUpdatedAt: new Date(ROOT_UPDATED_AT),
    });

    // Root WITHOUT any linked refund -> classified REGULAR, never authorized.
    const plainRoot = providerRootOrder({ linkedOrders: undefined });
    const result = await runBackfill(store, [plainRoot], { [ROOT_ID]: plainRoot });

    assert.ok(
      result.outcomes.every((o) => o.status === "SKIPPED_STALE"),
      "an ordinary equal-version Commerce7 order must remain stale",
    );
  });

  test("D. an OLDER provider timestamp is still stale even with authoritative refund reconciliation", async () => {
    const store = new FakeStore();
    // Stored is NEWER than the provider snapshot we are about to replay.
    store.seedOrder({
      externalOrderId: ROOT_ID,
      orderNumber: "1002",
      currencyCode: "CAD",
      minorUnitExponent: 2,
      totalMinor: BigInt(9831),
      totalRefundedMinor: BigInt(0),
      netRevenueMinor: BigInt(9831),
      financialStatus: "PAID",
      fulfillmentStatus: "FULFILLED",
      providerUpdatedAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    await runBackfill(
      store,
      [providerRootOrder(), providerRefundOrder()],
      { [ROOT_ID]: providerRootOrder(), [REFUND_ID]: providerRefundOrder() },
    );

    const row = store.find(ROOT_ID);
    assert.equal(row?.totalRefundedMinor, BigInt(0), "an older snapshot must never win, repair or not");
    assert.equal(row?.financialStatus, "PAID");
    assert.equal(row?.providerUpdatedAt?.toISOString(), "2026-09-01T00:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// The generic staleness contract itself, exercised directly.
// ---------------------------------------------------------------------------

describe("PHASE 27 — decideOrderStaleness repair contract stays narrow", () => {
  const T = new Date(ROOT_UPDATED_AT);
  const older = new Date(T.getTime() - 1000);
  const newer = new Date(T.getTime() + 1000);

  test("A. equal timestamp + authorized + strictly-greater refund -> REPAIR", () => {
    assert.equal(
      decideOrderStaleness(T, T, true, {
        authorized: true,
        incomingTotalRefundedMinor: BigInt(3277),
        storedTotalRefundedMinor: BigInt(0),
      }),
      "REPAIR",
    );
  });

  test("C. equal timestamp WITHOUT authorization (e.g. every Shopify delivery) -> STALE", () => {
    assert.equal(
      decideOrderStaleness(T, T, true, {
        authorized: false,
        incomingTotalRefundedMinor: BigInt(3277),
        storedTotalRefundedMinor: BigInt(0),
      }),
      "STALE",
    );
    // And with no repair context at all — the default for every caller that
    // has not opted in.
    assert.equal(decideOrderStaleness(T, T, true), "STALE");
  });

  test("D. an OLDER timestamp can never be repaired, even when authorized", () => {
    assert.equal(
      decideOrderStaleness(T, older, true, {
        authorized: true,
        incomingTotalRefundedMinor: BigInt(9999),
        storedTotalRefundedMinor: BigInt(0),
      }),
      "STALE",
    );
  });

  test("E. equal timestamp + authorized but a DECREASE -> STALE", () => {
    assert.equal(
      decideOrderStaleness(T, T, true, {
        authorized: true,
        incomingTotalRefundedMinor: BigInt(3277),
        storedTotalRefundedMinor: BigInt(5424),
      }),
      "STALE",
    );
  });

  test("F. equal timestamp + authorized + IDENTICAL refund -> STALE (idempotent replay)", () => {
    assert.equal(
      decideOrderStaleness(T, T, true, {
        authorized: true,
        incomingTotalRefundedMinor: BigInt(3277),
        storedTotalRefundedMinor: BigInt(3277),
      }),
      "STALE",
    );
  });

  test("an authorized repair asserting NO refund figure (null) -> STALE — never repairs on unrelated fields", () => {
    assert.equal(
      decideOrderStaleness(T, T, true, {
        authorized: true,
        incomingTotalRefundedMinor: null,
        storedTotalRefundedMinor: BigInt(0),
      }),
      "STALE",
    );
  });

  test("a strictly newer timestamp remains plain APPLY, never REPAIR", () => {
    assert.equal(
      decideOrderStaleness(T, newer, true, {
        authorized: true,
        incomingTotalRefundedMinor: BigInt(3277),
        storedTotalRefundedMinor: BigInt(0),
      }),
      "APPLY",
    );
  });

  test("the semantics version is a stable constant, not a timestamp or random value", () => {
    assert.equal(typeof COMMERCE7_REFUND_RECONCILIATION_SEMANTICS_VERSION, "string");
    assert.match(COMMERCE7_REFUND_RECONCILIATION_SEMANTICS_VERSION, /^[a-z0-9-]+$/);
    assert.doesNotMatch(COMMERCE7_REFUND_RECONCILIATION_SEMANTICS_VERSION, /\d{4}-\d{2}-\d{2}|\d{10}/);
  });
});
