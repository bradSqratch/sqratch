/**
 * tests/brand-commerce-live-client-hotfix.test.ts
 *
 * PHASE 20 HOTFIX (Part 10) — behavioral regression tests for the live
 * client crashes introduced by commit 6e718f3: several new commerce UI
 * call sites typed `fetchJson<{ data: T }>(...)` and then read `.data` off
 * the result — but `fetchJson` (`@/components/experience/client-utils`)
 * already unwraps the server's `{ data, meta }` envelope, so the resolved
 * value IS `T`, not `{ data: T }`. This is NOT a source-regex test: every
 * case below (a) calls the REAL server route implementation (with injected
 * data-layer deps only — no real database) to obtain the ACTUAL, current
 * response envelope, (b) mocks `global.fetch` to hand that exact body back,
 * (c) exercises the REAL `fetchJson` helper, and (d) exercises the REAL
 * extracted parsing helpers the fixed client components now call
 * (`product-catalog-helpers.ts` / `commerce-response-validation.ts`). Each
 * section also directly demonstrates the OLD buggy access pattern against
 * the SAME real envelope, proving these tests would have failed under the
 * pre-fix code.
 */
import "./env-setup";

import { test, describe, mock } from "node:test";
import { strict as assert } from "node:assert";
import { NextRequest } from "next/server";
import { CommerceProvider } from "@prisma/client";

import { fetchJson } from "../src/components/experience/client-utils";
import {
  parseSyncRunRows,
  type SyncRunRow,
} from "../src/app/(withSidebar)/dashboard/brand/products/product-catalog-helpers";
import {
  parseCommerce7Diagnostics,
  parseOrderOperationsSummary,
  parseOrderListEnvelope,
  parseReconcileResult,
} from "../src/app/(withSidebar)/dashboard/brand/commerce/commerce-response-validation";

import { syncRunsListImpl } from "../src/app/api/brand/products/sync-runs/route";
import { commerce7DiagnosticsGetImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/diagnostics/route";
import { brandCommerceOrdersSummaryGetImpl } from "../src/app/api/brand/commerce/orders/summary/route";
import { brandCommerceOrdersGetImpl } from "../src/app/api/brand/commerce/orders/route";
import { brandCommerceReconcilePostImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/orders/reconcile/route";
import type { BrandAdminContext } from "../src/lib/brand-auth";

function makeContext(brandId = "brand-a"): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired: false,
    brands: [{ id: brandId, name: "Acme", slug: "acme", membershipRole: "ADMIN" }],
    membership: {
      id: "member-1",
      role: "ADMIN",
      brand: { id: brandId, name: "Acme", slug: "acme", bio: null, websiteUrl: null, logoUrl: null, coverImageUrl: null },
    },
  };
}

/** Mocks `global.fetch` to serve one real server response body/status for every call, restoring the original on cleanup. */
function mockFetchOnce(body: unknown, status: number) {
  const original = global.fetch;
  global.fetch = mock.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
  return () => {
    global.fetch = original;
  };
}

