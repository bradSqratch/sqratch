/**
 * tests/commerce-connection-service.test.ts
 *
 * Unit tests for the provider-neutral commerce connection SERVICE
 * (`src/lib/commerce/connection-service.ts`).
 *
 * PHASE 14C-B1: the legacy/diagnostic comparison machinery this file used to
 * cover (`detectConnectionDrift`, `findLegacyBrandFields`,
 * `LegacyBrandShopifyFields`) was removed from `connection-service.ts` along
 * with the pre-column-drop reconciliation tool it existed solely to serve.
 * `CommerceConnection` is the sole runtime authority with no comparison
 * value left to test against — the tests below reflect that directly rather
 * than asserting against a removed drift-reporting API.
 *
 * No real DB, no real network anywhere in this file — every DB-backed
 * dependency is injected as a hand-rolled in-memory fake.
 *
 * Covered cases (numbered to match the Phase-2 review checklist):
 *  1.  getActiveCommerceConnection returns the CommerceConnection row as-is (canonical-only, no comparison).
 *  3.  getActiveCommerceConnection returns null when no row exists.
 *  4.  getActiveCommerceConnection returns null for a brand with no commerce connection at all.
 *  5.  A read through any exported lookup performs ZERO writes — asserted against a fake "prisma"
 *      whose create/update/upsert/delete methods throw if ever called.
 *  6.  Multiple connections for one provider: deterministic selection matching pickPreferredConnectionRow.
 *  7.  getPrimaryCommerceConnection returns the primary; returns null when none is marked primary.
 *  8.  getCommerceCapabilities / getAdapterForConnection: SHOPIFY resolves; COMMERCE7 is controlled
 *      (getCommerceCapabilities returns all-false, never throws; getAdapterForConnection throws
 *      UnsupportedProviderError, never a network call).
 *  9.  isConnectionUsable / connectionRequiresReconnect reproduce today's exact semantics across
 *      CONNECTED / DISCONNECTED / UNINSTALLED / REQUIRES_RECONNECT / no-domain summaries.
 *  10. toSafeConnectionSummary output, JSON.stringify'd, never matches /token|secret|encrypted|password/i.
 *  11. deriveShopifyStorefrontUrl reproduces the exact old direct-field decision for present/absent domains.
 */

process.env.APP_ENCRYPTION_KEY ||= "test-encryption-key-for-commerce-service-tests";

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CommerceProvider } from "@prisma/client";

import {
  getActiveCommerceConnection,
  getActiveCommerceConnectionsForBrands,
  recordCommerceConnectionCurrencyCode,
  getCommerceConnectionById,
  getPrimaryCommerceConnection,
  getCommerceCapabilities,
  getAdapterForConnection,
  isConnectionUsable,
  connectionRequiresReconnect,
  toSafeConnectionSummary,
  deriveShopifyStorefrontUrl,
  type CommerceConnectionServiceDeps,
  type BatchCommerceConnectionServiceDeps,
  type CommerceConnectionRow,
} from "../src/lib/commerce/connection-service";
import { UnsupportedProviderError } from "../src/lib/commerce/errors";
import { ShopifyCommerceAdapter } from "../src/lib/commerce/providers/shopify-commerce-adapter";
import type { CommerceConnectionSummary } from "../src/lib/commerce/types";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makeConnectionRow(
  overrides: Partial<CommerceConnectionRow> = {},
): CommerceConnectionRow {
  return {
    id: "conn-1",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED",
    displayName: "acme",
    externalAccountId: "acme.myshopify.com",
    storefrontUrl: "https://acme.myshopify.com",
    isPrimary: true,
    grantedScopes: ["read_products"],
    installedAt: new Date("2026-01-01T00:00:00Z"),
    uninstalledAt: null,
    lastProductSyncAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    providerMetadata: { authMode: "LEGACY_OFFLINE", currencyCode: "USD" },
    ...overrides,
  };
}

/**
 * A minimal fake "prisma" whose read methods (findMany/findUnique) serve
 * data from an in-memory array and whose write-shaped methods
 * (create/update/upsert/delete*) THROW if ever called. The injected
 * `CommerceConnectionServiceDeps` read functions delegate INTO this fake
 * rather than reading the in-memory array directly, so test 5 genuinely
 * proves the call path never reaches a write-shaped prisma method — not
 * merely that the deps type happens to have none to call.
 */
