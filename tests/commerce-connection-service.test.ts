/**
 * tests/commerce-connection-service.test.ts
 *
 * Unit tests for the provider-neutral commerce connection SERVICE
 * (`src/lib/commerce/connection-service.ts`), which is built on top of the
 * Phase-1 legacy/neutral compatibility layer already covered by
 * `tests/commerce-connection-compatibility.test.ts`
 * (`src/lib/commerce/connection-resolver.ts` / `connection-sync.ts`).
 *
 * No real DB, no real network anywhere in this file — every DB-backed
 * dependency is injected as a hand-rolled in-memory fake (same idiom as
 * `commerce-connection-compatibility.test.ts`'s fixtures).
 *
 * Covered cases (numbered to match the Phase-2 review checklist):
 *  1.  getActiveCommerceConnection prefers the CommerceConnection row when it agrees with legacy truth.
 *  2.  getActiveCommerceConnection falls back to legacy when the row's externalAccountId disagrees
 *      with Brand.shopifyShopDomain, and reports drift via detectConnectionDrift.
 *  3.  getActiveCommerceConnection falls back to legacy when no row exists (id === null, isLegacyFallback === true).
 *  4.  getActiveCommerceConnection returns null for a brand with no commerce connection at all.
 *  5.  A read through any exported lookup performs ZERO writes — asserted against a fake "prisma"
 *      whose create/update/upsert/delete methods throw if ever called.
 *  6.  Multiple connections for one provider: deterministic selection matching pickPreferredConnectionRow.
 *  7.  getPrimaryCommerceConnection returns the primary; falls back to legacy when none is marked primary.
 *  8.  getCommerceCapabilities / getAdapterForConnection: SHOPIFY resolves; COMMERCE7 is controlled
 *      (getCommerceCapabilities returns all-false, never throws; getAdapterForConnection throws
 *      UnsupportedProviderError, never a network call).
 *  9.  isConnectionUsable / connectionRequiresReconnect reproduce today's exact semantics across
 *      CONNECTED / DISCONNECTED / UNINSTALLED / REQUIRES_RECONNECT / no-domain summaries.
 *  10. toSafeConnectionSummary output, JSON.stringify'd, never matches /token|secret|encrypted|password/i.
 *  11. Task-2 cut-over call sites: isLegacyShopifyBrandConnectionUsable / externalAccountIdFromShopDomain /
 *      deriveShopifyStorefrontUrl reproduce the exact old direct-field decisions for
 *      connected / disconnected / uninstalled / requires-reconnect / no-domain brands.
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
  detectConnectionDrift,
  getCommerceCapabilities,
  getAdapterForConnection,
  isConnectionUsable,
  connectionRequiresReconnect,
  toSafeConnectionSummary,
  deriveShopifyStorefrontUrl,
  type CommerceConnectionServiceDeps,
  type BatchCommerceConnectionServiceDeps,
  type CommerceConnectionRow,
  type LegacyBrandShopifyFields,
} from "../src/lib/commerce/connection-service";
import { UnsupportedProviderError } from "../src/lib/commerce/errors";
import { ShopifyCommerceAdapter } from "../src/lib/commerce/providers/shopify-commerce-adapter";
import type { CommerceConnectionSummary } from "../src/lib/commerce/types";

// ---------------------------------------------------------------------------
// Fixture helpers (mirrors tests/commerce-connection-compatibility.test.ts)
// ---------------------------------------------------------------------------

function makeLegacyBrandFields(
  overrides: Partial<LegacyBrandShopifyFields> = {},
): LegacyBrandShopifyFields {
  return {
    id: "brand-1",
    name: "Acme",
    shopifyShopDomain: "acme.myshopify.com",
    shopifyConnectionStatus: "CONNECTED",
    shopifyInstalledAt: new Date("2026-01-01T00:00:00Z"),
    shopifyUninstalledAt: null,
    shopifyLastProductSyncAt: null,
    shopifyGrantedScopes: "read_products,write_discounts",
    shopifyCurrencyCode: "USD",
    ...overrides,
  };
}

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
 * data from in-memory arrays and whose write-shaped methods
 * (create/update/upsert/delete*) THROW if ever called. The injected
 * `CommerceConnectionServiceDeps` read functions delegate INTO this fake
 * rather than reading the in-memory arrays directly, so test 5 genuinely
 * proves the call path never reaches a write-shaped prisma method — not
 * merely that the deps type happens to have none to call.
 */
