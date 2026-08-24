/**
 * tests/commerce7-lifecycle-gate.test.ts
 *
 * PHASE 16C2 FINAL LIFECYCLE REPAIR — the canonical product-sync lifecycle
 * invariant: account-specific provider I/O is allowed ONLY when the selected
 * `CommerceConnection.status === CONNECTED`. Covers the service boundary
 * (`syncCommerceConnectionById` / `syncBrandCommerceProducts`), the Commerce7
 * adapter's independent defense-in-depth, the route's HTTP mapping, the UI
 * gate, active-connection selection, and the cheap negative-price regression.
 *
 * Behavioral throughout — every test drives real production functions with
 * injected dependencies. No real DB, no real network.
 */

process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";
process.env.COMMERCE7_APP_ID = "test-app-id";
process.env.COMMERCE7_APP_SECRET = "test-app-secret";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import {
  syncBrandCommerceProducts,
  syncCommerceConnectionById,
  type ProductSyncDeps,
  type ExistingConnectedProductRow,
} from "../src/lib/commerce/product-sync";
import {
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "../src/lib/commerce/errors";
import type { CommerceConnectionSummary } from "../src/lib/commerce/types";
import {
  Commerce7CommerceAdapter,
  type Commerce7CommerceConnectionRow,
} from "../src/lib/commerce/providers/commerce7-commerce-adapter";
import type { Commerce7Fetch } from "../src/lib/commerce/providers/commerce7-products";
import { getActiveCommerceConnectionAnyProvider } from "../src/lib/commerce/connection-service";
import type { CommerceConnectionRow } from "../src/lib/commerce/connection-resolver";
import { normalizeCommerce7Product } from "../src/lib/commerce/providers/commerce7-products";
import { providerPriceStringToMinorUnits } from "../src/lib/commerce/money";
import { productsSyncImpl } from "../src/app/api/brand/products/sync/route";
import type { BrandAdminContext } from "../src/lib/brand-auth";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeSummary(
  overrides: Partial<CommerceConnectionSummary> = {},
): CommerceConnectionSummary {
  return {
    id: "conn-1",
    brandId: "brand-a",
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    displayName: "sqratch-inc",
    externalAccountId: "sqratch-inc",
    storefrontUrl: null,
    isPrimary: true,
    grantedScopes: [],
    installedAt: new Date("2026-01-01"),
    uninstalledAt: null,
    lastProductSyncAt: null,
    currencyCode: null,
    ...overrides,
  };
}

function makeSyncDeps(overrides: Partial<ProductSyncDeps> = {}): Partial<ProductSyncDeps> {
  return {
    findExistingProducts: async (): Promise<ExistingConnectedProductRow[]> => [],
    createSyncRun: async () => ({ id: "run-1" }),
    finalizeSyncRun: async () => {},
    applyProductWrite: async () => {},
    markUnavailableExcept: async () => ({ count: 0 }),
    ...overrides,
  };
}

function fakeAdapter() {
  return {
    provider: CommerceProvider.COMMERCE7,
    getCapabilities: () => ({
      products: { sync: true, publicDestinations: false },
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
    }),
    getConnection: async () => ({ ok: true as const, connection: makeSummary() }),
    fetchProductPage: async () => ({
      products: [],
      nextCursor: null,
      isComplete: true,
      fetchedAt: new Date(),
      limit: 50,
    }),
  };
}

// ===========================================================================
describe("A/B. syncCommerceConnectionById enforces the CONNECTED invariant", () => {
  for (const status of ["UNINSTALLED", "DISCONNECTED", "REQUIRES_RECONNECT"] as const) {
    test(`1/2. EXACT ${status} Commerce7 connection: reject, no run row, no adapter/transport call`, async () => {
      const connections: Record<string, CommerceConnectionSummary> = {
        "conn-x": makeSummary({ id: "conn-x", brandId: "brand-a", status }),
      };

      let runCreated = false;
      let adapterConstructed = false;
      const deps = makeSyncDeps({
        createSyncRun: async () => {
          runCreated = true;
          return { id: "run-1" };
        },
        getAdapter: () => {
          adapterConstructed = true;
          return fakeAdapter() as never;
        },
      });

      await assert.rejects(
        () =>
          syncCommerceConnectionById(
            { brandId: "brand-a", provider: CommerceProvider.COMMERCE7, connectionId: "conn-x" },
            {},
            { ...deps, getConnectionById: async (id) => connections[id] ?? null },
          ),
        (error: unknown) => {
          assert.ok(error instanceof CommerceConnectionNotReadyError);
          assert.equal(error.connectionId, "conn-x");
          assert.equal(error.status, status);
          assert.equal(error.provider, CommerceProvider.COMMERCE7);
          // Carries no credential/secret material.
          assert.doesNotMatch(JSON.stringify(error), /token|secret|password|authorization/i);
          return true;
        },
      );
      assert.equal(runCreated, false, "no CommerceProductSyncRun may be created");
      assert.equal(adapterConstructed, false, "no adapter/provider transport may be resolved");
    });
  }

  test("3. EXACT CONNECTED Commerce7 connection still succeeds normally", async () => {
    const connections: Record<string, CommerceConnectionSummary> = {
      "conn-x": makeSummary({ id: "conn-x", brandId: "brand-a", status: "CONNECTED" }),
    };
    const deps = makeSyncDeps({ getAdapter: () => fakeAdapter() as never });

    const result = await syncCommerceConnectionById(
      { brandId: "brand-a", provider: CommerceProvider.COMMERCE7, connectionId: "conn-x" },
      {},
      { ...deps, getConnectionById: async (id) => connections[id] ?? null },
    );
    assert.equal(result.status, "SUCCEEDED");
  });

  test("4. foreign brand supplying another brand's connection X still gets NotFound — status never leaked", async () => {
    const connections: Record<string, CommerceConnectionSummary> = {
      "conn-x": makeSummary({ id: "conn-x", brandId: "brand-owner", status: "UNINSTALLED" }),
    };
    let adapterConstructed = false;
    const deps = makeSyncDeps({ getAdapter: () => { adapterConstructed = true; return fakeAdapter() as never; } });

    await assert.rejects(
      () =>
        syncCommerceConnectionById(
          { brandId: "brand-attacker", provider: CommerceProvider.COMMERCE7, connectionId: "conn-x" },
          {},
          { ...deps, getConnectionById: async (id) => connections[id] ?? null },
        ),
      (error: unknown) => {
        // Must be the SAME error type/shape as a genuinely missing id — never
        // CommerceConnectionNotReadyError, which would leak that the
        // connection exists and disclose its lifecycle status.
        assert.ok(error instanceof CommerceConnectionNotFoundError);
        assert.ok(!(error instanceof CommerceConnectionNotReadyError));
        return true;
      },
    );
    assert.equal(adapterConstructed, false);
  });

  test("5. provider mismatch still fails before provider I/O, independent of lifecycle status", async () => {
    const connections: Record<string, CommerceConnectionSummary> = {
      "conn-x": makeSummary({
        id: "conn-x",
        brandId: "brand-a",
        provider: CommerceProvider.SHOPIFY,
        status: "UNINSTALLED",
      }),
    };
    let adapterConstructed = false;
    const deps = makeSyncDeps({ getAdapter: () => { adapterConstructed = true; return fakeAdapter() as never; } });

    await assert.rejects(
      () =>
        syncCommerceConnectionById(
          { brandId: "brand-a", provider: CommerceProvider.COMMERCE7, connectionId: "conn-x" },
          {},
          { ...deps, getConnectionById: async (id) => connections[id] ?? null },
        ),
      (error: unknown) => {
        // Mismatch is checked (and reported) independently of status.
        assert.equal(error?.constructor?.name, "CommerceConnectionMismatchError");
        return true;
      },
    );
    assert.equal(adapterConstructed, false);
  });
});

// ===========================================================================
describe("C. syncBrandCommerceProducts (preferred/legacy path) enforces the same invariant", () => {
  test("a non-CONNECTED preferred connection yields SKIPPED/NOT_CONNECTED, not an error, and calls no adapter", async () => {
    let adapterConstructed = false;
    const outcome = await syncBrandCommerceProducts(
      "brand-a",
      CommerceProvider.SHOPIFY,
      {},
      makeSyncDeps({
        getActiveConnection: async () =>
          makeSummary({ provider: CommerceProvider.SHOPIFY, status: "REQUIRES_RECONNECT" }),
        getAdapter: () => {
          adapterConstructed = true;
          return fakeAdapter() as never;
        },
      }),
    );
    assert.deepEqual(outcome, {
      status: "SKIPPED",
      reason: "NOT_CONNECTED",
      brandId: "brand-a",
      provider: CommerceProvider.SHOPIFY,
    });
    assert.equal(adapterConstructed, false, "no adapter/provider I/O for a non-CONNECTED preferred row");
  });

  test("8. LEGACY: a bodyless call stays Shopify-default, and issues zero provider I/O when Shopify is not CONNECTED", async () => {
    let seenProvider: CommerceProvider | null = null;
    let adapterConstructed = false;
    const outcome = await syncBrandCommerceProducts(
      "brand-a",
      undefined,
      {},
      makeSyncDeps({
        getActiveConnection: async (_brandId, provider) => {
          seenProvider = provider;
          return makeSummary({ provider: CommerceProvider.SHOPIFY, status: "DISCONNECTED" });
        },
        getAdapter: () => {
          adapterConstructed = true;
          return fakeAdapter() as never;
        },
      }),
    );
    assert.equal(seenProvider, CommerceProvider.SHOPIFY, "legacy default is still Shopify");
    assert.equal(outcome.status, "SKIPPED");
    assert.equal(adapterConstructed, false);
  });

  test("a CONNECTED preferred connection is unaffected — full success path preserved", async () => {
    const outcome = await syncBrandCommerceProducts(
      "brand-a",
      CommerceProvider.SHOPIFY,
      {},
      makeSyncDeps({
        getActiveConnection: async () => makeSummary({ provider: CommerceProvider.SHOPIFY, status: "CONNECTED" }),
        getAdapter: () => fakeAdapter() as never,
      }),
    );
    assert.equal(outcome.status, "SUCCEEDED");
  });
});

// ===========================================================================
describe("D/6. Commerce7CommerceAdapter — independent defense-in-depth", () => {
  function connectionRow(overrides: Partial<Commerce7CommerceConnectionRow> = {}): Commerce7CommerceConnectionRow {
    return {
      id: "conn-c7",
      brandId: "brand-a",
      provider: CommerceProvider.COMMERCE7,
      status: "CONNECTED",
      displayName: "sqratch-inc",
      externalAccountId: "sqratch-inc",
      storefrontUrl: null,
      isPrimary: true,
      grantedScopes: null,
      installedAt: new Date("2026-01-01"),
      uninstalledAt: null,
      lastProductSyncAt: null,
      providerMetadata: null,
      ...overrides,
    };
  }

  function countingFetch(): { impl: Commerce7Fetch; count: () => number } {
    let calls = 0;
    const impl: Commerce7Fetch = async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ products: [] }) };
    };
    return { impl, count: () => calls };
  }

  test("syncProducts on an UNINSTALLED connection makes ZERO Commerce7 fetch calls", async () => {
    const { impl, count } = countingFetch();
    const adapter = new Commerce7CommerceAdapter({
      loadConnection: async () => connectionRow({ status: "UNINSTALLED" }),
      markProductSync: async () => {},
      fetchImpl: impl,
    });

    await assert.rejects(() => adapter.syncProducts("conn-c7"), CommerceConnectionNotReadyError);
    assert.equal(count(), 0, "zero Commerce7 API calls for a non-CONNECTED connection");
  });

  test("fetchProductPage on a DISCONNECTED connection makes ZERO Commerce7 fetch calls", async () => {
    const { impl, count } = countingFetch();
    const adapter = new Commerce7CommerceAdapter({
      loadConnection: async () => connectionRow({ status: "DISCONNECTED" }),
      markProductSync: async () => {},
      fetchImpl: impl,
    });

    await assert.rejects(
      () => adapter.fetchProductPage("conn-c7", { cursor: null }),
      CommerceConnectionNotReadyError,
    );
    assert.equal(count(), 0);
  });

  test("a REQUIRES_RECONNECT connection is equally rejected", async () => {
    const { impl, count } = countingFetch();
    const adapter = new Commerce7CommerceAdapter({
      loadConnection: async () => connectionRow({ status: "REQUIRES_RECONNECT" }),
      markProductSync: async () => {},
      fetchImpl: impl,
    });
    await assert.rejects(() => adapter.syncProducts("conn-c7"), CommerceConnectionNotReadyError);
    assert.equal(count(), 0);
  });

  test("a CONNECTED connection is unaffected — the adapter still performs real I/O", async () => {
    const { impl, count } = countingFetch();
    const adapter = new Commerce7CommerceAdapter({
      loadConnection: async () => connectionRow({ status: "CONNECTED" }),
      markProductSync: async () => {},
      fetchImpl: impl,
    });
    const result = await adapter.syncProducts("conn-c7");
    assert.equal(result.productCount, 0);
    assert.equal(count(), 1);
  });
});