function makeFakeReadOnlyStore(options: { connectionRows?: CommerceConnectionRow[] }) {
  const connectionRows = options.connectionRows ?? [];
  const calls = { reads: 0, creates: 0, updates: 0, upserts: 0, deletes: 0 };

  function unexpectedWrite(kind: keyof typeof calls): () => never {
    return () => {
      calls[kind] += 1;
      throw new Error(`unexpected write via prisma.* (${kind})`);
    };
  }

  const fakePrisma = {
    commerceConnection: {
      findMany: async (args: { where: { brandId: string; provider: CommerceProvider } }) => {
        calls.reads += 1;
        return connectionRows.filter(
          (row) => row.brandId === args.where.brandId && row.provider === args.where.provider,
        );
      },
      findUnique: async (args: { where: { id: string } }) => {
        calls.reads += 1;
        return connectionRows.find((row) => row.id === args.where.id) ?? null;
      },
      create: unexpectedWrite("creates"),
      update: unexpectedWrite("updates"),
      updateMany: unexpectedWrite("updates"),
      upsert: unexpectedWrite("upserts"),
      delete: unexpectedWrite("deletes"),
      deleteMany: unexpectedWrite("deletes"),
    },
  };

  // Deliberately `Partial<CommerceConnectionServiceDeps>` — omits `registry`
  // entirely rather than stubbing it with an unsafe cast, since none of the
  // read-path functions under test in this suite touch it (only
  // `getCommerceCapabilities` / `getAdapterForConnection` do, and those are
  // covered separately in the "capabilities / adapter access" suite below).
  const deps: Partial<CommerceConnectionServiceDeps> = {
    findConnectionRows: (brandId, provider) =>
      fakePrisma.commerceConnection.findMany({ where: { brandId, provider } }),
    findConnectionRowById: (connectionId) =>
      fakePrisma.commerceConnection.findUnique({ where: { id: connectionId } }),
  };

  return { deps, calls };
}

// ---------------------------------------------------------------------------
// 1, 3, 4: getActiveCommerceConnection — canonical-only, no comparison
// ---------------------------------------------------------------------------

describe("getActiveCommerceConnection — canonical-only", () => {
  test("1. returns the CommerceConnection row as-is", async () => {
    const row = makeConnectionRow({ id: "conn-real", displayName: "real-connection" });

    const result = await getActiveCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [row],
    });

    assert.ok(result);
    assert.equal(result?.id, "conn-real");
    assert.equal(result?.displayName, "real-connection");
  });

  // No canonical row means no connection.
  test("3. no row exists -> null", async () => {
    const result = await getActiveCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [],
    });

    assert.equal(result, null);
  });

  test("4. returns null for a brand with no commerce connection at all", async () => {
    const result = await getActiveCommerceConnection("brand-none", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [],
    });
    assert.equal(result, null);
  });

  test("4b. COMMERCE7: a row is trusted as-is; no row is null", async () => {
    const row = makeConnectionRow({ provider: CommerceProvider.COMMERCE7, id: "conn-c7" });

    const result = await getActiveCommerceConnection("brand-1", CommerceProvider.COMMERCE7, {
      findConnectionRows: async () => [row],
    });
    assert.equal(result?.id, "conn-c7");

    const noRowResult = await getActiveCommerceConnection("brand-2", CommerceProvider.COMMERCE7, {
      findConnectionRows: async () => [],
    });
    assert.equal(noRowResult, null);
  });
});

// ---------------------------------------------------------------------------
// 5: reads never write
// ---------------------------------------------------------------------------

describe("reads never write", () => {
  test("5. getActiveCommerceConnection / getPrimaryCommerceConnection / getCommerceConnectionById never call a write-shaped prisma method", async () => {
    const row = makeConnectionRow();
    const { deps, calls } = makeFakeReadOnlyStore({ connectionRows: [row] });

    await getActiveCommerceConnection("brand-1", CommerceProvider.SHOPIFY, deps);
    await getPrimaryCommerceConnection("brand-1", CommerceProvider.SHOPIFY, deps);
    await getCommerceConnectionById("conn-1", deps);

    assert.ok(calls.reads > 0, "sanity: the fake store was actually exercised");
    assert.equal(calls.creates, 0);
    assert.equal(calls.updates, 0);
    assert.equal(calls.upserts, 0);
    assert.equal(calls.deletes, 0);
  });
});

// ---------------------------------------------------------------------------
// 6: deterministic multi-row selection
// ---------------------------------------------------------------------------