function makeFakeReadOnlyStore(options: {
  connectionRows?: CommerceConnectionRow[];
  brand?: LegacyBrandShopifyFields | null;
}) {
  const connectionRows = options.connectionRows ?? [];
  const brand = options.brand ?? null;
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
    brand: {
      findUnique: async (args: { where: { id: string } }) => {
        calls.reads += 1;
        return brand && brand.id === args.where.id ? brand : null;
      },
      update: unexpectedWrite("updates"),
      updateMany: unexpectedWrite("updates"),
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
    findLegacyBrandFields: (brandId) => fakePrisma.brand.findUnique({ where: { id: brandId } }),
  };

  return { deps, calls };
}

// ---------------------------------------------------------------------------
// 1-4: getActiveCommerceConnection consistency-checked preference
// ---------------------------------------------------------------------------

describe("getActiveCommerceConnection — consistency-checked preference", () => {
  test("1. prefers the CommerceConnection row when it agrees with legacy truth", async () => {
    const row = makeConnectionRow({ id: "conn-real", displayName: "real-connection" });
    const legacy = makeLegacyBrandFields();

    const result = await getActiveCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [row],
      findLegacyBrandFields: async () => legacy,
    });

    assert.ok(result);
    assert.equal(result?.id, "conn-real");
    assert.equal(result?.isLegacyFallback, false);
    assert.equal(result?.displayName, "real-connection");

    const drift = await detectConnectionDrift("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [row],
      findLegacyBrandFields: async () => legacy,
    });
    assert.equal(drift.driftDetected, false);
  });

  test("2. PHASE 14B.4B: the CANONICAL row wins even when it disagrees with Brand.shopifyShopDomain — legacy never overrides canonical — drift is still reported for a reconciliation tool", async () => {
    // A stale Brand mirror must never override, or disagree-with-and-win
    // over, canonical truth (see connection-service.ts's file header for
    // why this inverted the pre-14B.4B "legacy wins on disagreement"
    // behavior — CommerceConnection is written BEFORE Brand.shopify* as of
    // Phase 14B, so it is `Brand` that can lag, not the row).
    const staleRow = makeConnectionRow({
      id: "conn-stale",
      externalAccountId: "old-shop.myshopify.com",
    });
    const legacy = makeLegacyBrandFields({ shopifyShopDomain: "new-shop.myshopify.com" });

    const deps = {
      findConnectionRows: async () => [staleRow],
      findLegacyBrandFields: async () => legacy,
    };

    const result = await getActiveCommerceConnection("brand-1", CommerceProvider.SHOPIFY, deps);
    assert.ok(result);
    assert.equal(result?.isLegacyFallback, false);
    assert.equal(result?.id, "conn-stale");
    assert.equal(result?.externalAccountId, "old-shop.myshopify.com");

    // The disagreement is still surfaced for a reconciliation tool — it just
    // no longer changes which connection is authoritative.
    const drift = await detectConnectionDrift("brand-1", CommerceProvider.SHOPIFY, deps);
    assert.equal(drift.driftDetected, true);
    if (drift.driftDetected) {
      assert.equal(drift.reason, "ROW_LEGACY_MISMATCH");
      assert.equal(drift.rowExternalAccountId, "old-shop.myshopify.com");
      assert.equal(drift.legacyExternalAccountId, "new-shop.myshopify.com");
    }
  });

  test("2b. mismatch is also detected case/whitespace-insensitively (both sides normalized before comparison)", async () => {
    const row = makeConnectionRow({ externalAccountId: "acme.myshopify.com" });
    const legacy = makeLegacyBrandFields({ shopifyShopDomain: "  ACME.MyShopify.com  " });

    const result = await getActiveCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [row],
      findLegacyBrandFields: async () => legacy,
    });

    // Normalized values agree -> the row is trusted, no drift.
    assert.equal(result?.isLegacyFallback, false);
    assert.equal(result?.id, row.id);
  });

  // PHASE 14C-A: this used to assert a legacy-derived fallback summary
  // (id: null, isLegacyFallback: true) — that fallback was removed
  // entirely (operator-verified: no live merchant needs it), so
  // `getActiveCommerceConnection` now returns bare `null` here.
  // `detectConnectionDrift` is UNCHANGED — it remains a diagnostic-only
  // comparison against the legacy Brand row for the pre-column-drop
  // reconciliation tool, and still reports LEGACY_DOMAIN_WITHOUT_ROW.
  test("3. no row exists -> null, no legacy fallback (detectConnectionDrift still reports it for reconciliation)", async () => {
    const legacy = makeLegacyBrandFields();

    const result = await getActiveCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [],
    });

    assert.equal(result, null);

    const drift = await detectConnectionDrift("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [],
      findLegacyBrandFields: async () => legacy,
    });
    assert.equal(drift.driftDetected, true);
    if (drift.driftDetected) {
      assert.equal(drift.reason, "LEGACY_DOMAIN_WITHOUT_ROW");
    }
  });

  test("3b. PHASE 14B.4B: a row exists but legacy has no domain on record -> the row STILL wins (legacy no longer overrides), drift still reported", async () => {
    // A Brand row with no domain (e.g. redacted, or relinked away since the
    // canonical row was written) must not erase a genuinely live canonical
    // connection — that would be exactly the "stale Brand mirror overrides
    // canonical" bug this phase closes.
    const row = makeConnectionRow();
    const legacy = makeLegacyBrandFields({ shopifyShopDomain: null });

    const result = await getActiveCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [row],
      findLegacyBrandFields: async () => legacy,
    });
    assert.ok(result);
    assert.equal(result?.id, row.id);
    assert.equal(result?.isLegacyFallback, false);

    const drift = await detectConnectionDrift("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [row],
      findLegacyBrandFields: async () => legacy,
    });
    assert.equal(drift.driftDetected, true);
    if (drift.driftDetected) {
      assert.equal(drift.reason, "ROW_WITHOUT_LEGACY_DOMAIN");
    }
  });

  test("4. returns null for a brand with no commerce connection at all (both sides absent) — not drift", async () => {
    const result = await getActiveCommerceConnection("brand-none", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [],
      findLegacyBrandFields: async () => null,
    });
    assert.equal(result, null);

    const drift = await detectConnectionDrift("brand-none", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [],
      findLegacyBrandFields: async () => null,
    });
    assert.equal(drift.driftDetected, false);
  });

  test("4b. COMMERCE7 has no legacy fallback: a row is trusted as-is, no drift concept applies", async () => {
    const row = makeConnectionRow({ provider: CommerceProvider.COMMERCE7, id: "conn-c7" });

    const result = await getActiveCommerceConnection("brand-1", CommerceProvider.COMMERCE7, {
      findConnectionRows: async () => [row],
      findLegacyBrandFields: async () => {
        throw new Error("must not be called for a non-SHOPIFY provider");
      },
    });
    assert.equal(result?.id, "conn-c7");

    const noRowResult = await getActiveCommerceConnection("brand-2", CommerceProvider.COMMERCE7, {
      findConnectionRows: async () => [],
      findLegacyBrandFields: async () => {
        throw new Error("must not be called for a non-SHOPIFY provider");
      },
    });
    assert.equal(noRowResult, null);
  });
});

