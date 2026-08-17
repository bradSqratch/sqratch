process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/order-ingestion.test.ts
 *
 * Unit tests for the provider-neutral order persistence service
 * (`src/lib/commerce/order-ingestion.ts`). Every dependency (`claimEvent`,
 * `loadConnection`, `expandProductKeyCandidates`, `runTransaction`,
 * `hashAttributionToken`, `now`) is injected and backed by an in-memory
 * `FakeOrderStore` — no real DB, no real network anywhere in this file. `finalizeEvent` inside `order-ingestion.ts`
 * is NOT dependency-injected (it always dynamically imports the real
 * `@/lib/prisma` singleton and swallows any error) — see the "genuine
 * observation" describe block near the bottom, which documents this rather
 * than routing around it. Because `DATABASE_URL` is pinned to an unreachable
 * host above, every one of those best-effort writes fails fast and is
 * silently caught, exactly as `order-ingestion.ts`'s own header comment says
 * it will in a crash-between-claim-and-commit scenario.
 *
 * Covered cases (numbered to match the task's review checklist):
 *  1.  Order create idempotency — duplicate (provider, providerEventId) creates ONE order.
 *  P1. The four-outcome event-claim state machine — CLAIMED / RECLAIMED /
 *      COMPLETED_DUPLICATE / IN_FLIGHT — including THE CRASH WINDOW: a worker
 *      that dies after claiming and before writing must NOT have its provider
 *      retry answered as a duplicate, or that order is lost forever.
 *  10. The full attribution-claim rejection matrix.
 *  11. Provider neutrality: no Shopify id format in the generic layer's code.
 *  3.  Order update — newer providerUpdatedAt updates the existing row.
 *  4.  Older update is rejected (SKIPPED_STALE), stored row unchanged.
 *  5.  Multiple line items — 3+ items produce 3+ line-item rows.
 *  7.  Unknown product allowed as unresolved external line (connectedProductId: null).
 *  17. computeNetRevenueMinor is deterministic and null-safe.
 *  18. Cross-brand: brandId is always read from the connection, never the caller.
 *  19. Two connections may share an externalOrderId as independent rows.
 *  22. Attribution: a valid, unexpired, unconsumed token links and consumes the click.
 *  23. Attribution: no token anywhere -> unattributed.
 *  24. Attribution: unknown / expired / already-consumed-by-another-order token -> unattributed.
 *  25. Click alone never proves an order (source inspection).
 *  26-28. No points / reward / commission mutation anywhere in the Phase 7 surface (grep).
 *  30. No secrets serialized on the FAILED path.
 *  31. This file pins DATABASE_URL on line 1, before any import.
 *
 * Plus direct coverage of the exported pure helpers
 * (`isIngestibleConnectionStatus`, `decideOrderStaleness`,
 * `providerProductKeyCandidates`) and the connection-gating / missing-id /
 * unorderable branches that the checklist assumes are exercised.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CommerceProvider, Prisma } from "@prisma/client";
import type {
  CommerceConnectionStatus,
  CommerceOrderEventStatus,
  CommerceOrderFinancialStatus,
} from "@prisma/client";

import {
  ingestNormalizedOrder,
  isIngestibleConnectionStatus,
  isRetryableOrderIngestionOutcome,
  decideOrderStaleness,
  decideOrderEventClaim,
  resolveOrderEventClaim,
  computeNetRevenueMinor,
  providerProductKeyCandidates,
  EVENT_CLAIM_LEASE_MS,
  type ExistingOrderEventRow,
  type NormalizedOrderInput,
  type NormalizedOrderLineItemInput,
  type OrderEventClaim,
  type OrderEventClaimStore,
  type OrderIngestionEventInput,
  type OrderIngestionConnection,
  type OrderIngestionDeps,
  type OrderIngestionOutcome,
} from "../src/lib/commerce/order-ingestion";

const FIXED_NOW = new Date("2026-08-07T12:00:00.000Z");

// ---------------------------------------------------------------------------
// In-memory CommerceOrderEvent ledger
// ---------------------------------------------------------------------------

type FakeEventRow = {
  id: string;
  status: CommerceOrderEventStatus;
  receivedAt: Date;
  processedAt: Date | null;
  failureSummary: string | null;
};

/**
 * A realistic stand-in for the `CommerceOrderEvent` idempotency ledger: it
 * tracks a real `status` and `receivedAt` per row and enforces the same unique
 * `(provider, providerEventId)` the database does.
 *
 * It deliberately does NOT re-implement the claim state machine. It supplies
 * only the three row operations of `OrderEventClaimStore` and hands them to the
 * PRODUCTION `resolveOrderEventClaim`, so every test below exercises the real
 * classification, the real lease arithmetic, and the real compare-and-set. A
 * fake that reimplemented that logic would only ever be testing itself — which
 * is exactly why the previous `Set`-membership double could not detect the
 * in-flight/duplicate confusion this ledger exists to prove is fixed.
 *
 * `clock` is the wall clock the claim machine reads (production hands it
 * `new Date()`), so lease expiry is testable without waiting a minute.
 */
class FakeEventTable {
  nextId = 1;
  clock: Date = FIXED_NOW;
  rows = new Map<string, FakeEventRow>();

  static key(provider: CommerceProvider, providerEventId: string): string {
    return `${provider}:${providerEventId}`;
  }

  row(provider: CommerceProvider, providerEventId: string): FakeEventRow | undefined {
    return this.rows.get(FakeEventTable.key(provider, providerEventId));
  }

  /** Pre-existing row, as if written by an earlier delivery. */
  seed(
    provider: CommerceProvider,
    providerEventId: string,
    row: Partial<FakeEventRow> & { status: CommerceOrderEventStatus },
  ): FakeEventRow {
    const complete: FakeEventRow = {
      id: `event-${this.nextId++}`,
      receivedAt: this.clock,
      processedAt: null,
      failureSummary: null,
      ...row,
    };
    this.rows.set(FakeEventTable.key(provider, providerEventId), complete);
    return complete;
  }

  /**
   * Simulates the terminal write `finalizeEvent` performs in production.
   *
   * It cannot happen on its own here: `finalizeEvent` is NOT dependency
   * injected, always imports the real prisma singleton, and swallows its own
   * failure — so under this file's unreachable `DATABASE_URL` every row stays
   * `RECEIVED` forever. That is exactly the crash/lost-finalize state the
   * lease exists for, so it is the DEFAULT here and reaching a terminal status
   * is the thing a test must ask for explicitly.
   */
  finalize(
    provider: CommerceProvider,
    providerEventId: string,
    status: CommerceOrderEventStatus,
  ): void {
    const row = this.row(provider, providerEventId);
    if (!row) throw new Error(`no event row for ${providerEventId}`);
    row.status = status;
    row.processedAt = this.clock;
  }

  storeFor(provider: CommerceProvider, providerEventId: string): OrderEventClaimStore {
    const key = FakeEventTable.key(provider, providerEventId);
    return {
      insertClaim: async () => {
        if (this.rows.has(key)) {
          return "DUPLICATE";
        }
        const row: FakeEventRow = {
          id: `event-${this.nextId++}`,
          status: "RECEIVED",
          receivedAt: this.clock,
          processedAt: null,
          failureSummary: null,
        };
        this.rows.set(key, row);
        return { id: row.id };
      },
      findExistingClaim: async () => {
        const row = this.rows.get(key);
        return row
          ? { id: row.id, status: row.status, receivedAt: row.receivedAt }
          : null;
      },
      reclaim: async (row: ExistingOrderEventRow, now: Date) => {
        const current = this.rows.get(key);
        // The same compare-and-set predicate the Prisma implementation uses:
        // id AND status AND receivedAt must all still match the read.
        if (
          !current ||
          current.id !== row.id ||
          current.status !== row.status ||
          current.receivedAt.getTime() !== row.receivedAt.getTime()
        ) {
          return false;
        }
        current.status = "RECEIVED";
        current.receivedAt = now;
        current.processedAt = null;
        current.failureSummary = null;
        return true;
      },
    };
  }

  claim(input: {
    provider: CommerceProvider;
    providerEventId: string;
  }): Promise<OrderEventClaim> {
    return resolveOrderEventClaim(
      this.storeFor(input.provider, input.providerEventId),
      this.clock,
    );
  }
}

// ---------------------------------------------------------------------------
// In-memory fake store
// ---------------------------------------------------------------------------

type OrderRow = {
  id: string;
  connectionId: string;
  brandId: string;
  provider: CommerceProvider;
  externalOrderId: string | null;
  orderNumber: string | null;
  currencyCode: string | null;
  minorUnitExponent: number | null;
  subtotalMinor: bigint | null;
  discountsMinor: bigint | null;
  shippingMinor: bigint | null;
  taxMinor: bigint | null;
  totalMinor: bigint | null;
  totalRefundedMinor: bigint;
  netRevenueMinor: bigint | null;
  financialStatus: CommerceOrderFinancialStatus | null;
  fulfillmentStatus: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
  attributionId: string | null;
};

type LineItemRow = {
  id: string;
  orderId: string;
  externalLineItemId: string | null;
  externalProductId: string | null;
  externalVariantId: string | null;
  connectedProductId: string | null;
  title: string | null;
  sku: string | null;
  quantity: number;
  unitPriceMinor: bigint | null;
  discountMinor: bigint | null;
  taxMinor: bigint | null;
  totalMinor: bigint | null;
};

type AttributionRow = {
  id: string;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
  consumedByOrderRef: string | null;
  attributedBrandId: string | null;
  commerceConnectionId: string | null;
  provider: CommerceProvider | null;
  redirectedAt: Date | null;
};

class FakeOrderStore {
  nextId = 1;
  orders = new Map<string, OrderRow>();
  ordersByKey = new Map<string, string>(); // `${connectionId}:${externalOrderId}` -> orderId
  lineItems = new Map<string, LineItemRow[]>();
  connectedProducts: Array<{ id: string; connectionId: string; externalKey: string }> = [];
  attributions = new Map<string, AttributionRow>();
  attributionsByHash = new Map<string, string>();
  connections = new Map<string, OrderIngestionConnection>();
  events = new FakeEventTable();

  /**
   * Fires immediately AFTER `commerceOrder.findUnique` has copied the stored
   * row, and before the caller can act on it. That is exactly the READ
   * COMMITTED window a concurrent delivery for the same order commits in, so
   * a test can stage one without needing real concurrency.
   */
  onOrderRead: (() => void) | null = null;

  seedConnection(conn: OrderIngestionConnection): void {
    this.connections.set(conn.id, conn);
  }

  seedAttribution(row: Omit<AttributionRow, "attributedBrandId" | "commerceConnectionId" | "provider" | "redirectedAt"> & Partial<Pick<AttributionRow, "attributedBrandId" | "commerceConnectionId" | "provider" | "redirectedAt">>): void {
    const complete: AttributionRow = {
      attributedBrandId: "brand-1",
      commerceConnectionId: "conn-1",
      provider: CommerceProvider.SHOPIFY,
      redirectedAt: FIXED_NOW,
      ...row,
    };
    this.attributions.set(complete.id, complete);
    this.attributionsByHash.set(complete.tokenHash, complete.id);
  }

  seedConnectedProduct(connectionId: string, externalKey: string): string {
    const id = `catalog-${this.nextId++}`;
    this.connectedProducts.push({ id, connectionId, externalKey });
    return id;
  }