describe("deterministic multi-connection selection", () => {
  test("6. among several rows for one provider, the same row pickPreferredConnectionRow would choose wins", async () => {
    const nonPrimaryNewer = makeConnectionRow({
      id: "conn-nonprimary-newer",
      isPrimary: false,
      installedAt: new Date("2026-02-01T00:00:00Z"),
    });
    const primaryOlder = makeConnectionRow({
      id: "conn-primary-older",
      isPrimary: true,
      installedAt: new Date("2026-01-01T00:00:00Z"),
    });

    const result = await getActiveCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [nonPrimaryNewer, primaryOlder],
    });

    // isPrimary wins over more-recent installedAt — same tiebreak as
    // pickPreferredConnectionRow (connection-resolver.ts).
    assert.equal(result?.id, "conn-primary-older");
  });
});

// ---------------------------------------------------------------------------
// 7: getPrimaryCommerceConnection
// ---------------------------------------------------------------------------

describe("getPrimaryCommerceConnection", () => {
  test("7a. returns the row marked isPrimary", async () => {
    const primary = makeConnectionRow({ id: "conn-primary", isPrimary: true });
    const nonPrimary = makeConnectionRow({ id: "conn-other", isPrimary: false });

    const result = await getPrimaryCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [primary, nonPrimary],
    });

    assert.equal(result?.id, "conn-primary");
  });

  test("7b. returns null when no row is marked primary", async () => {
    const nonPrimary = makeConnectionRow({ id: "conn-other", isPrimary: false });

    const result = await getPrimaryCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [nonPrimary],
    });

    assert.equal(result, null);
  });

  test("7c. returns null when nothing is marked primary and there is no connection at all", async () => {
    const result = await getPrimaryCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [],
    });

    assert.equal(result, null);
  });
});

// ---------------------------------------------------------------------------
// 8: capabilities / adapter access
// ---------------------------------------------------------------------------

describe("getCommerceCapabilities / getAdapterForConnection", () => {
  test("8a. SHOPIFY resolves capabilities without throwing", () => {
    const capabilities = getCommerceCapabilities(CommerceProvider.SHOPIFY);
    assert.equal(capabilities.products.sync, true);
    assert.equal(capabilities.rewards.create, true);
  });

  test("8b. COMMERCE7 returns an all-false CommerceCapabilities, never throws", () => {
    const capabilities = getCommerceCapabilities(CommerceProvider.COMMERCE7);
    assert.deepEqual(capabilities, {
      products: { sync: false, publicDestinations: false },
      rewards: {
        create: false,
        lookup: false,
        usageLookup: false,
        revoke: false,
        fixedAmount: false,
        percentage: false,
        minimumSubtotal: false,
        productSpecific: false,
        singleUse: false,
      },
    });
  });

  test("8c. getAdapterForConnection resolves a real ShopifyCommerceAdapter for SHOPIFY, with no I/O", () => {
    const summary: CommerceConnectionSummary = {
      id: "conn-1",
      brandId: "brand-1",
      provider: CommerceProvider.SHOPIFY,
      status: "CONNECTED",
      displayName: "acme",
      externalAccountId: "acme.myshopify.com",
      storefrontUrl: "https://acme.myshopify.com",
      isPrimary: true,
      grantedScopes: [],
      installedAt: null,
      uninstalledAt: null,
      lastProductSyncAt: null,
      currencyCode: null,
    };

    const adapter = getAdapterForConnection(summary);
    assert.ok(adapter instanceof ShopifyCommerceAdapter);
    assert.equal(adapter.provider, CommerceProvider.SHOPIFY);
  });

  test("8d. getAdapterForConnection throws UnsupportedProviderError for COMMERCE7, never a network call", () => {
    const summary: CommerceConnectionSummary = {
      id: "conn-1",
      brandId: "brand-1",
      provider: CommerceProvider.COMMERCE7,
      status: "CONNECTED",
      displayName: "acme",
      externalAccountId: "acme-c7",
      storefrontUrl: null,
      isPrimary: true,
      grantedScopes: [],
      installedAt: null,
      uninstalledAt: null,
      lastProductSyncAt: null,
      currencyCode: null,
    };

    assert.throws(() => getAdapterForConnection(summary), UnsupportedProviderError);
  });
});

// ---------------------------------------------------------------------------
// 9: status predicates
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<CommerceConnectionSummary> = {}): CommerceConnectionSummary {
  return {
    id: "conn-1",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED",
    displayName: "acme",
    externalAccountId: "acme.myshopify.com",
    storefrontUrl: "https://acme.myshopify.com",
    isPrimary: true,
    grantedScopes: [],
    installedAt: null,
    uninstalledAt: null,
    lastProductSyncAt: null,
    currencyCode: null,
    ...overrides,
  };
}