// ---------------------------------------------------------------------------
// 5: reads never write
// ---------------------------------------------------------------------------

describe("reads never write", () => {
  test("5. getActiveCommerceConnection / getPrimaryCommerceConnection / getCommerceConnectionById / detectConnectionDrift never call a write-shaped prisma method", async () => {
    const row = makeConnectionRow();
    const legacy = makeLegacyBrandFields();
    const { deps, calls } = makeFakeReadOnlyStore({
      connectionRows: [row],
      brand: legacy,
    });

    await getActiveCommerceConnection("brand-1", CommerceProvider.SHOPIFY, deps);
    await getPrimaryCommerceConnection("brand-1", CommerceProvider.SHOPIFY, deps);
    await getCommerceConnectionById("conn-1", deps);
    await detectConnectionDrift("brand-1", CommerceProvider.SHOPIFY, deps);

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
      findLegacyBrandFields: async () => makeLegacyBrandFields(),
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
  test("7a. returns the row marked isPrimary when it agrees with legacy", async () => {
    const primary = makeConnectionRow({ id: "conn-primary", isPrimary: true });
    const nonPrimary = makeConnectionRow({ id: "conn-other", isPrimary: false });

    const result = await getPrimaryCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [primary, nonPrimary],
      findLegacyBrandFields: async () => makeLegacyBrandFields(),
    });

    assert.equal(result?.id, "conn-primary");
  });

  // PHASE 14C-A: no legacy fallback — a brand with a row but no primary
  // mark now simply has no primary connection, full stop.
  test("7b. returns null when no row is marked primary (no legacy fallback)", async () => {
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
    assert.equal(capabilities.canSyncProducts, true);
    assert.equal(capabilities.canCreateDiscount, true);
    assert.equal(capabilities.canVerifyWebhooks, true);
  });

  test("8b. COMMERCE7 returns an all-false CommerceCapabilities, never throws", () => {
    const capabilities = getCommerceCapabilities(CommerceProvider.COMMERCE7);
    assert.deepEqual(capabilities, {
      canSyncProducts: false,
      canCreateDiscount: false,
      canRevokeDiscount: false,
      canVerifyWebhooks: false,
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
      isLegacyFallback: false,
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
      isLegacyFallback: false,
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
    isLegacyFallback: false,
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
// PHASE 14C-A: `isLegacyShopifyBrandConnectionUsable` and
// `externalAccountIdFromShopDomain` were deleted from connection-service.ts
// — both were confirmed dead in production (zero real call sites; every
// consumer already migrated to the canonical path in an earlier phase) and
// existed only to preserve legacy-fallback gate/domain-read parity that no
// runtime code needs anymore. Their tests are removed with them.
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
// canonical-only, no legacy Brand fallback (operator-verified: every live
// Shopify install already has a canonical row). Tests C/D/E/F/K from the
// original Phase 14B.4C suite specifically proved canonical-wins-over-stale-
// legacy precedence — with the legacy branch deleted entirely, there is no
// longer a second value for canonical to "win" against, so those tests are
// removed rather than kept as dead weight. The still-live invariants (no
// N+1, cross-brand isolation, COMMERCE7 exclusion, dedup, fail-closed on
// throw) are preserved below.
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
// PHASE 14B.4C — recordCommerceConnectionCurrencyCode (currency self-heal write-back)
// ---------------------------------------------------------------------------

describe("recordCommerceConnectionCurrencyCode — canonical currency self-heal", () => {
  test("M. merges the new currencyCode into existing providerMetadata without dropping other keys", async () => {
    let written: Record<string, unknown> | null = null;
    await recordCommerceConnectionCurrencyCode("conn-1", "EUR", {
      findProviderMetadata: async () => ({ authMode: "EXPIRING_OFFLINE", currencyCode: null }),
      updateProviderMetadata: async (_id, metadata) => {
        written = metadata;
      },
    });
    assert.deepEqual(written, { authMode: "EXPIRING_OFFLINE", currencyCode: "EUR" });
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