  /**
   * A minimal, hand-written fake conforming structurally to exactly the
   * methods `order-ingestion.ts` calls on its `TxClient` (verified by
   * reading the source: `commerceOrder.{findUnique,create,update,updateMany}`,
   * `commerceOrderLineItem.{deleteMany,createMany}`,
   * `connectedCommerceProduct.findMany`,
   * `commerceClickAttribution.{findUnique,updateMany}`). `Prisma.TransactionClient`
   * is a huge generated interface with no exported minimal subset, so a
   * single `as unknown as` cast (never `any`) is the only way to hand this
   * object to `runTransaction`'s injected callback.
   */
  tx(): Prisma.TransactionClient {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- captured for the closures below, which run outside this method's `this` binding.
    const store = this;
    const fake = {
      commerceOrder: {
        async findUnique({
          where,
        }: {
          where: { connectionId_externalOrderId: { connectionId: string; externalOrderId: string } };
        }) {
          const key = `${where.connectionId_externalOrderId.connectionId}:${where.connectionId_externalOrderId.externalOrderId}`;
          const id = store.ordersByKey.get(key);
          const snapshot = id ? { ...store.orders.get(id)! } : null;
          store.onOrderRead?.();
          return snapshot;
        },
        async create({
          data,
        }: {
          data: Omit<OrderRow, "id" | "attributionId"> & { attributionId?: string | null };
        }) {
          const id = `order-${store.nextId++}`;
          const row: OrderRow = { id, attributionId: null, ...data };
          store.orders.set(id, row);
          store.ordersByKey.set(`${row.connectionId}:${row.externalOrderId}`, id);
          return { id };
        },
        async update({ where, data }: { where: { id: string }; data: Partial<OrderRow> }) {
          const existing = store.orders.get(where.id);
          if (!existing) throw new Error(`unknown order ${where.id}`);
          Object.assign(existing, data);
          return { ...existing };
        },
        /**
         * The optimistic-concurrency guard on the order write. Mirrors what
         * Postgres does for `UPDATE ... WHERE id = $1 AND "providerUpdatedAt"
         * IS NOT DISTINCT FROM $2`: the predicate is re-evaluated against the
         * CURRENT row, so a writer whose read is already outdated matches
         * nothing and gets `count: 0`.
         */
        async updateMany({
          where,
          data,
        }: {
          where: { id: string; providerUpdatedAt: Date | null };
          data: Partial<OrderRow>;
        }) {
          const existing = store.orders.get(where.id);
          if (!existing) return { count: 0 };
          const stored = existing.providerUpdatedAt?.getTime() ?? null;
          const expected = where.providerUpdatedAt?.getTime() ?? null;
          if (stored !== expected) return { count: 0 };
          Object.assign(existing, data);
          return { count: 1 };
        },
      },
      commerceOrderLineItem: {
        async deleteMany({ where }: { where: { orderId: string } }) {
          const existing = store.lineItems.get(where.orderId) ?? [];
          store.lineItems.set(where.orderId, []);
          return { count: existing.length };
        },
        async createMany({
          data,
        }: {
          data: Array<Omit<LineItemRow, "id">>;
        }) {
          const rows = data.map((item) => ({ id: `line-${store.nextId++}`, ...item }));
          const orderId = rows[0]?.orderId;
          if (orderId) {
            const existing = store.lineItems.get(orderId) ?? [];
            store.lineItems.set(orderId, [...existing, ...rows]);
          }
          return { count: rows.length };
        },
      },
      connectedCommerceProduct: {
        async findMany({
          where,
        }: {
          where: { connectionId: string; externalKey: { in: string[] } };
        }) {
          return store.connectedProducts.filter(
            (row) =>
              row.connectionId === where.connectionId &&
              where.externalKey.in.includes(row.externalKey),
          );
        },
      },
      commerceClickAttribution: {
        async findUnique({ where }: { where: { tokenHash: string } }) {
          const id = store.attributionsByHash.get(where.tokenHash);
          return id ? { ...store.attributions.get(id)! } : null;
        },
        async updateMany({
          where,
          data,
        }: {
          where: { id: string; consumedAt: null };
          data: { consumedAt: Date; consumedByOrderRef: string };
        }) {
          const row = store.attributions.get(where.id);
          if (!row || row.consumedAt !== null) {
            return { count: 0 };
          }
          row.consumedAt = data.consumedAt;
          row.consumedByOrderRef = data.consumedByOrderRef;
          return { count: 1 };
        },
      },
    };
    return fake as unknown as Prisma.TransactionClient;
  }
}

// ---------------------------------------------------------------------------
// Deps / fixture builders
// ---------------------------------------------------------------------------

function makeDeps(
  store: FakeOrderStore,
  overrides: Partial<OrderIngestionDeps> = {},
): Partial<OrderIngestionDeps> {
  return {
    async claimEvent(input) {
      return store.events.claim(input);
    },
    async loadConnection(connectionId) {
      return store.connections.get(connectionId) ?? null;
    },
    async runTransaction(fn) {
      return fn(store.tx());
    },
    hashAttributionToken(token: string): string {
      if (token === "MALFORMED-TOKEN") {
        throw new Error("Click token must be 43 base64url characters");
      }
      return `hash:${token}`;
    },
    now: () => FIXED_NOW,
    ...overrides,
  };
}

function makeConnection(overrides: Partial<OrderIngestionConnection> = {}): OrderIngestionConnection {
  return {
    id: "conn-1",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED" as CommerceConnectionStatus,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<OrderIngestionEventInput> = {}): OrderIngestionEventInput {
  return {
    providerEventId: "webhook-1",
    topic: "orders/create",
    payloadDigest: "digest-abc",
    connectionId: "conn-1",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    ...overrides,
  };
}

function makeLineItem(overrides: Partial<NormalizedOrderLineItemInput> = {}): NormalizedOrderLineItemInput {
  return {
    externalLineItemId: "li-1",
    externalProductId: "1001",
    externalVariantId: "2001",
    title: "Test Product",
    sku: "SKU-1",
    quantity: 1,
    unitPriceMinor: BigInt(1999),
    discountMinor: null,
    taxMinor: null,
    totalMinor: BigInt(1999),
    ...overrides,
  };
}

function makeOrder(overrides: Partial<NormalizedOrderInput> = {}): NormalizedOrderInput {
  return {
    connectionId: "conn-1",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    completeness: "FULL",
    externalOrderId: "ext-order-1",
    orderNumber: "#1001",
    currencyCode: "USD",
    minorUnitExponent: 2,
    subtotalMinor: BigInt(1999),
    discountsMinor: null,
    shippingMinor: null,
    taxMinor: null,
    totalMinor: BigInt(1999),
    totalRefundedMinor: null,
    financialStatus: "PAID",
    fulfillmentStatus: "UNFULFILLED",
    cancelledAt: null,
    cancelReason: null,
    providerCreatedAt: new Date("2026-08-01T00:00:00.000Z"),
    providerUpdatedAt: new Date("2026-08-01T00:00:00.000Z"),
    lineItems: [makeLineItem()],
    attributionToken: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Order create idempotency
// ---------------------------------------------------------------------------

describe("1. order create idempotency", () => {
  test("the same (provider, providerEventId) delivered twice creates ONE order; once the first delivery has been finalized the second is ALREADY_PROCESSED", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const first = await ingestNormalizedOrder(makeEvent(), makeOrder(), deps);
    assert.equal(first.status, "CREATED");
    assert.ok(first.orderId);

    // In production `finalizeEvent` flips the row to PROCESSED here. It cannot
    // run in this file (not injectable, unreachable DATABASE_URL), so the
    // terminal write is simulated explicitly — see FakeEventTable.finalize.
    store.events.finalize(CommerceProvider.SHOPIFY, "webhook-1", "PROCESSED");

    const second = await ingestNormalizedOrder(makeEvent(), makeOrder(), deps);
    assert.equal(second.status, "ALREADY_PROCESSED");
    assert.equal(second.reason, "DUPLICATE_DELIVERY");
    assert.equal(second.orderId, null);
    assert.equal(
      isRetryableOrderIngestionOutcome(second),
      false,
      "a genuinely completed duplicate must NOT ask the provider to retry",
    );

    assert.equal(store.orders.size, 1);
  });
});

// ---------------------------------------------------------------------------
// P1. The event-claim state machine: CLAIMED / RECLAIMED /
//     COMPLETED_DUPLICATE / IN_FLIGHT
//
// The bug these tests exist for: every lost INSERT used to be reported
// ALREADY_PROCESSED, so a delivery still being processed (or abandoned by a
// crashed worker) was answered 200 and the provider stopped retrying. If the
// order write had not happened yet, that order was lost permanently.
// ---------------------------------------------------------------------------

const SHOPIFY = CommerceProvider.SHOPIFY;

describe("P1a. decideOrderEventClaim classifies every CommerceOrderEventStatus", () => {
  const fresh = FIXED_NOW;
  const withinLease = new Date(FIXED_NOW.getTime() + EVENT_CLAIM_LEASE_MS - 1);
  const pastLease = new Date(FIXED_NOW.getTime() + EVENT_CLAIM_LEASE_MS + 1);

  test("RECEIVED inside the lease is IN_FLIGHT — never a completed duplicate", () => {
    assert.equal(decideOrderEventClaim("RECEIVED", fresh, fresh), "IN_FLIGHT");
    assert.equal(decideOrderEventClaim("RECEIVED", fresh, withinLease), "IN_FLIGHT");
  });

  test("RECEIVED exactly AT the lease boundary is still IN_FLIGHT (strictly greater expires it)", () => {
    const atBoundary = new Date(FIXED_NOW.getTime() + EVENT_CLAIM_LEASE_MS);
    assert.equal(decideOrderEventClaim("RECEIVED", fresh, atBoundary), "IN_FLIGHT");
  });

  test("RECEIVED past the lease is RECLAIMABLE", () => {
    assert.equal(decideOrderEventClaim("RECEIVED", fresh, pastLease), "RECLAIMABLE");
  });

  test("FAILED is RECLAIMABLE immediately, regardless of age", () => {
    assert.equal(decideOrderEventClaim("FAILED", fresh, fresh), "RECLAIMABLE");
    assert.equal(decideOrderEventClaim("FAILED", fresh, pastLease), "RECLAIMABLE");
  });

  test("every TERMINAL status is a COMPLETED_DUPLICATE, at any age", () => {
    for (const status of ["PROCESSED", "SKIPPED_STALE", "SKIPPED_DISCONNECTED"] as const) {
      assert.equal(decideOrderEventClaim(status, fresh, fresh), "COMPLETED_DUPLICATE", status);
      assert.equal(decideOrderEventClaim(status, fresh, pastLease), "COMPLETED_DUPLICATE", status);
    }
  });

  test("the classification covers all five enum members with no default fallthrough", () => {
    const all: CommerceOrderEventStatus[] = [
      "RECEIVED",
      "PROCESSED",
      "SKIPPED_STALE",
      "SKIPPED_DISCONNECTED",
      "FAILED",
    ];
    for (const status of all) {
      const decision = decideOrderEventClaim(status, fresh, pastLease);
      assert.ok(
        ["RECLAIMABLE", "COMPLETED_DUPLICATE", "IN_FLIGHT"].includes(decision),
        `${status} produced ${decision}`,
      );
    }
  });
});

describe("P1b. resolveOrderEventClaim: insert, takeover, and the compare-and-set", () => {
  test("an unseen delivery is CLAIMED", async () => {
    const events = new FakeEventTable();
    const claim = await events.claim({ provider: SHOPIFY, providerEventId: "wh-new" });
    assert.equal(claim.status, "CLAIMED");
    assert.ok(claim.eventId);
  });

  test("a row that vanishes between the lost INSERT and the read fails CLOSED to IN_FLIGHT, never to a duplicate", async () => {
    const store: OrderEventClaimStore = {
      async insertClaim() {
        return "DUPLICATE";
      },
      async findExistingClaim() {
        return null;
      },
      async reclaim() {
        throw new Error("must not be reached");
      },
    };
    const claim = await resolveOrderEventClaim(store, FIXED_NOW);
    assert.equal(claim.status, "IN_FLIGHT");
    assert.equal(claim.eventId, null);
  });

  test("losing the compare-and-set to a concurrent reclaimer yields IN_FLIGHT, not a duplicate", async () => {
    const store: OrderEventClaimStore = {
      async insertClaim() {
        return "DUPLICATE";
      },
      async findExistingClaim() {
        // Stale RECEIVED: reclaimable on paper.
        return { id: "event-x", status: "RECEIVED", receivedAt: FIXED_NOW };
      },
      async reclaim() {
        return false; // somebody else got there first
      },
    };
    const claim = await resolveOrderEventClaim(
      store,
      new Date(FIXED_NOW.getTime() + EVENT_CLAIM_LEASE_MS + 1),
    );
    assert.equal(claim.status, "IN_FLIGHT");
    assert.equal(claim.eventId, "event-x");
  });

  test("two workers that both read the same STALE row: exactly one RECLAIMS it, the other is told IN_FLIGHT", async () => {
    const events = new FakeEventTable();
    events.seed(SHOPIFY, "wh-stale", { status: "RECEIVED", receivedAt: FIXED_NOW });
    events.clock = new Date(FIXED_NOW.getTime() + EVENT_CLAIM_LEASE_MS + 1_000);

    const [a, b] = await Promise.all([
      events.claim({ provider: SHOPIFY, providerEventId: "wh-stale" }),
      events.claim({ provider: SHOPIFY, providerEventId: "wh-stale" }),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(
      statuses,
      ["IN_FLIGHT", "RECLAIMED"],
      "the receivedAt-aware CAS must elect exactly one winner",
    );
  });

  test("reclaiming RESETS receivedAt, so the lease restarts for the reclaiming attempt", async () => {
    const events = new FakeEventTable();
    events.seed(SHOPIFY, "wh-stale", { status: "FAILED", receivedAt: FIXED_NOW });
    const reclaimAt = new Date(FIXED_NOW.getTime() + 5 * 60_000);
    events.clock = reclaimAt;

    const claim = await events.claim({ provider: SHOPIFY, providerEventId: "wh-stale" });
    assert.equal(claim.status, "RECLAIMED");

    const row = events.row(SHOPIFY, "wh-stale")!;
    assert.equal(row.receivedAt.getTime(), reclaimAt.getTime());
    assert.equal(row.status, "RECEIVED");
    assert.equal(row.processedAt, null);
    assert.equal(row.failureSummary, null);

    // And the restarted lease is now LIVE: an immediate retry must not reclaim
    // it again. Before the reset, `receivedAt` kept its original value forever
    // and every subsequent retry re-read the row as stale.
    const immediateRetry = await events.claim({
      provider: SHOPIFY,
      providerEventId: "wh-stale",
    });
    assert.equal(immediateRetry.status, "IN_FLIGHT");
  });
});

describe("P1c. THE CRASH WINDOW: a worker dies after claiming and before writing the order", () => {
  test("the retry inside the lease is IN_FLIGHT (retryable), NOT ALREADY_PROCESSED — and the order is still landed once the lease expires", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    // 1. Delivery #1 wins the claim... and the process dies right there. No
    //    order write, no finalize: the ledger holds a RECEIVED row and nothing
    //    else, which is exactly what a crashed worker leaves behind.
    const claim = await store.events.claim({ provider: SHOPIFY, providerEventId: "webhook-1" });
    assert.equal(claim.status, "CLAIMED");
    assert.equal(store.orders.size, 0, "the crashed worker never wrote an order");

    // 2. Shopify redelivers 5s later — inside the 60s lease.
    store.events.clock = new Date(FIXED_NOW.getTime() + 5_000);
    const retry = await ingestNormalizedOrder(makeEvent(), makeOrder(), deps);

    assert.notEqual(
      retry.status,
      "ALREADY_PROCESSED",
      "THE BUG: this delivery was never processed by anyone, so calling it a duplicate loses the order",
    );
    assert.equal(retry.status, "IN_FLIGHT");
    assert.equal(retry.reason, "DELIVERY_IN_FLIGHT");
    assert.equal(
      isRetryableOrderIngestionOutcome(retry),
      true,
      "the caller must answer 500 so Shopify keeps retrying",
    );
    assert.equal(store.orders.size, 0, "and no second order was written either");

    // 3. Shopify retries again after the lease expires: now the abandoned claim
    //    is taken over and the order is finally landed for real.
    store.events.clock = new Date(FIXED_NOW.getTime() + EVENT_CLAIM_LEASE_MS + 1_000);
    const recovered = await ingestNormalizedOrder(makeEvent(), makeOrder(), deps);
    assert.equal(recovered.status, "CREATED");
    assert.equal(store.orders.size, 1, "the order is recovered, not lost");
    assert.equal(isRetryableOrderIngestionOutcome(recovered), false);
  });

  test("the same holds when the worker dies mid-transaction: the WRITE_FAILED attempt leaves a live lease, and the in-lease retry is IN_FLIGHT", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());

    // Attempt #1 claims, then its order transaction blows up. Its own
    // finalizeEvent(FAILED) write cannot reach the blocked DB, so the row stays
    // RECEIVED — the realistic "we don't know what happened" state.
    const failing = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder(),
      makeDeps(store, {
        async runTransaction() {
          throw new Error("connection terminated unexpectedly");
        },
      }),
    );
    assert.equal(failing.status, "FAILED");
    assert.equal(failing.reason, "WRITE_FAILED");
    assert.equal(isRetryableOrderIngestionOutcome(failing), true);

    store.events.clock = new Date(FIXED_NOW.getTime() + 1_000);
    const retry = await ingestNormalizedOrder(makeEvent(), makeOrder(), makeDeps(store));
    assert.equal(retry.status, "IN_FLIGHT");
    assert.equal(store.orders.size, 0);
  });

  test("a FAILED row (its finalize DID land) is reclaimed immediately, without waiting out the lease", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    store.events.seed(SHOPIFY, "webhook-1", {
      status: "FAILED",
      receivedAt: FIXED_NOW,
      failureSummary: "WRITE_FAILED",
    });

    const retry = await ingestNormalizedOrder(makeEvent(), makeOrder(), makeDeps(store));
    assert.equal(retry.status, "CREATED", "an explicitly failed attempt is safe to redo at once");
    assert.equal(store.orders.size, 1);
  });
});

