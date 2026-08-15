process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/order-ingestion.test.ts
 *
 * Unit tests for the provider-neutral order persistence service
 * (`src/lib/commerce/order-ingestion.ts`). Every dependency (`claimEvent`,
 * `loadConnection`, `runTransaction`, `hashAttributionToken`, `now`) is
 * injected and backed by an in-memory `FakeOrderStore` — no real DB, no real
 * network anywhere in this file. `finalizeEvent` inside `order-ingestion.ts`
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
  CommerceOrderFinancialStatus,
} from "@prisma/client";

import {
  ingestNormalizedOrder,
  isIngestibleConnectionStatus,
  decideOrderStaleness,
  computeNetRevenueMinor,
  providerProductKeyCandidates,
  type NormalizedOrderInput,
  type NormalizedOrderLineItemInput,
  type OrderIngestionEventInput,
  type OrderIngestionConnection,
  type OrderIngestionDeps,
} from "../src/lib/commerce/order-ingestion";

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
  claimedEventIds = new Set<string>();

  seedConnection(conn: OrderIngestionConnection): void {
    this.connections.set(conn.id, conn);
  }

  seedAttribution(row: Omit<AttributionRow, "attributedBrandId" | "commerceConnectionId"> & Partial<Pick<AttributionRow, "attributedBrandId" | "commerceConnectionId">>): void {
    const complete: AttributionRow = { attributedBrandId: "brand-1", commerceConnectionId: "conn-1", ...row };
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
   * reading the source: `commerceOrder.{findUnique,create,update}`,
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
          return id ? { ...store.orders.get(id)! } : null;
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

const FIXED_NOW = new Date("2026-08-07T12:00:00.000Z");

function makeDeps(
  store: FakeOrderStore,
  overrides: Partial<OrderIngestionDeps> = {},
): Partial<OrderIngestionDeps> {
  return {
    async claimEvent(input) {
      const key = `${input.provider}:${input.providerEventId}`;
      if (store.claimedEventIds.has(key)) {
        return { claimed: false };
      }
      store.claimedEventIds.add(key);
      return { claimed: true, eventId: `event-${store.nextId++}` };
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
  test("the same (provider, providerEventId) delivered twice creates ONE order; the second call is ALREADY_PROCESSED", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const deps = makeDeps(store);

    const first = await ingestNormalizedOrder(makeEvent(), makeOrder(), deps);
    assert.equal(first.status, "CREATED");
    assert.ok(first.orderId);

    const second = await ingestNormalizedOrder(makeEvent(), makeOrder(), deps);
    assert.equal(second.status, "ALREADY_PROCESSED");
    assert.equal(second.reason, "DUPLICATE_DELIVERY");
    assert.equal(second.orderId, null);

    assert.equal(store.orders.size, 1);
  });
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

  test("a matching catalog product DOES resolve connectedProductId, via either the bare numeric id or the gid form", async () => {
    const store = new FakeOrderStore();
    store.seedConnection(makeConnection());
    const catalogId = store.seedConnectedProduct("conn-1", "gid://shopify/Product/1001");
    const deps = makeDeps(store);

    const outcome = await ingestNormalizedOrder(
      makeEvent(),
      makeOrder({ lineItems: [makeLineItem({ externalProductId: "1001" })] }),
      deps,
    );

    const rows = store.lineItems.get(outcome.orderId!)!;
    assert.equal(rows[0].connectedProductId, catalogId);
  });
});

// ---------------------------------------------------------------------------
// providerProductKeyCandidates — pure helper
// ---------------------------------------------------------------------------

describe("providerProductKeyCandidates", () => {
  test("a bare numeric id yields itself and its gid form", () => {
    assert.deepEqual(providerProductKeyCandidates("123"), ["123", "gid://shopify/Product/123"]);
  });

  test("a gid yields itself and its trailing numeric tail", () => {
    assert.deepEqual(providerProductKeyCandidates("gid://shopify/Product/456"), [
      "gid://shopify/Product/456",
      "456",
    ]);
  });

  test("a non-numeric, non-gid value is returned as-is", () => {
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
        financialStatus: "REFUNDED",
      }),
      deps,
    );
    assert.equal(updateA.status, "UPDATED");
    assert.equal(updateA.orderId, a.orderId);
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

  test("order-ingestion.ts's catch block deliberately discards the caught error's message (source inspection)", () => {
    const source = readSource("src/lib/commerce/order-ingestion.ts");
    const catchIdx = source.lastIndexOf("} catch {");
    assert.notEqual(catchIdx, -1, "the write-failure catch must not bind the error (no `catch (error)`), so its message can never be read");
    const catchBody = source.slice(catchIdx, catchIdx + 400);
    assert.match(catchBody, /WRITE_FAILED/);
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
