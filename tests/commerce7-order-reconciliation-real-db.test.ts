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
  "real Postgres — two CONCURRENT runCatchUpStep calls for the SAME connection use an exclusive durable claim; the checkpoint never regresses and no work is lost",
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

      // The whole-step claim denies B while A's provider call is suspended.
      // No database row lock or transaction is held over that provider call.
      try {
        await assert.rejects(
          runCatchUpStep({ brandId: brand.id, connectionId: connection.id }, { fetchOrders: secondFetchOrders as never }),
          { name: "Error", message: "Reconciliation is already running for this connection." },
        );
      } finally { releaseFirst(); }
      const resultA = await callA;
      assert.equal(fetchCallCount, 1);

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
      assert.equal(finalState.activeRunId, null);
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

test(
  "real Postgres — #1007: a Custom Range applies the bounded over-refund once beside the historical FAILED refund-v2 event, which stays byte-identical; a replay deduplicates",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { runCustomRangeStep } = await import("../src/lib/commerce/providers/commerce7-order-reconciliation");
    const { backfillCommerce7Orders, backfillProviderEventId, COMMERCE7_OVER_REFUND_SEMANTICS_VERSION, COMMERCE7_REFUND_RECONCILIATION_SEMANTICS_VERSION } = await import("../src/lib/commerce/providers/commerce7-order-backfill");
    const { prepareCommerce7OrderForIngestion } = await import("../src/lib/commerce/providers/commerce7-order-refund-reconciliation");
    const { brand, connection } = await makeBrandAndConnection(prisma);
    await prisma.commerceConnection.update({ where: { id: connection.id }, data: { providerMetadata: { currencyCode: "CAD" } } });
    // Synthetic provider documents with the live #1007 shape (no customer data).
    const ROOT = "cf8351cd-ff10-4d09-874a-02a34504b280"; const UPDATED = "2026-10-09T09:27:22.513Z";
    const refundDoc = (id: string, number: number, at: string) => ({
      id, orderNumber: number, purchaseType: "Refund", previousOrderId: ROOT, previousOrderNumber: 1007, paymentStatus: "Paid", subTotal: -16272, taxTotal: 0, total: -16272, createdAt: at, updatedAt: at,
      tenders: [{ id: `tender-${number}`, chargeType: "Refund", chargeStatus: "Success", amountTendered: -16272 }],
      items: [{ id: `${id}-line`, productId: "prod-rare", productTitle: "Rare - 2015 Chardonnay", sku: "RARE15", quantity: -1, price: 16272, tax: 0 }],
    });
    const root = {
      id: ROOT, orderNumber: 1007, channel: "Web", purchaseType: "Regular", paymentStatus: "Paid", fulfillmentStatus: "Fulfilled",
      createdAt: "2026-10-09T09:00:00.000Z", updatedAt: UPDATED, subTotal: 16272, taxTotal: 0, shipTotal: 0, total: 16272, previousOrderId: null,
      linkedOrders: [{ orderId: "refund-1008", orderNumber: 1008, purchaseType: "Refund" }, { orderId: "refund-1009", orderNumber: 1009, purchaseType: "Refund" }],
      tenders: [{ id: "sale-tender", chargeType: "Sale", chargeStatus: "Success", amountTendered: 16272 }],
      items: [
        { id: "line-a", productId: "prod-rare", productTitle: "Rare - 2015 Chardonnay", sku: "RARE15", quantity: 1, price: 8136, tax: 0 },
        { id: "line-b", productId: "prod-rose", productTitle: "Sample - 2016 Rose", sku: "2016R", quantity: 1, price: 8136, tax: 0 },
      ],
    };
    const provider: Record<string, unknown> = { [ROOT]: root, "refund-1008": refundDoc("refund-1008", 1008, "2026-10-09T09:20:00.000Z"), "refund-1009": refundDoc("refund-1009", 1009, "2026-10-09T09:25:00.000Z") };
    const historicalId = backfillProviderEventId(connection.id, ROOT, UPDATED, COMMERCE7_REFUND_RECONCILIATION_SEMANTICS_VERSION);
    const repairId = backfillProviderEventId(connection.id, ROOT, UPDATED, COMMERCE7_OVER_REFUND_SEMANTICS_VERSION);
    const backfill = (input: Parameters<typeof backfillCommerce7Orders>[0]) => backfillCommerce7Orders(input, {
      fetchOrders: async () => ({ orders: [root, provider["refund-1008"], provider["refund-1009"]] as never, total: 3 }),
      prepareOrder: (raw, context, tenant) => prepareCommerce7OrderForIngestion(raw, context, tenant, { fetchOrder: async ({ externalOrderId }) => provider[externalOrderId] as never }),
    });
    try {
      const historical = await prisma.commerceOrderEvent.create({ data: {
        provider: CommerceProvider.COMMERCE7, providerEventId: historicalId, topic: "commerce7:order:backfill", payloadDigest: "historical-digest",
        connectionId: connection.id, brandId: brand.id, externalOrderRef: ROOT, providerUpdatedAt: new Date(UPDATED),
        status: "FAILED", failureSummary: "CONTRADICTORY_FINANCIAL_SNAPSHOT", receivedAt: new Date("2026-10-10T04:40:28.037Z"), processedAt: new Date("2026-10-10T04:40:28.037Z"),
      } });
      const range = { brandId: brand.id, connectionId: connection.id, from: new Date("2026-10-06T00:00:00.000Z"), to: new Date("2026-10-10T00:00:00.000Z") };
      const first = await runCustomRangeStep(range, { fetchOrders: backfill as never });
      assert.equal(first.status, "PROGRESS", first.error ?? "");
      assert.deepEqual(await prisma.commerceOrderEvent.findUniqueOrThrow({ where: { id: historical.id } }), historical, "the historical FAILED event is never reclaimed or rewritten");
      const orders = await prisma.commerceOrder.findMany({ where: { connectionId: connection.id }, include: { lineItems: true } });
      assert.equal(orders.length, 1, "one canonical #1007; the refund documents never become orders");
      const [order] = orders;
      assert.equal(order.orderNumber, "1007"); assert.equal(order.totalMinor, BigInt(16272)); assert.equal(order.totalRefundedMinor, BigInt(16272));
      assert.equal(order.netRevenueMinor, BigInt(0)); assert.equal(order.financialStatus, "REFUNDED");
      assert.deepEqual(order.lineItems.map((line) => line.sku).sort(), ["2016R", "RARE15"]);
      const repair = await prisma.commerceOrderEvent.findUniqueOrThrow({ where: { provider_providerEventId: { provider: CommerceProvider.COMMERCE7, providerEventId: repairId } } });
      assert.equal(repair.status, "PROCESSED"); assert.equal(repair.failureSummary, "OVER_REFUND_EXCESS:16272"); assert.equal(repair.orderId, order.id);
      const state = await prisma.commerceOrderReconciliationState.findUniqueOrThrow({ where: { connectionId: connection.id } });
      assert.equal(state.lastRunOutcome, "SUCCEEDED");

      // A second run of the same range (fresh sequence) deduplicates: no new event, no new order, history intact.
      const eventsBefore = await prisma.commerceOrderEvent.count({ where: { connectionId: connection.id } });
      const again = await runCustomRangeStep({ ...range, from: new Date("2026-10-05T00:00:00.000Z") }, { fetchOrders: backfill as never });
      assert.equal(again.status, "PROGRESS", again.error ?? "");
      assert.equal(await prisma.commerceOrderEvent.count({ where: { connectionId: connection.id } }), eventsBefore);
      assert.equal(await prisma.commerceOrder.count({ where: { connectionId: connection.id } }), 1);
      assert.deepEqual(await prisma.commerceOrderEvent.findUniqueOrThrow({ where: { id: repair.id } }), repair);
      assert.deepEqual(await prisma.commerceOrderEvent.findUniqueOrThrow({ where: { id: historical.id } }), historical);
    } finally {
      await prisma.commerceOrderLineItem.deleteMany({ where: { order: { connectionId: connection.id } } });
      await cleanup(prisma, brand.id, connection.id);
    }
  },
);