describe("P1d. terminal statuses are genuine duplicates and are never reprocessed", () => {
  for (const status of ["PROCESSED", "SKIPPED_STALE", "SKIPPED_DISCONNECTED"] as const) {
    test(`a ${status} row -> ALREADY_PROCESSED / DUPLICATE_DELIVERY, no order write, not retryable`, async () => {
      const store = new FakeOrderStore();
      store.seedConnection(makeConnection());
      const seeded = store.events.seed(SHOPIFY, "webhook-1", {
        status,
        receivedAt: FIXED_NOW,
      });

      const outcome = await ingestNormalizedOrder(makeEvent(), makeOrder(), makeDeps(store));

      assert.equal(outcome.status, "ALREADY_PROCESSED");
      assert.equal(outcome.reason, "DUPLICATE_DELIVERY");
      assert.equal(outcome.eventId, seeded.id, "the existing row is surfaced for correlation");
      assert.equal(store.orders.size, 0, "a settled delivery must never be reprocessed");
      assert.equal(isRetryableOrderIngestionOutcome(outcome), false);
      assert.equal(store.events.row(SHOPIFY, "webhook-1")!.status, status, "and is left untouched");
    });
  }
});

describe("P1e. unexpected throws become deliberate, retryable outcomes — never unhandled exceptions", () => {
  test("claimEvent throwing yields FAILED / UNEXPECTED_FAILURE, not a rejected promise", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder(),
      makeDeps(store, {
        async claimEvent() {
          throw new Error("P1001: can't reach database server at db:5432");
        },
      }),
    );

    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.reason, "UNEXPECTED_FAILURE");
    assert.equal(isRetryableOrderIngestionOutcome(outcome), true);
    assert.equal(store.orders.size, 0);
  });

  test("loadConnection throwing does the same, and the delivery keeps its live lease for the retry", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder(),
      makeDeps(store, {
        async loadConnection() {
          throw new Error("P1017: server has closed the connection");
        },
      }),
    );

    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.reason, "UNEXPECTED_FAILURE");
    assert.equal(isRetryableOrderIngestionOutcome(outcome), true);
    assert.equal(store.events.row(SHOPIFY, "webhook-1")!.status, "RECEIVED");
  });

  test("the classified outcome never carries the thrown error's text", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const secret = "leaky-column-value-4b21";

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder(),
      makeDeps(store, {
        async claimEvent() {
          throw new Error(`unique constraint, Detail: (${secret}) already exists.`);
        },
      }),
    );

    assert.doesNotMatch(JSON.stringify(outcome), new RegExp(secret));
  });
});

describe("P1f. isRetryableOrderIngestionOutcome is the single source of truth for 500-vs-200", () => {
  const cases: Array<[Pick<OrderIngestionOutcome, "status" | "reason">, boolean]> = [
    [{ status: "CREATED", reason: null }, false],
    [{ status: "UPDATED", reason: null }, false],
    [{ status: "ALREADY_PROCESSED", reason: "DUPLICATE_DELIVERY" }, false],
    [{ status: "SKIPPED_STALE", reason: "OLDER_THAN_STORED_STATE" }, false],
    [{ status: "SKIPPED_STALE", reason: "UNORDERABLE_MISSING_TIMESTAMP" }, false],
    [{ status: "SKIPPED_DISCONNECTED", reason: "CONNECTION_NOT_FOUND" }, false],
    [{ status: "SKIPPED_DISCONNECTED", reason: "CONNECTION_NOT_INGESTIBLE" }, false],
    [{ status: "FAILED", reason: "MISSING_EXTERNAL_ORDER_ID" }, false],
    [{ status: "IN_FLIGHT", reason: "DELIVERY_IN_FLIGHT" }, true],
    [{ status: "FAILED", reason: "WRITE_FAILED" }, true],
    [{ status: "FAILED", reason: "UNEXPECTED_FAILURE" }, true],
  ];

  for (const [outcome, retryable] of cases) {
    test(`${outcome.status} / ${outcome.reason} -> ${retryable ? "retry (500)" : "settled (200)"}`, () => {
      assert.equal(isRetryableOrderIngestionOutcome(outcome), retryable);
    });
  }
});

// ---------------------------------------------------------------------------
// 3 & 4. Update / staleness
// ---------------------------------------------------------------------------

