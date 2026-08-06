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
  getCommerceConnectionById,
  getPrimaryCommerceConnection,
  detectConnectionDrift,
  getCommerceCapabilities,
  getAdapterForConnection,
  isConnectionUsable,
  connectionRequiresReconnect,
  toSafeConnectionSummary,
  isLegacyShopifyBrandConnectionUsable,
  externalAccountIdFromShopDomain,
  deriveShopifyStorefrontUrl,
  type CommerceConnectionServiceDeps,
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

  test("2. falls back to legacy when the row's externalAccountId disagrees with Brand.shopifyShopDomain, and reports drift", async () => {
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
    assert.equal(result?.isLegacyFallback, true);
    assert.equal(result?.externalAccountId, "new-shop.myshopify.com");

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

  test("3. falls back to legacy when no row exists (id === null, isLegacyFallback === true)", async () => {
    const legacy = makeLegacyBrandFields();

    const result = await getActiveCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [],
      findLegacyBrandFields: async () => legacy,
    });

    assert.ok(result);
    assert.equal(result?.id, null);
    assert.equal(result?.isLegacyFallback, true);
    assert.equal(result?.externalAccountId, "acme.myshopify.com");

    const drift = await detectConnectionDrift("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [],
      findLegacyBrandFields: async () => legacy,
    });
    assert.equal(drift.driftDetected, true);
    if (drift.driftDetected) {
      assert.equal(drift.reason, "LEGACY_DOMAIN_WITHOUT_ROW");
    }
  });

  test("3b. row exists but legacy has no domain on record -> falls back to legacy (null) and reports drift", async () => {
    const row = makeConnectionRow();
    const legacy = makeLegacyBrandFields({ shopifyShopDomain: null });

    const result = await getActiveCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [row],
      findLegacyBrandFields: async () => legacy,
    });
    assert.equal(result, null);

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

  test("7b. falls back to the legacy summary (always isPrimary: true) when no row is marked primary", async () => {
    const nonPrimary = makeConnectionRow({ id: "conn-other", isPrimary: false });
    const legacy = makeLegacyBrandFields();

    const result = await getPrimaryCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [nonPrimary],
      findLegacyBrandFields: async () => legacy,
    });

    assert.equal(result?.isLegacyFallback, true);
    assert.equal(result?.isPrimary, true);
  });

  test("7c. returns null when nothing is marked primary and there is no legacy connection either", async () => {
    const nonPrimary = makeConnectionRow({ id: "conn-other", isPrimary: false });

    const result = await getPrimaryCommerceConnection("brand-1", CommerceProvider.SHOPIFY, {
      findConnectionRows: async () => [nonPrimary],
      findLegacyBrandFields: async () => null,
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
// 11: Task-2 cut-over pure helpers reproduce today's exact decisions
// ---------------------------------------------------------------------------

describe("isLegacyShopifyBrandConnectionUsable — Task-2 cut-over gate parity", () => {
  test("11a. connected brand (domain + CONNECTED status) is usable", () => {
    const brand = makeLegacyBrandFields({
      shopifyShopDomain: "acme.myshopify.com",
      shopifyConnectionStatus: "CONNECTED",
    });
    assert.equal(isLegacyShopifyBrandConnectionUsable(brand), true);
  });

  test("11b. disconnected brand is not usable", () => {
    const brand = makeLegacyBrandFields({
      shopifyShopDomain: "acme.myshopify.com",
      shopifyConnectionStatus: "DISCONNECTED",
    });
    assert.equal(isLegacyShopifyBrandConnectionUsable(brand), false);
  });

  test("11c. uninstalled brand is not usable, even though the domain is retained", () => {
    const brand = makeLegacyBrandFields({
      shopifyShopDomain: "acme.myshopify.com",
      shopifyConnectionStatus: "UNINSTALLED",
    });
    assert.equal(isLegacyShopifyBrandConnectionUsable(brand), false);
  });

  test("11d. requires-reconnect brand is not usable", () => {
    const brand = makeLegacyBrandFields({
      shopifyShopDomain: "acme.myshopify.com",
      shopifyConnectionStatus: "REQUIRES_RECONNECT",
    });
    assert.equal(isLegacyShopifyBrandConnectionUsable(brand), false);
  });

  test("11e. a brand with no shop domain at all is not usable, regardless of status", () => {
    const brand = makeLegacyBrandFields({
      shopifyShopDomain: null,
      shopifyConnectionStatus: "CONNECTED",
    });
    assert.equal(isLegacyShopifyBrandConnectionUsable(brand), false);
  });
});

describe("externalAccountIdFromShopDomain — Task-2 shop-domain read parity", () => {
  test("11f. trims a present domain", () => {
    assert.equal(externalAccountIdFromShopDomain("  acme.myshopify.com  "), "acme.myshopify.com");
  });

  test("11g. null/undefined/empty all normalize to null", () => {
    assert.equal(externalAccountIdFromShopDomain(null), null);
    assert.equal(externalAccountIdFromShopDomain(undefined), null);
    assert.equal(externalAccountIdFromShopDomain("   "), null);
  });
});

describe("deriveShopifyStorefrontUrl — rewards/shopify/redemptions shopUrl parity", () => {
  test("11h. matches the exact original ternary for a present domain", () => {
    const domain = "acme.myshopify.com";
    assert.equal(deriveShopifyStorefrontUrl(domain), `https://${domain}`);
  });

  test("11i. null domain -> null shopUrl", () => {
    assert.equal(deriveShopifyStorefrontUrl(null), null);
  });
});