describe("isConnectionUsable / connectionRequiresReconnect", () => {
  test("9a. CONNECTED with a domain is usable, does not require reconnect", () => {
    const summary = makeSummary({ status: "CONNECTED" });
    assert.equal(isConnectionUsable(summary), true);
    assert.equal(connectionRequiresReconnect(summary), false);
  });

  test("9b. DISCONNECTED is not usable, does not require reconnect", () => {
    const summary = makeSummary({ status: "DISCONNECTED" });
    assert.equal(isConnectionUsable(summary), false);
    assert.equal(connectionRequiresReconnect(summary), false);
  });

  test("9c. UNINSTALLED is not usable, does not require reconnect", () => {
    const summary = makeSummary({ status: "UNINSTALLED" });
    assert.equal(isConnectionUsable(summary), false);
    assert.equal(connectionRequiresReconnect(summary), false);
  });

  test("9d. REQUIRES_RECONNECT is not usable, and requires reconnect", () => {
    const summary = makeSummary({ status: "REQUIRES_RECONNECT" });
    assert.equal(isConnectionUsable(summary), false);
    assert.equal(connectionRequiresReconnect(summary), true);
  });

  test("9e. a CONNECTED summary with an empty externalAccountId is not usable (defensive no-op leg)", () => {
    const summary = makeSummary({ status: "CONNECTED", externalAccountId: "   " });
    assert.equal(isConnectionUsable(summary), false);
  });
});

// ---------------------------------------------------------------------------
// 10: no credential ever leaks through toSafeConnectionSummary
// ---------------------------------------------------------------------------

describe("toSafeConnectionSummary", () => {
  test("10. is an identity function, and its JSON never matches a credential-shaped pattern", () => {
    const summary = makeSummary({ grantedScopes: ["read_products", "write_discounts"] });
    const safe = toSafeConnectionSummary(summary);

    assert.deepEqual(safe, summary);

    const serialized = JSON.stringify(safe);
    assert.doesNotMatch(serialized, /token|secret|encrypted|password/i);
  });
});

// ---------------------------------------------------------------------------
// 11: deriveShopifyStorefrontUrl — rewards/shopify/redemptions shopUrl parity
// ---------------------------------------------------------------------------

describe("deriveShopifyStorefrontUrl — rewards/shopify/redemptions shopUrl parity", () => {
  test("11h. matches the exact original ternary for a present domain", () => {
    const domain = "acme.myshopify.com";
    assert.equal(deriveShopifyStorefrontUrl(domain), `https://${domain}`);
  });

  test("11i. null domain -> null shopUrl", () => {
    assert.equal(deriveShopifyStorefrontUrl(null), null);
  });
});

// ---------------------------------------------------------------------------
// getActiveCommerceConnectionsForBrands (batch resolver) — PHASE 14C-A:
// canonical-only, no legacy Brand fallback.
// ---------------------------------------------------------------------------

function makeBatchDeps(options: {
  rowsByBrand?: Record<string, CommerceConnectionRow[]>;
}): { deps: BatchCommerceConnectionServiceDeps; calls: { rowQueries: number } } {
  const rowsByBrand = options.rowsByBrand ?? {};
  const calls = { rowQueries: 0 };

  return {
    calls,
    deps: {
      findConnectionRowsForBrands: async (brandIds, provider) => {
        calls.rowQueries += 1;
        const rows: CommerceConnectionRow[] = [];
        for (const brandId of brandIds) {
          for (const row of rowsByBrand[brandId] ?? []) {
            if (row.provider === provider) {
              rows.push(row);
            }
          }
        }
        return rows;
      },
    },
  };
}