describe("3 & 4. order update and staleness protection", () => {
  test("3. a second event for the same externalOrderId with a NEWER providerUpdatedAt updates the existing row, not a new one", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const first = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-1" }),
      makeOrder({ providerUpdatedAt: new Date("2026-08-01T00:00:00.000Z"), financialStatus: "PENDING" }),
      deps,
    );
    assert.equal(first.status, "CREATED");

    const second = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-2" }),
      makeOrder({ providerUpdatedAt: new Date("2026-08-02T00:00:00.000Z"), financialStatus: "PAID" }),
      deps,
    );
    assert.equal(second.status, "UPDATED");
    assert.equal(second.orderId, first.orderId);
    assert.equal(store.orders.size, 1);
    assert.equal(store.orders.get(first.orderId!)!.financialStatus, "PAID");
  });

  test("4. an OLDER providerUpdatedAt is rejected (SKIPPED_STALE) and the stored row is unchanged", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const first = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-1" }),
      makeOrder({ providerUpdatedAt: new Date("2026-08-05T00:00:00.000Z"), financialStatus: "PAID", orderNumber: "#KEEP" }),
      deps,
    );
    assert.equal(first.status, "CREATED");
    const storedBefore = { ...store.orders.get(first.orderId!)! };

    const stale = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-2" }),
      makeOrder({
        providerUpdatedAt: new Date("2026-08-01T00:00:00.000Z"),
        financialStatus: "PENDING",
        orderNumber: "#SHOULD-NOT-LAND",
      }),
      deps,
    );
    assert.equal(stale.status, "SKIPPED_STALE");
    assert.equal(stale.reason, "OLDER_THAN_STORED_STATE");
    assert.equal(stale.orderId, first.orderId);

    const storedAfter = store.orders.get(first.orderId!)!;
    assert.deepEqual(storedAfter, storedBefore);
  });

  test("an equal providerUpdatedAt is ALSO stale (must be strictly newer, per decideOrderStaleness)", () => {
    const t = new Date("2026-08-01T00:00:00.000Z");
    assert.equal(decideOrderStaleness(t, t, true), "STALE");
  });

  test("no incoming timestamp against a stored timestamp is UNORDERABLE, not APPLY", () => {
    const stored = new Date("2026-08-01T00:00:00.000Z");
    assert.equal(decideOrderStaleness(stored, null, true), "UNORDERABLE");
  });

  test("a brand-new external order id is FIRST_SEEN regardless of its timestamp", () => {
    assert.equal(decideOrderStaleness(undefined, null, false), "FIRST_SEEN");
  });

  test("a stored row with no stored timestamp APPLIES anything", () => {
    assert.equal(decideOrderStaleness(null, null, true), "APPLY");
    assert.equal(
      decideOrderStaleness(null, new Date("2026-08-01T00:00:00.000Z"), true),
      "APPLY",
    );
  });

  test("end-to-end UNORDERABLE: a delivery with no providerUpdatedAt against a stored row with one is skipped, not applied", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const first = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-1" }),
      makeOrder({ providerUpdatedAt: new Date("2026-08-01T00:00:00.000Z") }),
      deps,
    );
    assert.equal(first.status, "CREATED");

    const unorderable = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-2" }),
      makeOrder({ providerUpdatedAt: null }),
      deps,
    );
    assert.equal(unorderable.status, "SKIPPED_STALE");
    assert.equal(unorderable.reason, "UNORDERABLE_MISSING_TIMESTAMP");
  });
});

// ---------------------------------------------------------------------------
// Concurrent deliveries for the SAME order
// ---------------------------------------------------------------------------

describe("concurrent deliveries for one order never overwrite newer committed state", () => {
  /**
   * The event claim deduplicates ONE delivery; it says nothing about two
   * DIFFERENT deliveries describing the same order arriving together, which
   * Shopify routinely does (`refunds/create` and `orders/updated` for one
   * refund). Each runs in its own transaction, and under READ COMMITTED the
   * staleness decision is made against a snapshot the other can invalidate
   * before either writes. `onOrderRead` stages exactly that interleaving.
   */
  test("a delivery whose snapshot went stale mid-transaction fails RETRYABLY instead of reverting the newer row", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const created = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-create" }),
      makeOrder({
        providerUpdatedAt: new Date("2026-08-01T00:00:00.000Z"),
        financialStatus: "PAID",
        totalMinor: BigInt(1999),
      }),
      deps,
    );
    assert.equal(created.status, "CREATED");
    const orderId = created.orderId!;

    // The concurrent winner: a later `orders/updated` carrying the refund,
    // committing between this delivery's read and its write.
    store.onOrderRead = () => {
      store.onOrderRead = null;
      const row = store.orders.get(orderId)!;
      row.providerUpdatedAt = new Date("2026-08-03T00:00:00.000Z");
      row.financialStatus = "REFUNDED";
      row.totalRefundedMinor = BigInt(1999);
      row.netRevenueMinor = BigInt(0);
    };

    const loser = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-refund" }),
      makeOrder({
        providerUpdatedAt: new Date("2026-08-02T00:00:00.000Z"),
        financialStatus: "PAID",
        totalRefundedMinor: null,
      }),
      deps,
    );

    assert.equal(loser.status, "FAILED");
    assert.equal(loser.reason, "WRITE_FAILED");
    assert.equal(
      isRetryableOrderIngestionOutcome(loser),
      true,
      "the provider must be asked to redeliver so the decision is remade against committed state",
    );

    // The newer committed state survived intact: no reverted financial status,
    // no zeroed cumulative refund total.
    const stored = store.orders.get(orderId)!;
    assert.equal(stored.financialStatus, "REFUNDED");
    assert.equal(stored.totalRefundedMinor, BigInt(1999));
    assert.equal(stored.netRevenueMinor, BigInt(0));
    assert.equal(
      stored.providerUpdatedAt?.toISOString(),
      "2026-08-03T00:00:00.000Z",
    );
    assert.equal(store.orders.size, 1);
  });

  test("the redelivery of that loser reaches the correct decision against committed state", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());

    await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-create" }),
      makeOrder({ providerUpdatedAt: new Date("2026-08-03T00:00:00.000Z") }),
      makeDeps(store),
    );

    // Same delivery id as a failed attempt: the event row is FAILED, which is
    // immediately RECLAIMABLE, so the retry genuinely reprocesses.
    store.events.seed(CommerceProvider.SHOPIFY, "wh-refund", { status: "FAILED" });

    const retry = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-refund" }),
      makeOrder({ providerUpdatedAt: new Date("2026-08-02T00:00:00.000Z") }),
      makeDeps(store),
    );

    assert.equal(retry.status, "SKIPPED_STALE");
    assert.equal(retry.reason, "OLDER_THAN_STORED_STATE");
  });

  test("an unchanged ordering key still applies normally — the guard only fires on a real conflict", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const created = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-1" }),
      makeOrder({ providerUpdatedAt: null, financialStatus: "PENDING" }),
      deps,
    );
    assert.equal(created.status, "CREATED");

    // A stored NULL ordering key must compare equal to a stored NULL, not
    // behave like SQL's `NULL <> NULL`.
    const applied = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-2" }),
      makeOrder({ providerUpdatedAt: null, financialStatus: "PAID" }),
      deps,
    );
    assert.equal(applied.status, "UPDATED");
    assert.equal(store.orders.get(created.orderId!)!.financialStatus, "PAID");
  });
});

// ---------------------------------------------------------------------------
// 5 & 7. Line items
// ---------------------------------------------------------------------------