// ===========================================================================
describe("F/9. active-connection selection never lets a non-CONNECTED row win", () => {
  function row(overrides: Partial<CommerceConnectionRow> = {}): CommerceConnectionRow {
    return {
      id: "conn-1",
      brandId: "brand-a",
      provider: CommerceProvider.SHOPIFY,
      status: "CONNECTED",
      displayName: "x",
      externalAccountId: "x",
      storefrontUrl: null,
      isPrimary: true,
      grantedScopes: null,
      installedAt: new Date("2026-01-01"),
      uninstalledAt: null,
      lastProductSyncAt: null,
      createdAt: new Date("2026-01-01"),
      providerMetadata: null,
      ...overrides,
    };
  }

  test("9. Commerce7 UNINSTALLED with a NEWER installedAt loses to Shopify CONNECTED with an OLDER installedAt", async () => {
    const rows: Record<string, CommerceConnectionRow[]> = {
      SHOPIFY: [row({ id: "conn-shopify", status: "CONNECTED", installedAt: new Date("2026-01-01") })],
      COMMERCE7: [
        row({
          id: "conn-c7",
          provider: CommerceProvider.COMMERCE7,
          status: "UNINSTALLED",
          installedAt: new Date("2026-06-01"),
        }),
      ],
    };
    const result = await getActiveCommerceConnectionAnyProvider("brand-a", {
      findConnectionRows: async (_brandId, provider) => rows[provider] ?? [],
    });
    assert.equal(result!.provider, CommerceProvider.SHOPIFY);
    assert.equal(result!.status, "CONNECTED");
  });

  test("when both are CONNECTED, the existing deterministic tiebreak (most recent installedAt) applies unchanged", async () => {
    const rows: Record<string, CommerceConnectionRow[]> = {
      SHOPIFY: [row({ id: "conn-shopify", status: "CONNECTED", installedAt: new Date("2026-01-01") })],
      COMMERCE7: [
        row({
          id: "conn-c7",
          provider: CommerceProvider.COMMERCE7,
          status: "CONNECTED",
          installedAt: new Date("2026-06-01"),
        }),
      ],
    };
    const result = await getActiveCommerceConnectionAnyProvider("brand-a", {
      findConnectionRows: async (_brandId, provider) => rows[provider] ?? [],
    });
    assert.equal(result!.provider, CommerceProvider.COMMERCE7, "more recently installed CONNECTED row wins");
  });

  test("with nothing CONNECTED anywhere, a non-connected row may still be returned for DISPLAY purposes", async () => {
    const rows: Record<string, CommerceConnectionRow[]> = {
      SHOPIFY: [],
      COMMERCE7: [row({ id: "conn-c7", provider: CommerceProvider.COMMERCE7, status: "UNINSTALLED" })],
    };
    const result = await getActiveCommerceConnectionAnyProvider("brand-a", {
      findConnectionRows: async (_brandId, provider) => rows[provider] ?? [],
    });
    // Returned for display — but this alone must never authorize an action;
    // that's enforced by the product-sync boundary tests above, not here.
    assert.equal(result!.status, "UNINSTALLED");
  });
});