describe("getActiveCommerceConnectionsForBrands — batch canonical resolution", () => {
  test("A. resolves canonical rows for many brands in exactly ONE underlying query (no N+1); a brand with no row is simply absent", async () => {
    const { deps, calls } = makeBatchDeps({
      rowsByBrand: {
        "brand-1": [makeConnectionRow({ id: "conn-1", brandId: "brand-1" })],
        "brand-2": [makeConnectionRow({ id: "conn-2", brandId: "brand-2", externalAccountId: "b2.myshopify.com" })],
      },
    });

    const result = await getActiveCommerceConnectionsForBrands(
      ["brand-1", "brand-2", "brand-3"],
      CommerceProvider.SHOPIFY,
      deps,
    );

    assert.equal(result.size, 2);
    assert.equal(result.get("brand-1")?.id, "conn-1");
    assert.equal(result.get("brand-2")?.id, "conn-2");
    assert.equal(result.has("brand-3"), false);
    // One batched CommerceConnection query — never one per brand, regardless
    // of how many brand ids were passed.
    assert.equal(calls.rowQueries, 1);
  });

  test("G. no cross-brand leakage: brand A's connection row never appears under brand B's map key", async () => {
    const { deps } = makeBatchDeps({
      rowsByBrand: {
        "brand-a": [makeConnectionRow({ id: "conn-a", brandId: "brand-a", externalAccountId: "a.myshopify.com" })],
        "brand-b": [makeConnectionRow({ id: "conn-b", brandId: "brand-b", externalAccountId: "b.myshopify.com" })],
      },
    });

    const result = await getActiveCommerceConnectionsForBrands(["brand-a", "brand-b"], CommerceProvider.SHOPIFY, deps);
    assert.equal(result.get("brand-a")?.externalAccountId, "a.myshopify.com");
    assert.equal(result.get("brand-b")?.externalAccountId, "b.myshopify.com");
    assert.notEqual(result.get("brand-a")?.id, result.get("brand-b")?.id);
  });

  test("H. a COMMERCE7 row cannot satisfy a SHOPIFY lookup, and vice versa", async () => {
    const { deps } = makeBatchDeps({
      rowsByBrand: {
        "brand-1": [makeConnectionRow({ id: "conn-c7", brandId: "brand-1", provider: CommerceProvider.COMMERCE7 })],
      },
    });

    const shopifyResult = await getActiveCommerceConnectionsForBrands(["brand-1"], CommerceProvider.SHOPIFY, deps);
    assert.equal(shopifyResult.has("brand-1"), false);

    const commerce7Result = await getActiveCommerceConnectionsForBrands(["brand-1"], CommerceProvider.COMMERCE7, deps);
    assert.equal(commerce7Result.get("brand-1")?.id, "conn-c7");
  });

  test("I. a brand with no canonical row at all is simply absent from the result map", async () => {
    const { deps } = makeBatchDeps({});
    const result = await getActiveCommerceConnectionsForBrands(["brand-ghost"], CommerceProvider.SHOPIFY, deps);
    assert.equal(result.has("brand-ghost"), false);
  });

  test("J. an empty brandIds array short-circuits to an empty map without querying anything", async () => {
    const { deps, calls } = makeBatchDeps({});
    const result = await getActiveCommerceConnectionsForBrands([], CommerceProvider.SHOPIFY, deps);
    assert.equal(result.size, 0);
    assert.equal(calls.rowQueries, 0);
  });

  test("K. a throw from the batched row query fails closed to an empty result rather than throwing (\"unknown\" is never upgraded to \"connected\")", async () => {
    const deps: BatchCommerceConnectionServiceDeps = {
      findConnectionRowsForBrands: async () => {
        throw new Error("transient DB outage");
      },
    };

    const result = await getActiveCommerceConnectionsForBrands(["brand-1"], CommerceProvider.SHOPIFY, deps);
    assert.equal(result.has("brand-1"), false);
  });

  test("L. duplicate brand ids in the input are deduplicated before querying", async () => {
    const { deps, calls } = makeBatchDeps({
      rowsByBrand: { "brand-1": [makeConnectionRow({ id: "conn-1", brandId: "brand-1" })] },
    });
    const result = await getActiveCommerceConnectionsForBrands(
      ["brand-1", "brand-1", "brand-1"],
      CommerceProvider.SHOPIFY,
      deps,
    );
    assert.equal(result.size, 1);
    assert.equal(calls.rowQueries, 1);
  });
});

// ---------------------------------------------------------------------------
// recordCommerceConnectionCurrencyCode (currency self-heal write-back)
// ---------------------------------------------------------------------------

describe("recordCommerceConnectionCurrencyCode — canonical currency self-heal", () => {
  test("M. merges the new currencyCode while removing the retired authMode projection", async () => {
    let written: Record<string, unknown> | null = null;
    await recordCommerceConnectionCurrencyCode("conn-1", "EUR", {
      findProviderMetadata: async () => ({ authMode: "EXPIRING_OFFLINE", currencyCode: null }),
      updateProviderMetadata: async (_id, metadata) => {
        written = metadata;
      },
    });
    assert.deepEqual(written, { currencyCode: "EUR" });
  });

  test("N. a null/missing existing providerMetadata still produces a valid write with just the currency", async () => {
    let written: Record<string, unknown> | null = null;
    await recordCommerceConnectionCurrencyCode("conn-1", "USD", {
      findProviderMetadata: async () => null,
      updateProviderMetadata: async (_id, metadata) => {
        written = metadata;
      },
    });
    assert.deepEqual(written, { currencyCode: "USD" });
  });
});