describe("5 & 7. line items", () => {
  test("5. a payload with 3+ line items produces 3+ CommerceOrderLineItem rows", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({
        lineItems: [
          makeLineItem({ externalLineItemId: "li-1" }),
          makeLineItem({ externalLineItemId: "li-2" }),
          makeLineItem({ externalLineItemId: "li-3" }),
        ],
      }),
      deps,
    );

    assert.equal(outcome.status, "CREATED");
    assert.equal(outcome.lineItemCount, 3);
    assert.equal(store.lineItems.get(outcome.orderId!)!.length, 3);
  });

  test("7. a line item whose product matches no ConnectedCommerceProduct still gets created, with connectedProductId: null", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    // Deliberately no seedConnectedProduct call: nothing in the catalog.
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({ lineItems: [makeLineItem({ externalProductId: "9999999" })] }),
      deps,
    );

    assert.equal(outcome.status, "CREATED");
    const rows = store.lineItems.get(outcome.orderId!)!;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].connectedProductId, null);
    assert.equal(rows[0].externalProductId, "9999999");
  });

  test("a matching catalog product resolves connectedProductId through the GENERIC candidate rule (namespaced catalog key, bare-tail order id)", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    // The catalog stores a namespaced key; the order webhook reports its
    // trailing segment. That direction needs no provider knowledge at all.
    const catalogId = store.seedConnectedProduct("conn-1", "some-provider:product/1001");
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({
        lineItems: [makeLineItem({ externalProductId: "some-provider:product/1001" })],
      }),
      deps,
    );

    const rows = store.lineItems.get(outcome.orderId!)!;
    assert.equal(rows[0].connectedProductId, catalogId);
  });

  test("the PROVIDER-INJECTED expansion is what resolves a bare id against a provider-namespaced catalog key", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const catalogId = store.seedConnectedProduct("conn-1", "gid://example/Product/1001");

    // Stands in for a provider module's own `expandProductKeyCandidates` (the
    // real Shopify one is `shopifyProductKeyCandidates`, proven in
    // tests/shopify-order-webhook.test.ts). The generic layer cannot do this
    // expansion, because the namespace is the provider's knowledge.
    const expandProductKeyCandidates = (externalProductId: string | null): string[] => {
      const raw = externalProductId?.trim();
      if (!raw) return [];
      const candidates = new Set(providerProductKeyCandidates(raw));
      if (/^\d+$/.test(raw)) candidates.add(`gid://example/Product/${raw}`);
      return [...candidates];
    };

    const withProvider = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-with-provider" }),
      makeOrder({
        externalOrderId: "order-with-provider",
        lineItems: [makeLineItem({ externalProductId: "1001" })],
      }),
      makeDeps(store, { expandProductKeyCandidates }),
    );
    assert.equal(
      store.lineItems.get(withProvider.orderId!)![0].connectedProductId,
      catalogId,
    );

    // Without it the SAME line item stays unresolved — which is the proof that
    // the generic default carries no provider-specific expansion any more.
    const withoutProvider = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-generic" }),
      makeOrder({
        externalOrderId: "order-generic",
        lineItems: [makeLineItem({ externalProductId: "1001" })],
      }),
      makeDeps(store),
    );
    assert.equal(
      store.lineItems.get(withoutProvider.orderId!)![0].connectedProductId,
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// providerProductKeyCandidates — pure helper
// ---------------------------------------------------------------------------

describe("providerProductKeyCandidates is provider-neutral", () => {
  test("a bare numeric id yields ONLY itself — expanding it into a provider's namespaced form is the provider's job, not this layer's", () => {
    assert.deepEqual(providerProductKeyCandidates("123"), ["123"]);
  });

  test("a namespaced/pathish id yields itself and its trailing numeric tail (true for any provider)", () => {
    assert.deepEqual(providerProductKeyCandidates("gid://shopify/Product/456"), [
      "gid://shopify/Product/456",
      "456",
    ]);
    assert.deepEqual(providerProductKeyCandidates("commerce7:products/789"), [
      "commerce7:products/789",
      "789",
    ]);
  });

  test("a non-numeric, non-namespaced value is returned as-is", () => {
    assert.deepEqual(providerProductKeyCandidates("some-other-provider-id"), [
      "some-other-provider-id",
    ]);
  });

  test("null/empty yields no candidates", () => {
    assert.deepEqual(providerProductKeyCandidates(null), []);
    assert.deepEqual(providerProductKeyCandidates("   "), []);
  });
});

// ---------------------------------------------------------------------------
// 17. computeNetRevenueMinor
// ---------------------------------------------------------------------------

describe("17. computeNetRevenueMinor is deterministic and null-safe", () => {
  test("totalMinor - totalRefundedMinor", () => {
    assert.equal(computeNetRevenueMinor(BigInt(1999), BigInt(500)), BigInt(1499));
  });

  test("null totalMinor yields null net, never zero", () => {
    assert.equal(computeNetRevenueMinor(null, BigInt(0)), null);
  });

  test("fully refunded order nets to zero", () => {
    assert.equal(computeNetRevenueMinor(BigInt(1999), BigInt(1999)), BigInt(0));
  });
});

// ---------------------------------------------------------------------------
// P12.4 live-case multi-currency refund regression
// ---------------------------------------------------------------------------

/**
 * End-to-end (real Shopify normalizer + real ingestion service) regression
 * for the exact live-QA multi-currency P1: shop currency CAD, presentment
 * currency USD, real Shopify order #1002 values. Every fixture below uses
 * Shopify's actually-documented Refund resource shape (`refund_line_items[].
 * subtotal_set` as a `{shop_money, presentment_money}` MoneyBag) — the same
 * shape that caused the bug when the old code read a presentment-currency
 * `transactions[].amount` and mislabeled it as shop money.
 */
describe("P12.4 live-case regression: CAD shop currency, USD presentment currency, real order #1002 values", () => {
  // As of P12.4, totalRefundedMinor/financialStatus for a refund-bearing
  // order are NEVER computed by the pure REST normalizer (see
  // shopify-order-normalizer.ts's REFUNDS header block) — they are merged in
  // by the Shopify webhook layer's live GraphQL reconciliation BEFORE
  // ingestNormalizedOrder is ever called (see
  // tests/shopify-order-webhook.test.ts's "financial reconciliation
  // orchestration" suite for that merge step itself). This suite tests
  // ingestNormalizedOrder's OWN idempotency/staleness/coalesce behavior
  // given the exact values an authoritative reconciliation would produce —
  // i.e. it constructs each delivery the way the webhook layer would have
  // handed it to ingestion, post-merge.
  const SHOP_TOTAL_CAD_MINOR = BigInt(132257); // CAD 1322.57
  const PARTIAL_REFUND_CAD_MINOR = BigInt(61063); // CAD 610.63 — settled
  const REMAINDER_REFUND_CAD_MINOR = BigInt(71194); // CAD 711.94 — settled
  // The exact live-QA bug: the old REST-derivation code produced these
  // PRESENTMENT-currency (USD-in-cents) numbers mislabeled as CAD.
  const BUGGY_PARTIAL_PRESENTMENT_MINOR = BigInt(44000); // USD 440.00
  const BUGGY_FULL_PRESENTMENT_MINOR = BigInt(95300); // USD 953.00

  function shopifyOrder1002(overrides: Partial<NormalizedOrderInput> = {}): NormalizedOrderInput {
    return makeOrder({
      externalOrderId: "1002",
      orderNumber: "#1002",
      currencyCode: "CAD",
      minorUnitExponent: 2,
      subtotalMinor: SHOP_TOTAL_CAD_MINOR,
      totalMinor: SHOP_TOTAL_CAD_MINOR,
      totalRefundedMinor: BigInt(0),
      financialStatus: "PAID",
      lineItems: [],
      ...overrides,
    });
  }

  function makeShopifyEvent(providerEventId: string) {
    return makeEvent({ provider: CommerceProvider.SHOPIFY, providerEventId });
  }

  test("original order: totalMinor = 132257, totalRefundedMinor = 0, netRevenueMinor = 132257 (CommerceOrder.currencyCode = CAD)", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeShopifyEvent("orders-create-1002"),
      shopifyOrder1002({ providerUpdatedAt: new Date("2026-08-15T10:00:00-04:00") }),
      deps,
    );
    assert.equal(outcome.status, "CREATED");

    const stored = store.orders.get(outcome.orderId!)!;
    assert.equal(stored.currencyCode, "CAD");
    assert.equal(stored.totalMinor, SHOP_TOTAL_CAD_MINOR);
    assert.equal(stored.totalRefundedMinor, BigInt(0));
    assert.equal(stored.netRevenueMinor, SHOP_TOTAL_CAD_MINOR);
  });

  test("first partial refund (as a reconciled snapshot): totalRefundedMinor = 61063, netRevenueMinor = 71194 — NEVER the presentment USD 44000 the old buggy code produced", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const first = await ingestNormalizedOrder(
      makeShopifyEvent("orders-create-1002"),
      shopifyOrder1002({ providerUpdatedAt: new Date("2026-08-15T10:00:00-04:00") }),
      deps,
    );

    const second = await ingestNormalizedOrder(
      makeShopifyEvent("orders-updated-1002-partial"),
      shopifyOrder1002({
        providerUpdatedAt: new Date("2026-08-15T11:00:00-04:00"),
        totalRefundedMinor: PARTIAL_REFUND_CAD_MINOR,
        financialStatus: "PARTIALLY_REFUNDED",
      }),
      deps,
    );
    assert.equal(second.status, "UPDATED");
    assert.equal(second.orderId, first.orderId);

    const stored = store.orders.get(first.orderId!)!;
    assert.equal(stored.currencyCode, "CAD");
    assert.equal(stored.totalMinor, SHOP_TOTAL_CAD_MINOR);
    assert.notEqual(stored.totalRefundedMinor, BUGGY_PARTIAL_PRESENTMENT_MINOR);
    assert.equal(stored.totalRefundedMinor, PARTIAL_REFUND_CAD_MINOR);
    assert.equal(stored.netRevenueMinor, BigInt(71194));
    assert.equal(stored.financialStatus, "PARTIALLY_REFUNDED");
  });

  test("final cumulative refund (as a reconciled snapshot): totalRefundedMinor = 132257, netRevenueMinor = 0, financialStatus = REFUNDED — NEVER the presentment USD 95300 the old buggy code produced", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const first = await ingestNormalizedOrder(
      makeShopifyEvent("orders-create-1002"),
      shopifyOrder1002({ providerUpdatedAt: new Date("2026-08-15T10:00:00-04:00") }),
      deps,
    );
    await ingestNormalizedOrder(
      makeShopifyEvent("orders-updated-1002-partial"),
      shopifyOrder1002({
        providerUpdatedAt: new Date("2026-08-15T11:00:00-04:00"),
        totalRefundedMinor: PARTIAL_REFUND_CAD_MINOR,
        financialStatus: "PARTIALLY_REFUNDED",
      }),
      deps,
    );

    const third = await ingestNormalizedOrder(
      makeShopifyEvent("orders-updated-1002-full"),
      shopifyOrder1002({
        providerUpdatedAt: new Date("2026-08-15T12:00:00-04:00"),
        // The reconciliation's own SETTLED-transaction sum, cumulative by
        // construction (not the partial + remainder added by this test).
        totalRefundedMinor: PARTIAL_REFUND_CAD_MINOR + REMAINDER_REFUND_CAD_MINOR,
        financialStatus: "REFUNDED",
      }),
      deps,
    );
    assert.equal(third.status, "UPDATED");

    const stored = store.orders.get(first.orderId!)!;
    assert.equal(stored.currencyCode, "CAD");
    assert.equal(stored.totalMinor, SHOP_TOTAL_CAD_MINOR);
    assert.notEqual(stored.totalRefundedMinor, BUGGY_FULL_PRESENTMENT_MINOR);
    assert.equal(stored.totalRefundedMinor, SHOP_TOTAL_CAD_MINOR);
    assert.equal(stored.netRevenueMinor, BigInt(0));
    assert.equal(stored.financialStatus, "REFUNDED");
    // Required invariant: 0 <= totalRefundedMinor <= totalMinor.
    assert.ok(stored.totalRefundedMinor >= BigInt(0));
    assert.ok(stored.totalRefundedMinor <= stored.totalMinor!);
  });

  test("I/J. reverse-arrival convergence: a NOT_ELIGIBLE-deferred delivery (financial fields null, exactly as the webhook layer produces when reconciliation is unavailable) interleaved BEFORE the authoritative snapshots never changes the final state", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    await ingestNormalizedOrder(
      makeShopifyEvent("orders-create-1002"),
      shopifyOrder1002({ providerUpdatedAt: new Date("2026-08-15T10:00:00-04:00") }),
      deps,
    );

    // A delivery whose reconciliation came back NOT_ELIGIBLE — the webhook
    // layer defers (nulls) both settlement fields rather than guessing, per
    // shopify-order-webhook.ts's NOT_ELIGIBLE branch. Every other field
    // (fulfillmentStatus here) still lands normally — checked immediately,
    // since a LATER full snapshot's own fulfillmentStatus (authoritative,
    // not coalesced) legitimately supersedes it further down, same as any
    // other non-settlement field on a FULL payload.
    const deferred = await ingestNormalizedOrder(
      makeShopifyEvent("orders-updated-1002-deferred"),
      shopifyOrder1002({
        providerUpdatedAt: new Date("2026-08-15T10:59:00-04:00"),
        totalRefundedMinor: null,
        financialStatus: null,
        fulfillmentStatus: "FULFILLED",
      }),
      deps,
    );
    assert.equal(store.orders.get(deferred.orderId!)!.fulfillmentStatus, "FULFILLED");

    await ingestNormalizedOrder(
      makeShopifyEvent("orders-updated-1002-partial"),
      shopifyOrder1002({
        providerUpdatedAt: new Date("2026-08-15T11:00:00-04:00"),
        totalRefundedMinor: PARTIAL_REFUND_CAD_MINOR,
        financialStatus: "PARTIALLY_REFUNDED",
      }),
      deps,
    );

    const finalOutcome = await ingestNormalizedOrder(
      makeShopifyEvent("orders-updated-1002-full"),
      shopifyOrder1002({
        providerUpdatedAt: new Date("2026-08-15T12:00:00-04:00"),
        totalRefundedMinor: PARTIAL_REFUND_CAD_MINOR + REMAINDER_REFUND_CAD_MINOR,
        financialStatus: "REFUNDED",
      }),
      deps,
    );

    const finalStored = store.orders.get(finalOutcome.orderId!)!;
    assert.equal(finalStored.totalRefundedMinor, SHOP_TOTAL_CAD_MINOR);
    assert.equal(finalStored.netRevenueMinor, BigInt(0));
    assert.equal(finalStored.financialStatus, "REFUNDED");
  });

  test("I/J. reverse-arrival convergence: the same NOT_ELIGIBLE-deferred delivery interleaved AFTER the authoritative full-refund snapshot still converges to the identical final state, and never reverts it", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    await ingestNormalizedOrder(
      makeShopifyEvent("orders-create-1002"),
      shopifyOrder1002({ providerUpdatedAt: new Date("2026-08-15T10:00:00-04:00") }),
      deps,
    );
    await ingestNormalizedOrder(
      makeShopifyEvent("orders-updated-1002-partial"),
      shopifyOrder1002({
        providerUpdatedAt: new Date("2026-08-15T11:00:00-04:00"),
        totalRefundedMinor: PARTIAL_REFUND_CAD_MINOR,
        financialStatus: "PARTIALLY_REFUNDED",
      }),
      deps,
    );

    const finalOutcome = await ingestNormalizedOrder(
      makeShopifyEvent("orders-updated-1002-full"),
      shopifyOrder1002({
        providerUpdatedAt: new Date("2026-08-15T12:00:00-04:00"),
        totalRefundedMinor: PARTIAL_REFUND_CAD_MINOR + REMAINDER_REFUND_CAD_MINOR,
        financialStatus: "REFUNDED",
      }),
      deps,
    );

    // A late, deferred delivery arrives AFTER the full-refund snapshot, with
    // an OLDER providerUpdatedAt. The staleness guard rejects it outright —
    // and even if it had landed, its null settlement fields would coalesce
    // to the already-stored values (see order-ingestion.ts's coalesce-on-null
    // rule for totalRefundedMinor/financialStatus), never reverting them.
    const lateOutcome = await ingestNormalizedOrder(
      makeShopifyEvent("orders-updated-1002-late-deferred"),
      shopifyOrder1002({
        providerUpdatedAt: new Date("2026-08-15T11:00:05-04:00"),
        totalRefundedMinor: null,
        financialStatus: null,
      }),
      deps,
    );
    assert.equal(lateOutcome.status, "SKIPPED_STALE");

    const finalStored = store.orders.get(finalOutcome.orderId!)!;
    assert.equal(finalStored.totalRefundedMinor, SHOP_TOTAL_CAD_MINOR);
    assert.equal(finalStored.netRevenueMinor, BigInt(0));
    assert.equal(finalStored.financialStatus, "REFUNDED");
  });

  /**
   * A bare `refunds/create` PARTIAL fragment whose OWN reconciliation
   * attempt did not (yet) succeed — the exact shape
   * `normalizeShopifyRefundPayload` + a NOT_ELIGIBLE/TRANSIENT-then-retried
   * reconciliation produces: `completeness: "PARTIAL"`, only
   * `externalOrderId` and its own `providerUpdatedAt` populated, every other
   * field (including the two settlement fields) null so ingestion's PARTIAL
   * `pick` preserves whatever is already stored.
   */
  function bareRefundsCreateFragment(providerUpdatedAt: Date): NormalizedOrderInput {
    return {
      connectionId: "conn-1",
      brandId: "brand-1",
      provider: CommerceProvider.SHOPIFY,
      completeness: "PARTIAL",
      externalOrderId: "1002",
      orderNumber: null,
      currencyCode: null,
      minorUnitExponent: null,
      subtotalMinor: null,
      discountsMinor: null,
      shippingMinor: null,
      taxMinor: null,
      totalMinor: null,
      totalRefundedMinor: null,
      financialStatus: null,
      fulfillmentStatus: null,
      cancelledAt: null,
      cancelReason: null,
      providerCreatedAt: null,
      providerUpdatedAt,
      lineItems: [],
      attributionToken: null,
    };
  }

  test("I. topic-ordering: refunds/create (bare, unreconciled PARTIAL) arriving BEFORE orders/updated (reconciled FULL) converges to the correct final state", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    await ingestNormalizedOrder(
      makeShopifyEvent("orders-create-1002"),
      shopifyOrder1002({ providerUpdatedAt: new Date("2026-08-15T10:00:00-04:00") }),
      deps,
    );

    await ingestNormalizedOrder(
      makeShopifyEvent("refunds-create-1002"),
      bareRefundsCreateFragment(new Date("2026-08-15T10:59:00-04:00")),
      deps,
    );

    const updated = await ingestNormalizedOrder(
      makeShopifyEvent("orders-updated-1002-full"),
      shopifyOrder1002({
        providerUpdatedAt: new Date("2026-08-15T12:00:00-04:00"),
        totalRefundedMinor: PARTIAL_REFUND_CAD_MINOR + REMAINDER_REFUND_CAD_MINOR,
        financialStatus: "REFUNDED",
      }),
      deps,
    );

    const stored = store.orders.get(updated.orderId!)!;
    assert.equal(stored.totalRefundedMinor, SHOP_TOTAL_CAD_MINOR);
    assert.equal(stored.netRevenueMinor, BigInt(0));
    assert.equal(stored.financialStatus, "REFUNDED");
  });

  test("J. topic-ordering: orders/updated (reconciled FULL) arriving BEFORE a later refunds/create (bare, unreconciled PARTIAL) converges to the SAME final state", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    await ingestNormalizedOrder(
      makeShopifyEvent("orders-create-1002"),
      shopifyOrder1002({ providerUpdatedAt: new Date("2026-08-15T10:00:00-04:00") }),
      deps,
    );

    const updated = await ingestNormalizedOrder(
      makeShopifyEvent("orders-updated-1002-full"),
      shopifyOrder1002({
        providerUpdatedAt: new Date("2026-08-15T12:00:00-04:00"),
        totalRefundedMinor: PARTIAL_REFUND_CAD_MINOR + REMAINDER_REFUND_CAD_MINOR,
        financialStatus: "REFUNDED",
      }),
      deps,
    );

    // Shopify's own retried refunds/create arrives LAST — a bare PARTIAL
    // fragment can never revert the already-correct cumulative total,
    // regardless of its own providerUpdatedAt, because PARTIAL only ever
    // contributes non-null fields and every one of its fields is null here.
    const late = await ingestNormalizedOrder(
      makeShopifyEvent("refunds-create-1002-late"),
      bareRefundsCreateFragment(new Date("2026-08-15T12:00:05-04:00")),
      deps,
    );
    assert.equal(late.status, "UPDATED");

    const stored = store.orders.get(updated.orderId!)!;
    assert.equal(stored.totalRefundedMinor, SHOP_TOTAL_CAD_MINOR);
    assert.equal(stored.netRevenueMinor, BigInt(0));
    assert.equal(stored.financialStatus, "REFUNDED");
  });
});