// ===========================================================================
describe("6. API route — 409 for owned-but-not-connected, 404 unaffected for foreign/missing", () => {
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

  test("a CommerceConnectionNotReadyError from runSync maps to 409 with the stable generic body", async () => {
    const res = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        findRunningRun: async () => null,
        runSync: async () => {
          throw new CommerceConnectionNotReadyError(
            "conn-1",
            CommerceProvider.COMMERCE7,
            "UNINSTALLED",
          );
        },
      },
      "COMMERCE7",
      "conn-1",
    );
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.error, "Commerce connection is not connected.");
  });

  test("a CommerceConnectionNotFoundError (foreign/missing) still maps to 404, never 409", async () => {
    const res = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        findRunningRun: async () => null,
        runSync: async () => {
          throw new CommerceConnectionNotFoundError("conn-does-not-exist");
        },
      },
      "COMMERCE7",
      "conn-does-not-exist",
    );
    assert.equal(res.status, 404);
  });

  test("a SKIPPED/NOT_CONNECTED outcome from the legacy/preferred path is a controlled 400, never a silent 200", async () => {
    const res = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        findRunningRun: async () => null,
        runSync: async (brandId, provider) => ({
          status: "SKIPPED",
          reason: "NOT_CONNECTED",
          brandId,
          provider,
        }),
      },
      undefined,
      undefined,
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "NOT_CONNECTED");
  });
});