describe("PHASE 20 HOTFIX — live client crash regression (fetchJson unwrapping)", () => {
  test("1. Sync run history: fetchJson<SyncRunRow[]> + parseSyncRunRows yields the real rows, never undefined", async () => {
    const res = await syncRunsListImpl(
      new NextRequest("https://x/api/brand/products/sync-runs?connectionId=conn-1&limit=10"),
      {
        getContext: async () => makeContext(),
        connectionBelongsToBrand: async () => true,
        findSyncRuns: async () => [
          {
            id: "run-1",
            connectionId: "conn-1",
            brandId: "brand-a",
            provider: CommerceProvider.COMMERCE7,
            status: "SUCCEEDED",
            startedAt: new Date("2026-01-01T00:00:00.000Z"),
            finishedAt: new Date("2026-01-01T00:01:00.000Z"),
            fetchedCount: 10,
            createdCount: 2,
            updatedCount: 3,
            unchangedCount: 5,
            markedUnavailableCount: 0,
            failedCount: 0,
            hasNextPage: false,
            requestedLimit: 50,
            failureSummary: null,
            triggeredBy: "brand-api",
          },
        ],
      },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    // The REAL server envelope this route returns — confirms the shape the
    // client must handle, rather than a hand-typed guess.
    assert.ok(Array.isArray(body.data));
    assert.ok(body.meta && typeof body.meta.hasNextPage === "boolean");

    const restore = mockFetchOnce(body, 200);
    try {
      // FIXED behavior: fetchJson<unknown> + parseSyncRunRows.
      const unwrapped = await fetchJson<unknown>("/api/brand/products/sync-runs?connectionId=conn-1&limit=10");
      const parsed = parseSyncRunRows(unwrapped);
      assert.ok(parsed, "parseSyncRunRows must accept the real envelope's unwrapped array");
      assert.equal(parsed!.length, 1);
      assert.equal(parsed![0].id, "run-1");

      // REGRESSION PROOF: the OLD code's exact pattern
      // (`fetchJson<{data: SyncRunRow[]}>()` then `.data`) against this SAME
      // real response is `undefined` — this is commit 6e718f3's live bug.
      const buggy = (await fetchJson<{ data: SyncRunRow[] }>(
        "/api/brand/products/sync-runs?connectionId=conn-1&limit=10",
      )) as { data: SyncRunRow[] };
      assert.equal(buggy.data, undefined, "the pre-fix `.data` access must be undefined against the real envelope");
    } finally {
      restore();
    }
  });

  test("2. Readiness diagnostics: fetchJson<unknown> + parseCommerce7Diagnostics displays the real diagnostics object, never undefined", async () => {
    const res = await commerce7DiagnosticsGetImpl(
      {
        getContext: async () => makeContext(),
        getDiagnostics: async () => ({
          connectionId: "conn-1",
          connected: true,
          storefrontUrlConfigured: true,
          productRouteConfigured: true,
          currencyConfigured: true,
          productsSynced: true,
          lastProductSyncAt: "2026-01-01T00:00:00.000Z",
          orderReceiverConfigured: true,
          latestOrderIngestedAt: null,
          latestWebhookProcessedAt: null,
          latestFailedWebhookEvent: null,
          orderReadOperational: true,
        }),
      },
      "conn-1",
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.data, "object");

    const restore = mockFetchOnce(body, 200);
    try {
      const unwrapped = await fetchJson<unknown>("/api/brand/commerce/connections/conn-1/diagnostics");
      const parsed = parseCommerce7Diagnostics(unwrapped);
      assert.ok(parsed, "parseCommerce7Diagnostics must accept the real diagnostics envelope");
      assert.equal(parsed!.connected, true);
      assert.equal(parsed!.connectionId, "conn-1");

      // REGRESSION PROOF: the OLD `.data` access against the real envelope.
      const buggy = (await fetchJson<{ data: unknown }>(
        "/api/brand/commerce/connections/conn-1/diagnostics",
      )) as { data: unknown };
      assert.equal(buggy.data, undefined);
    } finally {
      restore();
    }

    // Malformed shape (e.g. a transient bad deploy / API drift) must be
    // rejected by the validator, never silently accepted.
    assert.equal(parseCommerce7Diagnostics({ data: "not-an-object" }), null);
    assert.equal(parseCommerce7Diagnostics(null), null);
  });

  test("3. Order operations summary: an EXISTING connection is displayed, never masked as 'no commerce connections yet'", async () => {
    const res = await brandCommerceOrdersSummaryGetImpl({
      getContext: async () => makeContext(),
      getSummary: async () => ({
        connections: [
          {
            connectionId: "conn-1",
            provider: CommerceProvider.COMMERCE7,
            displayName: "Acme Winery",
            externalAccountId: "tenant-1",
            status: "CONNECTED",
            latestOrderIngestedAt: null,
            latestWebhookProcessedAt: null,
            orderCountsByFinancialStatus: {},
            unknownFinancialStatusCount: 0,
            attributedOrderCount: 0,
            unattributedOrderCount: 0,
            orderReceiverConfigured: true,
          },
        ],
        complete: true,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();

    const restore = mockFetchOnce(body, 200);
    try {
      const unwrapped = await fetchJson<unknown>("/api/brand/commerce/orders/summary");
      const parsed = parseOrderOperationsSummary(unwrapped);
      assert.ok(parsed, "parseOrderOperationsSummary must accept the real envelope");
      // THE LIVE BUG: before this fix, this connection silently disappeared
      // and the page rendered "No commerce connections yet." despite a real,
      // CONNECTED connection existing.
      assert.equal(parsed!.connections.length, 1);
      assert.equal(parsed!.connections[0].connectionId, "conn-1");

      // REGRESSION PROOF: the OLD `.data` access against the real envelope
      // is undefined — `!summary || summary.connections.length === 0` in the
      // pre-fix component then reads as "no connections."
      const buggy = (await fetchJson<{ data: unknown }>("/api/brand/commerce/orders/summary")) as {
        data: unknown;
      };
      assert.equal(buggy.data, undefined);
    } finally {
      restore();
    }

    // A malformed response must surface as a controlled error, NEVER as an
    // empty `connections: []` — that would be indistinguishable from "no
    // connections yet" and could mask a real, existing connection.
    assert.equal(parseOrderOperationsSummary({ connections: "not-an-array", complete: true }), null);
    assert.equal(parseOrderOperationsSummary(null), null);
  });

  test("4a. Recent orders: parseOrderListEnvelope consumes { data, meta } correctly (non-empty page)", async () => {
    const res = await brandCommerceOrdersGetImpl(
      {
        getContext: async () => makeContext(),
        findOrders: async () => [
          {
            id: "order-1",
            connectionId: "conn-1",
            provider: CommerceProvider.COMMERCE7,
            orderNumber: "1001",
            providerCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
            createdAt: new Date("2026-01-01T00:05:00.000Z"),
            updatedAt: new Date("2026-01-02T00:00:00.000Z"),
            financialStatus: "PAID",
            fulfillmentStatus: "FULFILLED",
            currencyCode: "USD",
            minorUnitExponent: 2,
            totalMinor: BigInt(5900),
            totalRefundedMinor: BigInt(0),
            netRevenueMinor: BigInt(5900),
            attributionId: "attr-1",
          },
        ],
      },
      { provider: null, financialStatus: null, attributed: null, cursor: null, limit: "20" },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.data));
    assert.ok(body.meta);

    const parsed = parseOrderListEnvelope(body);
    assert.ok(parsed, "parseOrderListEnvelope must accept the real orders envelope");
    assert.equal(parsed!.data.length, 1);
    assert.equal(typeof parsed!.meta.hasNextPage, "boolean");
  });

  test("4b. Recent orders: an empty result renders as a genuinely empty (not malformed) page — 'No orders yet.'", async () => {
    const res = await brandCommerceOrdersGetImpl(
      { getContext: async () => makeContext(), findOrders: async () => [] },
      { provider: null, financialStatus: null, attributed: null, cursor: null, limit: "20" },
    );
    const body = await res.json();
    const parsed = parseOrderListEnvelope(body);
    assert.ok(parsed);
    assert.equal(parsed!.data.length, 0);
    assert.equal(parsed!.meta.hasNextPage, false);
  });

  test("4c. Recent orders: THE LIVE CRASH — fetchJson's unwrapped array has no `.meta`; parseOrderListEnvelope on the raw body never throws", async () => {
    const res = await brandCommerceOrdersGetImpl(
      {
        getContext: async () => makeContext(),
        findOrders: async () => [
          {
            id: "order-1",
            connectionId: "conn-1",
            provider: CommerceProvider.COMMERCE7,
            orderNumber: "1001",
            providerCreatedAt: null,
            createdAt: new Date("2026-01-01T00:05:00.000Z"),
            updatedAt: new Date("2026-01-02T00:00:00.000Z"),
            financialStatus: "PAID",
            fulfillmentStatus: "FULFILLED",
            currencyCode: "USD",
            minorUnitExponent: 2,
            totalMinor: BigInt(1000),
            totalRefundedMinor: BigInt(0),
            netRevenueMinor: BigInt(1000),
            attributionId: null,
          },
        ],
      },
      { provider: null, financialStatus: null, attributed: null, cursor: null, limit: "20" },
    );
    const body = await res.json();

    const restore = mockFetchOnce(body, 200);
    try {
      // THE EXACT PRE-FIX SEQUENCE: fetchJson unwraps `{ data, meta }` down
      // to just the array (this route's `data` value), discarding `meta`
      // entirely. The old code then typed this as `{ data, meta }` and read
      // `.meta.hasNextPage` off it — `.meta` is `undefined` on a plain
      // array, so that access throws EXACTLY the reported live error:
      // "Cannot read properties of undefined (reading 'hasNextPage')".
      const unwrapped = (await fetchJson<{ data: unknown; meta: { hasNextPage: boolean } }>(
        "/api/brand/commerce/orders?limit=20",
      )) as { data: unknown; meta: { hasNextPage: boolean } };
      assert.throws(
        () => {
          void unwrapped.meta.hasNextPage;
        },
        /Cannot read propert(y|ies) of undefined/,
        "reproduces the exact live crash from commit 6e718f3",
      );
    } finally {
      restore();
    }

    // THE FIX: a plain (non-unwrapping) fetch + parseOrderListEnvelope on
    // the SAME real body never throws, regardless of shape.
    const parsed = parseOrderListEnvelope(body);
    assert.ok(parsed);
    assert.equal(typeof parsed!.meta.hasNextPage, "boolean");

    // And a genuinely malformed envelope (meta missing entirely) is
    // rejected as `null` — a controlled error state, not a crash.
    assert.equal(parseOrderListEnvelope({ data: body.data }), null);
    assert.equal(parseOrderListEnvelope({ data: "not-an-array", meta: body.meta }), null);
    assert.equal(parseOrderListEnvelope(null), null);
  });

  test("5. Reconcile: fetchJson<unknown> + parseReconcileResult consumes the real result correctly", async () => {
    const res = await brandCommerceReconcilePostImpl(
      {
        getContext: async () => makeContext(),
        reconcile: async () => ({
          status: "COMPLETED",
          ordersFetched: 3,
          ordersProcessed: 3,
          outcomes: [
            { status: "CREATED" },
            { status: "UPDATED" },
            { status: "ALREADY_PROCESSED" },
          ] as never,
        }),
      },
      "conn-1",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.data, "object");

    const restore = mockFetchOnce(body, 200);
    try {
      const unwrapped = await fetchJson<unknown>(
        "/api/brand/commerce/connections/conn-1/orders/reconcile",
        { method: "POST" },
      );
      const parsed = parseReconcileResult(unwrapped);
      assert.ok(parsed, "parseReconcileResult must accept the real reconcile envelope");
      assert.equal(parsed!.status, "SUCCEEDED");
      assert.equal(parsed!.createdCount, 1);
      assert.equal(parsed!.updatedCount, 1);
      assert.equal(parsed!.unchangedCount, 1);
      assert.equal(parsed!.failedCount, 0);

      // REGRESSION PROOF: the OLD `.data` access against the real envelope.
      const buggy = (await fetchJson<{ data: unknown }>(
        "/api/brand/commerce/connections/conn-1/orders/reconcile",
        { method: "POST" },
      )) as { data: unknown };
      assert.equal(buggy.data, undefined);
    } finally {
      restore();
    }
  });
});