// ---------------------------------------------------------------------------
// K. Financial invariant guard
// ---------------------------------------------------------------------------

describe("K. the financial invariant guard rejects an internally-contradictory complete snapshot rather than persisting it", () => {
  test("totalRefundedMinor > totalMinor is rejected: FAILED/CONTRADICTORY_FINANCIAL_SNAPSHOT, nothing written", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-contradictory-1" }),
      makeOrder({ totalMinor: BigInt(1000), totalRefundedMinor: BigInt(1500), financialStatus: "PARTIALLY_REFUNDED" }),
      deps,
    );
    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.reason, "CONTRADICTORY_FINANCIAL_SNAPSHOT");
    assert.equal(store.orders.size, 0, "nothing may be written for a rejected snapshot");
  });

  test("financialStatus REFUNDED with totalRefundedMinor < totalMinor is rejected — the exact contradictory state the live P1 bug produced", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-contradictory-2" }),
      makeOrder({ totalMinor: BigInt(132257), totalRefundedMinor: BigInt(95300), financialStatus: "REFUNDED" }),
      deps,
    );
    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.reason, "CONTRADICTORY_FINANCIAL_SNAPSHOT");
  });

  test("financialStatus PARTIALLY_REFUNDED with totalRefundedMinor === 0 is rejected (not strictly between 0 and totalMinor)", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-contradictory-3" }),
      makeOrder({ totalMinor: BigInt(1000), totalRefundedMinor: BigInt(0), financialStatus: "PARTIALLY_REFUNDED" }),
      deps,
    );
    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.reason, "CONTRADICTORY_FINANCIAL_SNAPSHOT");
  });

  test("financialStatus PARTIALLY_REFUNDED with totalRefundedMinor === totalMinor is rejected (that is REFUNDED, not partial)", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-contradictory-4" }),
      makeOrder({ totalMinor: BigInt(1000), totalRefundedMinor: BigInt(1000), financialStatus: "PARTIALLY_REFUNDED" }),
      deps,
    );
    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.reason, "CONTRADICTORY_FINANCIAL_SNAPSHOT");
  });

  test("a coherent complete snapshot (REFUNDED, totalRefundedMinor === totalMinor) is accepted normally", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-coherent-1" }),
      makeOrder({ totalMinor: BigInt(1000), totalRefundedMinor: BigInt(1000), financialStatus: "REFUNDED" }),
      deps,
    );
    assert.equal(outcome.status, "CREATED");
  });

  test("CONTRADICTORY_FINANCIAL_SNAPSHOT is NOT retryable — it is a deterministic rejection of the data itself, not a transient condition", () => {
    assert.equal(
      isRetryableOrderIngestionOutcome({
        status: "FAILED",
        reason: "CONTRADICTORY_FINANCIAL_SNAPSHOT",
      }),
      false,
    );
  });

  test("an UPDATE whose merged snapshot would be contradictory is rejected without corrupting the previously-stored, coherent row", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const first = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-preserve-1" }),
      makeOrder({
        providerUpdatedAt: new Date("2026-08-15T10:00:00-04:00"),
        totalMinor: BigInt(1000),
        totalRefundedMinor: BigInt(0),
        financialStatus: "PAID",
      }),
      deps,
    );
    assert.equal(first.status, "CREATED");
    const storedBefore = { ...store.orders.get(first.orderId!)! };

    const rejected = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-preserve-2" }),
      makeOrder({
        providerUpdatedAt: new Date("2026-08-15T11:00:00-04:00"),
        totalMinor: BigInt(1000),
        totalRefundedMinor: BigInt(1500),
        financialStatus: "PARTIALLY_REFUNDED",
      }),
      deps,
    );
    assert.equal(rejected.status, "FAILED");
    assert.equal(rejected.reason, "CONTRADICTORY_FINANCIAL_SNAPSHOT");

    const storedAfter = store.orders.get(first.orderId!)!;
    assert.deepEqual(storedAfter, storedBefore);
  });
});

// ---------------------------------------------------------------------------
// Connection gating — all six CommerceConnectionStatus values
// ---------------------------------------------------------------------------

describe("connection gating: isIngestibleConnectionStatus is a total switch over all six statuses", () => {
  const expected: Record<CommerceConnectionStatus, boolean> = {
    PENDING: true,
    CONNECTED: true,
    REQUIRES_RECONNECT: true,
    DISCONNECTED: false,
    UNINSTALLED: false,
    ERROR: false,
  };

  for (const [status, ingestible] of Object.entries(expected)) {
    test(`${status} -> ${ingestible}`, () => {
      assert.equal(isIngestibleConnectionStatus(status as CommerceConnectionStatus), ingestible);
    });
  }

  test("end-to-end: a DISCONNECTED connection yields SKIPPED_DISCONNECTED, event recorded, order table untouched", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection({ status: "DISCONNECTED" as CommerceConnectionStatus }));
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(makeEvent(), makeOrder(), deps);
    assert.equal(outcome.status, "SKIPPED_DISCONNECTED");
    assert.equal(outcome.reason, "CONNECTION_NOT_INGESTIBLE");
    assert.equal(outcome.orderId, null);
    assert.equal(store.orders.size, 0);
  });

  test("an unknown connectionId (loadConnection returns null) yields SKIPPED_DISCONNECTED / CONNECTION_NOT_FOUND", async () => {
    const store = new FakeOrderStore();
    // Deliberately no seedConnection call.
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(makeEvent(), makeOrder(), deps);
    assert.equal(outcome.status, "SKIPPED_DISCONNECTED");
    assert.equal(outcome.reason, "CONNECTION_NOT_FOUND");
  });

  test("a missing externalOrderId is FAILED / MISSING_EXTERNAL_ORDER_ID, order table untouched", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({ externalOrderId: null }),
      deps,
    );
    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.reason, "MISSING_EXTERNAL_ORDER_ID");
    assert.equal(store.orders.size, 0);
  });
});

// ---------------------------------------------------------------------------
// 18. Cross-brand integrity
// ---------------------------------------------------------------------------

describe("18. cross-brand integrity: brandId is ALWAYS read from the resolved connection", () => {
  test("a caller-supplied brandId that disagrees with the connection's own brandId is overridden, never persisted", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection({ id: "conn-1", brandId: "brand-REAL" }));
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent({ connectionId: "conn-1", brandId: "brand-ATTACKER-SUPPLIED" }),
      makeOrder({ connectionId: "conn-1", brandId: "brand-ATTACKER-SUPPLIED" }),
      deps,
    );

    assert.equal(outcome.status, "CREATED");
    assert.equal(outcome.brandIdOverriddenFromConnection, true);
    assert.equal(store.orders.get(outcome.orderId!)!.brandId, "brand-REAL");
  });

  test("a caller-supplied brandId that AGREES with the connection's brandId reports no override", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection({ id: "conn-1", brandId: "brand-1" }));
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent({ connectionId: "conn-1", brandId: "brand-1" }),
      makeOrder({ connectionId: "conn-1", brandId: "brand-1" }),
      deps,
    );

    assert.equal(outcome.brandIdOverriddenFromConnection, false);
  });
});

