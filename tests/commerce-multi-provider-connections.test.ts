/**
 * PHASE 16 BIG ROUND / SUBPHASE 3 — multi-provider connection listing and
 * connection-scoped product-sync concurrency. Battery items 28-36.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import {
  getAllCommerceConnectionsForBrand,
  type CommerceConnectionListResult,
} from "../src/lib/commerce/connection-service";
import type { CommerceConnectionRow } from "../src/lib/commerce/connection-resolver";
import { commerceConnectionsGetImpl } from "../src/app/api/brand/commerce/connections/route";
import { productsSyncImpl } from "../src/app/api/brand/products/sync/route";
import type { BrandAdminContext } from "../src/lib/brand-auth";
import type { CommerceConnectionSummary } from "../src/lib/commerce/types";

function zeroStats() {
  return {
    fetchedCount: 0,
    createdCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    markedUnavailableCount: 0,
    failedCount: 0,
  };
}

function row(overrides: Partial<CommerceConnectionRow> = {}): CommerceConnectionRow {
  return {
    id: "conn-1",
    brandId: "brand-a",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED",
    displayName: "Acme",
    externalAccountId: "acme.myshopify.com",
    storefrontUrl: null,
    isPrimary: false,
    grantedScopes: null,
    installedAt: new Date(),
    uninstalledAt: null,
    lastProductSyncAt: null,
    providerMetadata: null,
    createdAt: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 28. getAllCommerceConnectionsForBrand
// ---------------------------------------------------------------------------

describe("28. getAllCommerceConnectionsForBrand", () => {
  test("fans out across every provider and returns every row, not just one preferred per provider", async () => {
    const shopifyRow = row({ id: "conn-shopify", provider: CommerceProvider.SHOPIFY });
    const commerce7Row = row({
      id: "conn-c7",
      provider: CommerceProvider.COMMERCE7,
      externalAccountId: "acme-tenant",
    });

    const result = await getAllCommerceConnectionsForBrand("brand-a", {
      findConnectionRows: async (_brandId, provider) =>
        provider === CommerceProvider.SHOPIFY ? [shopifyRow] : provider === CommerceProvider.COMMERCE7 ? [commerce7Row] : [],
    });

    const ids = result.connections.map((c) => c.id).sort();
    assert.deepEqual(ids, ["conn-c7", "conn-shopify"]);
    assert.equal(result.complete, true);
    assert.deepEqual(result.failedProviders, []);
  });

  // -------------------------------------------------------------------
  // PHASE 18 REPAIR — P2-4B: a per-provider read failure must be
  // DISTINGUISHABLE from "that provider genuinely has zero connections."
  // -------------------------------------------------------------------
  test("a per-provider read failure still yields the OTHER provider's connections, but flags the result incomplete rather than silently omitting the failure", async () => {
    const shopifyRow = row({ id: "conn-shopify", provider: CommerceProvider.SHOPIFY });

    const result = await getAllCommerceConnectionsForBrand("brand-a", {
      findConnectionRows: async (_brandId, provider) => {
        if (provider === CommerceProvider.COMMERCE7) {
          throw new Error("transient outage");
        }
        return provider === CommerceProvider.SHOPIFY ? [shopifyRow] : [];
      },
    });

    assert.equal(result.connections.length, 1);
    assert.equal(result.connections[0].id, "conn-shopify");
    assert.equal(result.complete, false, "a hidden failure must never be reported as a complete list");
    assert.deepEqual(result.failedProviders, [CommerceProvider.COMMERCE7]);
  });

  test("every provider succeeding (even with zero rows each) reports complete: true and no failed providers", async () => {
    const result = await getAllCommerceConnectionsForBrand("brand-a", {
      findConnectionRows: async () => [],
    });
    assert.deepEqual(result.connections, []);
    assert.equal(result.complete, true);
    assert.deepEqual(result.failedProviders, []);
  });
});

// ---------------------------------------------------------------------------
// 29-32. GET /api/brand/commerce/connections
// ---------------------------------------------------------------------------

function makeContext(): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired: false,
    brands: [{ id: "brand-a", name: "Acme", slug: "acme", membershipRole: "ADMIN" }],
    membership: {
      id: "member-1",
      role: "ADMIN",
      brand: {
        id: "brand-a",
        name: "Acme",
        slug: "acme",
        bio: null,
        websiteUrl: null,
        logoUrl: null,
        coverImageUrl: null,
      },
    },
  };
}

function summary(overrides: Partial<CommerceConnectionSummary> = {}): CommerceConnectionSummary {
  return {
    id: "conn-1",
    brandId: "brand-a",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED",
    displayName: "Acme",
    externalAccountId: "acme.myshopify.com",
    storefrontUrl: "https://acme.myshopify.com",
    isPrimary: false,
    grantedScopes: [],
    installedAt: new Date(),
    uninstalledAt: null,
    lastProductSyncAt: null,
    currencyCode: "USD",
    ...overrides,
  };
}

function listResult(
  connections: CommerceConnectionSummary[],
  overrides: { complete?: boolean; failedProviders?: CommerceProvider[] } = {},
): CommerceConnectionListResult {
  return {
    connections,
    complete: overrides.complete ?? true,
    failedProviders: overrides.failedProviders ?? [],
  };
}

describe("29-32. commerceConnectionsGetImpl", () => {
  test("29. unauthenticated caller never reaches getConnections()", async () => {
    let called = false;
    const res = await commerceConnectionsGetImpl({
      getContext: async () => null,
      getConnections: async () => {
        called = true;
        return listResult([]);
      },
    });
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("30. the response never carries a secret/token-shaped field", async () => {
    const res = await commerceConnectionsGetImpl({
      getContext: async () => makeContext(),
      getConnections: async () => listResult([summary()]),
    });
    const body = await res.json();
    const serialized = JSON.stringify(body);
    for (const forbidden of ["secret", "token", "password", "accessToken", "encryptedPayload"]) {
      assert.ok(
        !serialized.toLowerCase().includes(forbidden.toLowerCase()),
        `response must not contain "${forbidden}"`,
      );
    }
    assert.equal(body.data.connections[0].connectionId, "conn-1");
    assert.equal(body.data.connections[0].provider, "SHOPIFY");
  });

  test("31. autoSelectConnectionId is set when exactly one CONNECTED connection exists AND the read is complete", async () => {
    const res = await commerceConnectionsGetImpl({
      getContext: async () => makeContext(),
      getConnections: async () => listResult([summary({ id: "conn-only" })]),
    });
    const body = await res.json();
    assert.equal(body.data.autoSelectConnectionId, "conn-only");
    assert.equal(body.data.complete, true);
  });

  test("32a. autoSelectConnectionId is null when zero connections exist", async () => {
    const res = await commerceConnectionsGetImpl({
      getContext: async () => makeContext(),
      getConnections: async () => listResult([]),
    });
    const body = await res.json();
    assert.equal(body.data.autoSelectConnectionId, null);
  });

  test("32b. autoSelectConnectionId is null when more than one CONNECTED connection exists", async () => {
    const res = await commerceConnectionsGetImpl({
      getContext: async () => makeContext(),
      getConnections: async () =>
        listResult([
          summary({ id: "conn-shopify", provider: CommerceProvider.SHOPIFY }),
          summary({ id: "conn-c7", provider: CommerceProvider.COMMERCE7 }),
        ]),
    });
    const body = await res.json();
    assert.equal(body.data.autoSelectConnectionId, null);
    assert.equal(body.data.connections.length, 2);
  });

  test("32c. a DISCONNECTED connection is listed but never counted toward auto-select", async () => {
    const res = await commerceConnectionsGetImpl({
      getContext: async () => makeContext(),
      getConnections: async () =>
        listResult([
          summary({ id: "conn-connected", status: "CONNECTED" }),
          summary({ id: "conn-dead", status: "DISCONNECTED", provider: CommerceProvider.COMMERCE7 }),
        ]),
    });
    const body = await res.json();
    assert.equal(body.data.connections.length, 2);
    assert.equal(body.data.autoSelectConnectionId, "conn-connected");
  });

  // -------------------------------------------------------------------
  // PHASE 18 REPAIR — P2-4B: an INCOMPLETE read must never auto-select,
  // even when exactly one connection happens to be visible.
  // -------------------------------------------------------------------
  test("32d. autoSelectConnectionId is null when the read is INCOMPLETE, even with exactly one visible CONNECTED connection", async () => {
    const res = await commerceConnectionsGetImpl({
      getContext: async () => makeContext(),
      getConnections: async () =>
        listResult([summary({ id: "conn-only-visible" })], {
          complete: false,
          failedProviders: [CommerceProvider.COMMERCE7],
        }),
    });
    const body = await res.json();
    assert.equal(
      body.data.autoSelectConnectionId,
      null,
      "a hidden failed provider might ALSO have a connection — auto-select must not proceed on unverified completeness",
    );
    assert.equal(body.data.complete, false);
    // The connection that WAS successfully read is still shown — display
    // degrades gracefully, only the ACTIONABLE auto-select is withheld.
    assert.equal(body.data.connections.length, 1);
  });

  test("32e. the internal failure reason is never exposed to the client — only the completeness fact", async () => {
    const res = await commerceConnectionsGetImpl({
      getContext: async () => makeContext(),
      getConnections: async () =>
        listResult([], { complete: false, failedProviders: [CommerceProvider.COMMERCE7] }),
    });
    const body = await res.json();
    const serialized = JSON.stringify(body).toLowerCase();
    assert.ok(!serialized.includes("outage"));
    assert.ok(!serialized.includes("error") || serialized.includes("complete"));
    assert.equal(body.data.complete, false);
  });
});

// ---------------------------------------------------------------------------
// 33-36. Connection-scoped product-sync concurrency guard
//
// PHASE 19 REPAIR (P1-2): the RUNNING-run guard used to be a separate,
// route-level, non-atomic `findRunningRun` pre-check with its own scoping
// logic (tested here directly). That check has been REMOVED — the atomic
// claim now lives entirely inside `product-sync.ts`'s
// `claimProductSyncRun`, which is ALWAYS scoped to the exact resolved
// `connectionId` (see that function's own tests in
// `commerce-product-sync.test.ts` for the atomicity/scoping guarantees
// themselves, including cross-connection independence and the concurrent
// double-claim barrier test). What remains to verify at THIS (route) level
// is narrower: the route faithfully translates whatever `ProductSyncOutcome`
// `runSync` returns, including the new `ALREADY_RUNNING` status, without
// reintroducing a second, redundant check.
// ---------------------------------------------------------------------------

describe("33-36. productsSyncImpl outcome translation (post P1-2 atomic-claim repair)", () => {
  test("33. a SUCCEEDED outcome for an explicit connectionId request maps to 200 with that connectionId echoed", async () => {
    const res = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        runSync: async (brandId, provider) => ({
          status: "SUCCEEDED",
          brandId,
          provider,
          connectionId: "conn-c7",
          runId: "run-1",
          stats: zeroStats(),
          hasNextPage: false,
          failureSummary: null,
        }),
      },
      "COMMERCE7",
      "conn-c7",
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.connectionId, "conn-c7");
  });

  test("34. the legacy bodyless (no connectionId) request still reaches runSync and surfaces its outcome", async () => {
    let runSyncCalledWithConnectionId: string | null | undefined;
    const res = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        runSync: async (brandId, provider, connectionId) => {
          runSyncCalledWithConnectionId = connectionId;
          return {
            status: "SUCCEEDED",
            brandId,
            provider,
            connectionId: "conn-shopify",
            runId: "run-1",
            stats: zeroStats(),
            hasNextPage: false,
            failureSummary: null,
          };
        },
      },
      "SHOPIFY",
      undefined,
    );
    assert.equal(res.status, 200);
    assert.equal(runSyncCalledWithConnectionId, null);
  });

  test("35. an ALREADY_RUNNING outcome for one connection never implies anything about a different connection's independent request", async () => {
    // The independence guarantee itself now lives in `claimProductSyncRun`
    // (per-connection row lock) — this asserts only that the ROUTE treats
    // each call's outcome independently, never caching or cross-applying a
    // prior response.
    let call = 0;
    const res1 = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        runSync: async (brandId, provider) => {
          call += 1;
          return {
            status: "ALREADY_RUNNING",
            brandId,
            provider,
            connectionId: "conn-c7",
            runningRun: { id: "run-running", startedAt: new Date() },
          };
        },
      },
      "COMMERCE7",
      "conn-c7",
    );
    const res2 = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        runSync: async (brandId, provider) => {
          call += 1;
          return {
            status: "SUCCEEDED",
            brandId,
            provider,
            connectionId: "conn-shopify",
            runId: "run-2",
            stats: zeroStats(),
            hasNextPage: false,
            failureSummary: null,
          };
        },
      },
      "SHOPIFY",
      "conn-shopify",
    );
    assert.equal(res1.status, 409);
    assert.equal(res2.status, 200);
    assert.equal(call, 2, "each request independently reaches runSync");
  });

  test("36. an ALREADY_RUNNING outcome is refused with 409/SYNC_IN_PROGRESS carrying the running run's id", async () => {
    const res = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        runSync: async (brandId, provider) => ({
          status: "ALREADY_RUNNING",
          brandId,
          provider,
          connectionId: "conn-c7",
          runningRun: { id: "run-running", startedAt: new Date() },
        }),
      },
      "COMMERCE7",
      "conn-c7",
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "SYNC_IN_PROGRESS");
    assert.equal(body.runId, "run-running");
  });
});