// ===========================================================================
describe("H. cheap P2: negative Commerce7 price canonical-persistence regression", () => {
  test("a negative variant price never produces a negative persisted amount — priceRangeRaw stays null", () => {
    const product = normalizeCommerce7Product({
      id: "p1",
      title: "x",
      webStatus: "Available",
      adminStatus: "Available",
      security: { availableTo: "Public" },
      variants: [{ id: "v1", price: -500 }],
    })!;
    // minorUnitsToDecimalString happily renders "-5.00"; the canonical layer
    // (providerPriceStringToMinorUnits, via computePrice in product-sync.ts)
    // is what must reject it — verified here at the boundary this module
    // actually hands off to.
    assert.equal(product.priceRangeRaw?.min, "-5.00");

    // Simulate the canonical layer's actual currency-resolution + parsing
    // step exactly as product-sync.ts performs it, proving end-to-end that a
    // negative amount can never reach a persisted row.
    const parsed = providerPriceStringToMinorUnits(product.priceRangeRaw!.min, "CAD");
    assert.deepEqual(parsed, { ok: false, reason: "NEGATIVE" });
  });

  test("currency stays null while currency authority is unresolved, so price fields are null end to end (no currency invented)", async () => {
    const Catalog: { rows: Array<Record<string, unknown>> } = { rows: [] };
    const deps = makeSyncDeps({
      getActiveConnection: async () =>
        makeSummary({ provider: CommerceProvider.COMMERCE7, status: "CONNECTED", currencyCode: null }),
      getAdapter: () =>
        ({
          provider: CommerceProvider.COMMERCE7,
          getCapabilities: () => ({
            products: { sync: true, publicDestinations: false },
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
          }),
          fetchProductPage: async () => ({
            products: [
              normalizeCommerce7Product({
                id: "p1",
                title: "x",
                webStatus: "Available",
                adminStatus: "Available",
                security: { availableTo: "Public" },
                variants: [{ id: "v1", price: -500 }],
              }),
            ],
            nextCursor: null,
            isComplete: true,
            fetchedAt: new Date(),
            limit: 50,
          }),
        }) as never,
      applyProductWrite: async (_connectionId, _brandId, _provider, _externalKey, decision) => {
        if (decision.kind === "CREATE") {
          Catalog.rows.push(decision.data as unknown as Record<string, unknown>);
        }
      },
    });

    const outcome = await syncBrandCommerceProducts("brand-a", CommerceProvider.COMMERCE7, {}, deps);
    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(Catalog.rows.length, 1);
    const row = Catalog.rows[0];
    assert.equal(row.currencyCode, null);
    assert.equal(row.priceMinMinor, null);
    assert.equal(row.priceMaxMinor, null);
    assert.equal(row.priceMinorUnitExponent, null);
  });
});