// ---------------------------------------------------------------------------
// 19. Connection-scoped identity
// ---------------------------------------------------------------------------

describe("19. externalOrderId identity is scoped to the connection, not global", () => {
  test("two different connections may hold the 'same' externalOrderId as two independent order rows", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection({ id: "conn-A", brandId: "brand-A" }));
    store.seedConnection(makeConnection({ id: "conn-B", brandId: "brand-B" }));
    const deps = makeDeps(store);

    const a = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-A", connectionId: "conn-A", brandId: "brand-A" }),
      makeOrder({ connectionId: "conn-A", brandId: "brand-A", externalOrderId: "shared-1001" }),
      deps,
    );
    const b = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-B", connectionId: "conn-B", brandId: "brand-B" }),
      makeOrder({ connectionId: "conn-B", brandId: "brand-B", externalOrderId: "shared-1001" }),
      deps,
    );

    assert.equal(a.status, "CREATED");
    assert.equal(b.status, "CREATED");
    assert.notEqual(a.orderId, b.orderId);
    assert.equal(store.orders.size, 2);

    // An UPDATE on connection A's order must never touch connection B's row.
    const updateA = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-A2", connectionId: "conn-A", brandId: "brand-A" }),
      makeOrder({
        connectionId: "conn-A",
        brandId: "brand-A",
        externalOrderId: "shared-1001",
        providerUpdatedAt: new Date("2026-08-09T00:00:00.000Z"),
        // A status with no totalRefundedMinor relationship to assert, so
        // this test (about cross-connection isolation) stays independent of
        // the financial invariant guard (see "K." below) — REFUNDED here
        // without a matching totalRefundedMinor would now be correctly
        // rejected as a contradictory snapshot, which is not what this test
        // is about.
        financialStatus: "PARTIALLY_PAID",
      }),
      deps,
    );
    assert.equal(updateA.status, "UPDATED");
    assert.equal(updateA.orderId, a.orderId);
    assert.equal(store.orders.get(a.orderId!)!.financialStatus, "PARTIALLY_PAID");
    assert.equal(store.orders.get(b.orderId!)!.financialStatus, "PAID");
  });
});

// ---------------------------------------------------------------------------
// 22, 23, 24. Attribution
// ---------------------------------------------------------------------------

describe("22, 23, 24. attribution association is evidence-based only", () => {
  test("22. a valid, unexpired, unconsumed token links the order and consumes the click via the conditional claim", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    store.seedAttribution({
      id: "click-1",
      tokenHash: "hash:GOOD-TOKEN",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      consumedAt: null,
      consumedByOrderRef: null,
    });
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({ attributionToken: "GOOD-TOKEN" }),
      deps,
    );

    assert.equal(outcome.status, "CREATED");
    assert.equal(outcome.attributionLinked, true);
    assert.equal(store.orders.get(outcome.orderId!)!.attributionId, "click-1");
    const click = store.attributions.get("click-1")!;
    assert.equal(click.consumedByOrderRef, outcome.orderId);
    assert.notEqual(click.consumedAt, null);
  });

  test("23. no token anywhere in the payload -> attributionId null, no attribution row touched", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    store.seedAttribution({
      id: "click-1",
      tokenHash: "hash:UNRELATED-TOKEN",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      consumedAt: null,
      consumedByOrderRef: null,
    });
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({ attributionToken: null }),
      deps,
    );

    assert.equal(outcome.attributionLinked, false);
    assert.equal(store.orders.get(outcome.orderId!)!.attributionId, null);
    assert.equal(store.attributions.get("click-1")!.consumedAt, null);
  });

  test("24a. a token that hash-matches nothing stored -> unattributed, never throws", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({ attributionToken: "NO-MATCHING-ROW" }),
      deps,
    );

    assert.equal(outcome.status, "CREATED");
    assert.equal(outcome.attributionLinked, false);
  });

  test("24b. an EXPIRED matching token -> unattributed", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    store.seedAttribution({
      id: "click-expired",
      tokenHash: "hash:EXPIRED-TOKEN",
      expiresAt: new Date("2026-08-01T00:00:00.000Z"), // before FIXED_NOW
      consumedAt: null,
      consumedByOrderRef: null,
    });
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({ attributionToken: "EXPIRED-TOKEN" }),
      deps,
    );

    assert.equal(outcome.attributionLinked, false);
    assert.equal(store.attributions.get("click-expired")!.consumedAt, null);
  });

  test("24c. a historical click without attributedBrandId remains unknown and is never claimed", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    store.seedAttribution({
      id: "click-unknown-brand",
      tokenHash: "hash:UNKNOWN-BRAND-TOKEN",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      consumedAt: null,
      consumedByOrderRef: null,
      attributedBrandId: null,
    });
    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({ attributionToken: "UNKNOWN-BRAND-TOKEN" }),
      makeDeps(store),
    );

    assert.equal(outcome.attributionLinked, false);
    assert.equal(store.orders.get(outcome.orderId!)!.attributionId, null);
    assert.equal(store.attributions.get("click-unknown-brand")!.consumedAt, null);
  });

  test("24c2. an unredirected, wrong-provider, or unpinned click token never becomes conversion evidence", async () => {
    for (const [id, overrides] of [
      ["click-unredirected", { redirectedAt: null }],
      ["click-wrong-provider", { provider: CommerceProvider.COMMERCE7 }],
      ["click-unpinned", { commerceConnectionId: null }],
    ] as const) {
      const store = new FakeOrderStore();
      store.seedConnection(makeConnection());
      store.seedAttribution({
        id,
        tokenHash: `hash:${id}`,
        expiresAt: new Date("2026-09-01T00:00:00.000Z"),
        consumedAt: null,
        consumedByOrderRef: null,
        ...overrides,
      });
      const outcome = await ingestNormalizedOrder(
        makeEvent({ providerEventId: `event-${id}` }),
        makeOrder({ externalOrderId: `order-${id}`, attributionToken: id }),
        makeDeps(store),
      );
      assert.equal(outcome.attributionLinked, false, id);
      assert.equal(store.attributions.get(id)!.consumedAt, null, id);
    }
  });

  test("24d. a token already consumed by a DIFFERENT order -> unattributed, never stolen", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    store.seedAttribution({
      id: "click-taken",
      tokenHash: "hash:TAKEN-TOKEN",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      consumedAt: new Date("2026-08-06T00:00:00.000Z"),
      consumedByOrderRef: "order-someone-else",
    });
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({ attributionToken: "TAKEN-TOKEN" }),
      deps,
    );

    assert.equal(outcome.attributionLinked, false);
    assert.equal(store.orders.get(outcome.orderId!)!.attributionId, null);
    // The rightful owner's claim is untouched.
    assert.equal(store.attributions.get("click-taken")!.consumedByOrderRef, "order-someone-else");
  });

  test("24d (bonus). a malformed token that fails hashing degrades to unattributed, never a failed ingestion", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({ attributionToken: "MALFORMED-TOKEN" }),
      deps,
    );

    assert.equal(outcome.status, "CREATED");
    assert.equal(outcome.attributionLinked, false);
  });

  test("a replay of the SAME order re-claiming its own already-consumed click is idempotent, not a loss", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const first = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-1" }),
      makeOrder({ attributionToken: "REPLAY-TOKEN" }),
      deps,
    );
    store.seedAttribution({
      id: "click-replay",
      tokenHash: "hash:REPLAY-TOKEN",
      expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      consumedAt: FIXED_NOW,
      consumedByOrderRef: first.orderId,
    });
    // Directly link it on the stored order row too, mirroring what the first
    // successful call would have done had the row existed at claim time.
    store.orders.get(first.orderId!)!.attributionId = "click-replay";

    // A second, newer event for the SAME order, same token: attributionLinked
    // must already read true from the stored order and skip re-claiming.
    const second = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-2" }),
      makeOrder({
        attributionToken: "REPLAY-TOKEN",
        providerUpdatedAt: new Date("2026-08-09T00:00:00.000Z"),
      }),
      deps,
    );
    assert.equal(second.status, "UPDATED");
    assert.equal(second.attributionLinked, true);
  });
});

// ---------------------------------------------------------------------------
// 10. The full attribution-claim rejection matrix
// ---------------------------------------------------------------------------

/**
 * Consolidates every INDEPENDENT reason `associateAttribution` refuses to link
 * a click to an order into one table, so the set is legible as a whole and a
 * newly-added guard has an obvious home. Each row differs from a KNOWN-GOOD
 * baseline in exactly one field, which is what makes it a proof that the field
 * alone is load-bearing.
 */
describe("10. attribution claim rejection matrix", () => {
  const GOOD_TOKEN = "MATRIX-TOKEN";
  const UNEXPIRED = new Date("2026-09-01T00:00:00.000Z");

  type SeedOverrides = {
    expiresAt?: Date;
    redirectedAt?: Date | null;
    attributedBrandId?: string | null;
    commerceConnectionId?: string | null;
    provider?: CommerceProvider | null;
    consumedAt?: Date | null;
    consumedByOrderRef?: string | null;
  };

  async function runWithClick(
    overrides: SeedOverrides,
    token = GOOD_TOKEN,
  ): Promise<{ store: FakeOrderStore; outcome: OrderIngestionOutcome }> {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    store.seedAttribution({
      id: "click-matrix",
      tokenHash: `hash:${GOOD_TOKEN}`,
      expiresAt: UNEXPIRED,
      consumedAt: null,
      consumedByOrderRef: null,
      ...overrides,
    });
    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({ attributionToken: token }),
      makeDeps(store),
    );
    return { store, outcome };
  }

  test("BASELINE: with every field correct the click IS claimed (so each rejection below is caused by its one changed field)", async () => {
    const { store, outcome } = await runWithClick({});
    assert.equal(outcome.attributionLinked, true);
    assert.equal(store.attributions.get("click-matrix")!.consumedByOrderRef, outcome.orderId);
  });

  const rejections: Array<{ name: string; overrides: SeedOverrides; token?: string }> = [
    {
      name: "a random token that hash-matches no stored row",
      overrides: {},
      token: "SOME-OTHER-TOKEN-ENTIRELY",
    },
    {
      name: "an EXPIRED click (expiresAt in the past)",
      overrides: { expiresAt: new Date(FIXED_NOW.getTime() - 1) },
    },
    {
      name: "a click that was never actually redirected (redirectedAt null)",
      overrides: { redirectedAt: null },
    },
    {
      name: "a click pinned to a DIFFERENT CommerceConnection",
      overrides: { commerceConnectionId: "conn-SOMEONE-ELSE" },
    },
    {
      name: "a click pinned to no connection at all (legacy/unpinned)",
      overrides: { commerceConnectionId: null },
    },
    {
      name: "a click recorded under a DIFFERENT provider",
      overrides: { provider: CommerceProvider.COMMERCE7 },
    },
    {
      name: "a click with no attributed brand (attributedBrandId null)",
      overrides: { attributedBrandId: null },
    },
    {
      name: "a click attributed to a DIFFERENT brand than the connection's",
      overrides: { attributedBrandId: "brand-SOMEONE-ELSE" },
    },
    {
      name: "a click already consumed by a DIFFERENT order (replay/steal attempt)",
      overrides: {
        consumedAt: new Date("2026-08-06T00:00:00.000Z"),
        consumedByOrderRef: "order-belonging-to-someone-else",
      },
    },
  ];

  for (const { name, overrides, token } of rejections) {
    test(`${name} -> no claim, order still created, stored click untouched`, async () => {
      const { store, outcome } = await runWithClick(overrides, token ?? GOOD_TOKEN);

      assert.equal(outcome.status, "CREATED", "a rejected claim never fails the ingestion");
      assert.equal(outcome.attributionLinked, false);
      assert.equal(store.orders.get(outcome.orderId!)!.attributionId, null);

      const click = store.attributions.get("click-matrix")!;
      assert.equal(
        click.consumedByOrderRef,
        overrides.consumedByOrderRef ?? null,
        "the stored click's ownership must be left exactly as it was",
      );
    });
  }

  test("REPLAY, same order: re-claiming a click this very order already consumed is idempotent, not a loss", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());

    // First delivery, no token: the order exists but holds no attribution.
    const first = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-1" }),
      makeOrder({ attributionToken: null }),
      makeDeps(store),
    );
    assert.equal(first.attributionLinked, false);

    // The click is already consumed BY THIS ORDER (as a committed claim from an
    // attempt whose order-row update did not land).
    store.seedAttribution({
      id: "click-self",
      tokenHash: "hash:SELF-TOKEN",
      expiresAt: UNEXPIRED,
      consumedAt: FIXED_NOW,
      consumedByOrderRef: first.orderId,
    });

    const replay = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-2" }),
      makeOrder({
        attributionToken: "SELF-TOKEN",
        providerUpdatedAt: new Date("2026-08-09T00:00:00.000Z"),
      }),
      makeDeps(store),
    );

    assert.equal(replay.status, "UPDATED");
    assert.equal(replay.attributionLinked, true, "the rightful owner re-links its own click");
    assert.equal(store.orders.get(first.orderId!)!.attributionId, "click-self");
    assert.equal(store.attributions.get("click-self")!.consumedByOrderRef, first.orderId);
  });

  test("REPLAY, different order: the second order cannot take a click the first already consumed", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    store.seedAttribution({
      id: "click-contested",
      tokenHash: "hash:CONTESTED",
      expiresAt: UNEXPIRED,
      consumedAt: null,
      consumedByOrderRef: null,
    });

    const winner = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-winner" }),
      makeOrder({ externalOrderId: "order-winner", attributionToken: "CONTESTED" }),
      makeDeps(store),
    );
    assert.equal(winner.attributionLinked, true);

    const loser = await ingestNormalizedOrder(
      makeEvent({ providerEventId: "wh-loser" }),
      makeOrder({ externalOrderId: "order-loser", attributionToken: "CONTESTED" }),
      makeDeps(store),
    );

    assert.equal(loser.status, "CREATED");
    assert.equal(loser.attributionLinked, false);
    assert.equal(store.orders.get(loser.orderId!)!.attributionId, null);
    assert.equal(store.attributions.get("click-contested")!.consumedByOrderRef, winner.orderId);
  });
});

// ---------------------------------------------------------------------------
// 25. Click alone never proves an order (source inspection)
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

describe("25. an order is never created FROM a click; a click is only ever linked TO an already-identified order", () => {
  test("order-ingestion.ts never creates a CommerceOrder from within associateAttribution — order creation happens strictly before attribution is attempted", () => {
    const source = readSource("src/lib/commerce/order-ingestion.ts");

    const associateStart = source.indexOf("async function associateAttribution");
    assert.notEqual(associateStart, -1);
    const associateEnd = source.indexOf("\n// ---", associateStart + 1);
    const associateBody = source.slice(associateStart, associateEnd === -1 ? undefined : associateEnd);

    assert.doesNotMatch(
      associateBody,
      /commerceOrder\.create/,
      "associateAttribution must never create an order — it only ever links an existing orderId",
    );

    // Order identity (create/update) happens before the attributionToken
    // branch is ever reached in the main entry point.
    const entryStart = source.indexOf("export async function ingestNormalizedOrder");
    assert.notEqual(entryStart, -1);
    const entryBody = source.slice(entryStart);
    const orderCreateIdx = entryBody.indexOf("tx.commerceOrder.create");
    const attributionBranchIdx = entryBody.indexOf("order.attributionToken && !attributionLinked");
    assert.ok(orderCreateIdx !== -1 && attributionBranchIdx !== -1);
    assert.ok(orderCreateIdx < attributionBranchIdx);
  });

  test("CommerceClickAttribution.create never appears in order-ingestion.ts — this module only ever READS and conditionally UPDATES click rows, never mints one", () => {
    const source = readSource("src/lib/commerce/order-ingestion.ts");
    assert.doesNotMatch(source, /commerceClickAttribution\.create/);
  });
});

// ---------------------------------------------------------------------------
// 26, 27, 28. No points / reward / commission mutation, anywhere in Phase 7
// ---------------------------------------------------------------------------

describe("26, 27, 28. Phase 7 never touches points, brand rewards, or creator commissions", () => {
  const PHASE_7_FILES = [
    "src/lib/commerce/order-ingestion.ts",
    "src/lib/commerce/providers/shopify-order-normalizer.ts",
    "src/lib/commerce/providers/shopify-order-webhook.ts",
    "src/app/api/shopify/webhooks/orders/create/route.ts",
    "src/app/api/shopify/webhooks/orders/updated/route.ts",
    "src/app/api/shopify/webhooks/refunds/create/route.ts",
  ];

  /**
   * Strips `/* ... *\/` block comments and `//` line comments before
   * matching. These files' own header comments deliberately NAME
   * `PointTransaction` / `BrandRewardOffer` / etc. to document their absence
   * (e.g. "Nothing here touches `PointTransaction`...") — matching the raw
   * source would flag that prose as a violation of the very guarantee it is
   * stating. Stripping comments first means these checks assert there is no
   * ACTUAL CODE reference (import, call, property access), which is what the
   * requirement is actually about.
   */
  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  test("26. no PointTransaction / UserPointAccount / debitPoints / creditPoints / pointsLedger reference in actual code", () => {
    const pattern = /PointTransaction|UserPointAccount|debitPoints|creditPoints|pointsLedger/;
    for (const file of PHASE_7_FILES) {
      assert.doesNotMatch(
        stripComments(readSource(file)),
        pattern,
        `${file} must not reference the points ledger outside of documentation comments`,
      );
    }
  });

  test("27. no BrandRewardOffer / ShopifyRewardRedemption / createShopifyRewardDiscountCode reference in actual code", () => {
    const pattern = /BrandRewardOffer|ShopifyRewardRedemption|createShopifyRewardDiscountCode/;
    for (const file of PHASE_7_FILES) {
      assert.doesNotMatch(
        stripComments(readSource(file)),
        pattern,
        `${file} must not reference brand rewards outside of documentation comments`,
      );
    }
  });

  test("28. no commission / payout / creatorEarning reference in actual code", () => {
    const pattern = /commission|payout|creatorEarning/i;
    for (const file of PHASE_7_FILES) {
      assert.doesNotMatch(
        stripComments(readSource(file)),
        pattern,
        `${file} must not reference commissions/payouts outside of documentation comments`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 11. Provider neutrality of the generic ingestion layer
// ---------------------------------------------------------------------------

describe("11. order-ingestion.ts is provider-neutral: no provider's id format in its executable code", () => {
  /** Same rationale as the Phase 7 grep block below: comments may NAME what the code must not contain. */
  function codeOnly(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  }

  test("the Shopify product GID prefix appears nowhere in the executable code", () => {
    const code = codeOnly(readSource("src/lib/commerce/order-ingestion.ts"));
    assert.doesNotMatch(
      code,
      /gid:\/\/shopify/i,
      "the generic layer must not know Shopify's global-id format — it belongs in the Shopify provider module, injected through OrderIngestionDeps.expandProductKeyCandidates",
    );
  });

  test("no provider brand name is referenced as a product-key concept in the executable code", () => {
    const code = codeOnly(readSource("src/lib/commerce/order-ingestion.ts"));
    assert.doesNotMatch(code, /shopify/i);
  });

  test("the injection seam exists on OrderIngestionDeps and defaults to the neutral helper", () => {
    const source = readSource("src/lib/commerce/order-ingestion.ts");
    assert.match(source, /expandProductKeyCandidates\(externalProductId: string \| null\): string\[\];/);
    assert.match(source, /expandProductKeyCandidates: providerProductKeyCandidates,/);
  });
});

// ---------------------------------------------------------------------------
// 30. No secrets serialized on the FAILED path
// ---------------------------------------------------------------------------

describe("30. the FAILED outcome never leaks the underlying error", () => {
  test("a runTransaction throw containing a would-be-sensitive string is discarded — the outcome carries only the classified WRITE_FAILED tag", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const secret = "shhh-column-value-leak-marker-9f3a";
    const deps = makeDeps(store, {
      async runTransaction() {
        throw new Error(`duplicate key value violates constraint, Detail: (${secret}) already exists.`);
      },
    });

    const outcome = await ingestNormalizedOrder(makeEvent(), makeOrder(), deps);

    assert.equal(outcome.status, "FAILED");
    assert.equal(outcome.reason, "WRITE_FAILED");
    const serialized = JSON.stringify(outcome);
    assert.doesNotMatch(serialized, new RegExp(secret));
  });

  test("order-ingestion.ts's write-failure catch deliberately discards the caught error's message (source inspection)", () => {
    const source = readSource("src/lib/commerce/order-ingestion.ts");
    const writeStepIdx = source.indexOf("// --- 4. Order write");
    assert.notEqual(writeStepIdx, -1);
    const catchIdx = source.indexOf("} catch {", writeStepIdx);
    assert.notEqual(
      catchIdx,
      -1,
      "the write-failure catch must not bind the error (no `catch (error)`), so its message can never be read",
    );
    const catchBody = source.slice(catchIdx, catchIdx + 400);
    assert.match(catchBody, /WRITE_FAILED/);
  });

  test("the outer unexpected-failure catch is unbound for the same reason", () => {
    const source = readSource("src/lib/commerce/order-ingestion.ts");
    const entryIdx = source.indexOf("export async function ingestNormalizedOrder");
    const catchIdx = source.indexOf("} catch {", entryIdx);
    assert.notEqual(catchIdx, -1);
    assert.match(source.slice(catchIdx, catchIdx + 700), /UNEXPECTED_FAILURE/);
  });
});

// ---------------------------------------------------------------------------
// 31. DATABASE_URL pin
// ---------------------------------------------------------------------------

test("31. this test file pins DATABASE_URL to the blocked host on line 1, before any import", () => {
  const source = readSource("tests/order-ingestion.test.ts");
  const firstLine = source.split("\n")[0];
  assert.equal(
    firstLine,
    'process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";',
  );
});

// ---------------------------------------------------------------------------
// Observation (not a fix): finalizeEvent is not dependency-injected
// ---------------------------------------------------------------------------

describe("observation: finalizeEvent bypasses the deps object entirely", () => {
  test("order-ingestion.ts's finalizeEvent always dynamically imports the real @/lib/prisma module, unlike claimEvent/loadConnection/runTransaction", () => {
    const source = readSource("src/lib/commerce/order-ingestion.ts");
    const fnStart = source.indexOf("async function finalizeEvent");
    assert.notEqual(fnStart, -1);
    const fnEnd = source.indexOf("\n// ---", fnStart + 1);
    const fnBody = source.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    assert.match(
      fnBody,
      /await import\("@\/lib\/prisma"\)/,
      "documents that finalizeEvent is NOT part of OrderIngestionDeps and always touches the real prisma singleton, relying on its own try/catch to stay a no-op under the blocked test DATABASE_URL",
    );
  });
});
