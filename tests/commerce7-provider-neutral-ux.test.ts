/**
 * tests/commerce7-provider-neutral-ux.test.ts
 *
 * PHASE 16C2 — provider-neutral brand commerce UX, exact-connection product
 * sync, and the Commerce7 money-validation tightening. Behavioral, driving
 * real production functions with injected dependencies — no real DB, no real
 * network anywhere in this file.
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
  getActiveCommerceConnectionAnyProvider,
  type CommerceConnectionServiceDeps,
} from "../src/lib/commerce/connection-service";
import type { CommerceConnectionRow } from "../src/lib/commerce/connection-resolver";
import type { CommerceConnectionSummary } from "../src/lib/commerce/types";
import {
  syncBrandCommerceProducts,
  syncCommerceConnectionById,
  type ProductSyncDeps,
  type ExistingConnectedProductRow,
} from "../src/lib/commerce/product-sync";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  UnsupportedCapabilityError,
} from "../src/lib/commerce/errors";
import {
  normalizeCommerce7Product,
  minorUnitsToDecimalString,
} from "../src/lib/commerce/providers/commerce7-products";
import { commerceStatusGetImpl } from "../src/app/api/brand/commerce/status/route";
import { productsSyncImpl } from "../src/app/api/brand/products/sync/route";
import type { BrandAdminContext } from "../src/lib/brand-auth";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<CommerceConnectionRow> = {}): CommerceConnectionRow {
  return {
    id: "conn-1",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED",
    displayName: "acme",
    externalAccountId: "acme.myshopify.com",
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

function makeSummary(
  overrides: Partial<CommerceConnectionSummary> = {},
): CommerceConnectionSummary {
  return {
    id: "conn-1",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED",
    displayName: "acme",
    externalAccountId: "acme.myshopify.com",
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

// ===========================================================================
describe("1/2. getActiveCommerceConnectionAnyProvider — neutral dashboard resolution", () => {
  test("a Commerce7-only brand resolves to its Commerce7 connection, CONNECTED", async () => {
    const rows: Record<string, CommerceConnectionRow[]> = {
      SHOPIFY: [],
      COMMERCE7: [
        makeRow({
          id: "conn-c7",
          provider: CommerceProvider.COMMERCE7,
          externalAccountId: "sqratch-inc",
          displayName: "sqratch-inc",
        }),
      ],
    };
    const deps: Partial<CommerceConnectionServiceDeps> = {
      findConnectionRows: async (_brandId, provider) => rows[provider] ?? [],
    };

    const result = await getActiveCommerceConnectionAnyProvider("brand-1", deps);
    assert.ok(result);
    assert.equal(result!.provider, CommerceProvider.COMMERCE7);
    assert.equal(result!.status, "CONNECTED");
    assert.equal(result!.externalAccountId, "sqratch-inc");
  });

  test("a Shopify-only brand still resolves correctly (no regression)", async () => {
    const rows: Record<string, CommerceConnectionRow[]> = {
      SHOPIFY: [makeRow()],
      COMMERCE7: [],
    };
    const deps: Partial<CommerceConnectionServiceDeps> = {
      findConnectionRows: async (_brandId, provider) => rows[provider] ?? [],
    };

    const result = await getActiveCommerceConnectionAnyProvider("brand-1", deps);
    assert.ok(result);
    assert.equal(result!.provider, CommerceProvider.SHOPIFY);
  });

  test("CONNECTED beats a non-connected row under a different provider", async () => {
    const rows: Record<string, CommerceConnectionRow[]> = {
      SHOPIFY: [makeRow({ status: "UNINSTALLED", installedAt: new Date("2026-06-01") })],
      COMMERCE7: [
        makeRow({
          id: "conn-c7",
          provider: CommerceProvider.COMMERCE7,
          status: "CONNECTED",
          installedAt: new Date("2026-01-01"),
        }),
      ],
    };
    const deps: Partial<CommerceConnectionServiceDeps> = {
      findConnectionRows: async (_brandId, provider) => rows[provider] ?? [],
    };

    const result = await getActiveCommerceConnectionAnyProvider("brand-1", deps);
    assert.equal(result!.provider, CommerceProvider.COMMERCE7);
    assert.equal(result!.status, "CONNECTED");
  });

  test("no connection under any provider resolves null", async () => {
    const deps: Partial<CommerceConnectionServiceDeps> = {
      findConnectionRows: async () => [],
    };
    assert.equal(await getActiveCommerceConnectionAnyProvider("brand-1", deps), null);
  });
});

describe("1/2. GET /api/brand/commerce/status — neutral route", () => {
  function makeContext(): BrandAdminContext {
    return {
      userId: "user-1",
      selectionRequired: false,
      brands: [{ id: "brand-1", name: "Acme", slug: "acme", membershipRole: "ADMIN" }],
      membership: {
        id: "member-1",
        role: "ADMIN",
        brand: {
          id: "brand-1",
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

  test("reports a Commerce7 connection as CONNECTED (never Shopify DISCONNECTED)", async () => {
    const res = await commerceStatusGetImpl({
      getContext: async () => makeContext(),
      getConnection: async () =>
        makeSummary({
          id: "conn-c7",
          provider: CommerceProvider.COMMERCE7,
          status: "CONNECTED",
          externalAccountId: "sqratch-inc",
          displayName: "sqratch-inc",
        }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.connection.provider, "COMMERCE7");
    assert.equal(body.data.connection.isConnected, true);
    assert.equal(body.data.connection.externalAccountId, "sqratch-inc");
  });

  test("reports a Shopify connection correctly too", async () => {
    const res = await commerceStatusGetImpl({
      getContext: async () => makeContext(),
      getConnection: async () => makeSummary({ provider: CommerceProvider.SHOPIFY }),
    });
    const body = await res.json();
    assert.equal(body.data.connection.provider, "SHOPIFY");
    assert.equal(body.data.connection.isConnected, true);
  });

  test("no connection at all reports connection: null, not an error", async () => {
    const res = await commerceStatusGetImpl({
      getContext: async () => makeContext(),
      getConnection: async () => null,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.connection, null);
  });

  test("unauthenticated caller never reaches getConnection", async () => {
    let called = false;
    const res = await commerceStatusGetImpl({
      getContext: async () => null,
      getConnection: async () => {
        called = true;
        return null;
      },
    });
    assert.notEqual(res.status, 200);
    assert.equal(called, false);
  });
});

// ===========================================================================
describe("3/4. syncCommerceConnectionById — exact-connection selection", () => {
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

  function makeAdapter(products: ReturnType<typeof normalizeCommerce7Product>[] = []) {
    let productCalls = 0;
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
      fetchProductPage: async () => {
        productCalls += 1;
        return {
          products,
          nextCursor: null,
          isComplete: true,
          fetchedAt: new Date(),
          limit: 50,
        };
      },
      getProductCallCount: () => productCalls,
    };
  }

  test("G/H. connection X and connection Y each sync only their own tenant/adapter", async () => {
    const adapterX = makeAdapter();
    const adapterY = makeAdapter();
    let requestedConnectionId: string | null = null;

    const connections: Record<string, CommerceConnectionSummary> = {
      "conn-x": makeSummary({
        id: "conn-x",
        brandId: "brand-x",
        provider: CommerceProvider.COMMERCE7,
        externalAccountId: "tenant-x",
      }),
      "conn-y": makeSummary({
        id: "conn-y",
        brandId: "brand-y",
        provider: CommerceProvider.COMMERCE7,
        externalAccountId: "tenant-y",
      }),
    };

    const baseDeps = makeSyncDeps({
      getAdapter: (summary) => {
        requestedConnectionId = summary.id;
        return (summary.id === "conn-x" ? adapterX : adapterY) as never;
      },
    });

    const resultX = await syncCommerceConnectionById(
      { brandId: "brand-x", provider: CommerceProvider.COMMERCE7, connectionId: "conn-x" },
      {},
      { ...baseDeps, getConnectionById: async (id) => connections[id] ?? null },
    );
    assert.equal(requestedConnectionId, "conn-x");
    assert.equal(resultX.status !== "SKIPPED" ? resultX.connectionId : null, "conn-x");

    const resultY = await syncCommerceConnectionById(
      { brandId: "brand-y", provider: CommerceProvider.COMMERCE7, connectionId: "conn-y" },
      {},
      { ...baseDeps, getConnectionById: async (id) => connections[id] ?? null },
    );
    assert.equal(requestedConnectionId, "conn-y");
    assert.equal(resultY.status !== "SKIPPED" ? resultY.connectionId : null, "conn-y");
  });

  test("I. requesting brand X's own id while asking for connection Y's id never resolves Y for X", async () => {
    // brand-x tries to sync connection Y, which belongs to brand-y.
    const connections: Record<string, CommerceConnectionSummary> = {
      "conn-y": makeSummary({
        id: "conn-y",
        brandId: "brand-y",
        provider: CommerceProvider.COMMERCE7,
        externalAccountId: "tenant-y",
      }),
    };

    let adapterConstructed = false;
    const deps = makeSyncDeps({
      getAdapter: () => {
        adapterConstructed = true;
        return makeAdapter() as never;
      },
    });

    await assert.rejects(
      () =>
        syncCommerceConnectionById(
          { brandId: "brand-x", provider: CommerceProvider.COMMERCE7, connectionId: "conn-y" },
          {},
          { ...deps, getConnectionById: async (id) => connections[id] ?? null },
        ),
      CommerceConnectionNotFoundError,
    );
    assert.equal(adapterConstructed, false, "no adapter/provider I/O before ownership is verified");
  });

  test("6. unauthorized brand cannot sync someone else's connection — identical error to a nonexistent id (no existence leak)", async () => {
    const connections: Record<string, CommerceConnectionSummary> = {
      "conn-real": makeSummary({ id: "conn-real", brandId: "brand-owner", provider: CommerceProvider.COMMERCE7 }),
    };
    const deps = makeSyncDeps({ getAdapter: () => makeAdapter() as never });

    let errorForForeignId: unknown;
    try {
      await syncCommerceConnectionById(
        { brandId: "brand-attacker", provider: CommerceProvider.COMMERCE7, connectionId: "conn-real" },
        {},
        { ...deps, getConnectionById: async (id) => connections[id] ?? null },
      );
    } catch (error) {
      errorForForeignId = error;
    }

    let errorForMissingId: unknown;
    try {
      await syncCommerceConnectionById(
        { brandId: "brand-attacker", provider: CommerceProvider.COMMERCE7, connectionId: "conn-does-not-exist" },
        {},
        { ...deps, getConnectionById: async () => null },
      );
    } catch (error) {
      errorForMissingId = error;
    }

    // Both cases must be the SAME error type/code/HTTP-mapping — the message
    // legitimately echoes back whatever id the caller themselves supplied
    // (their own input, not a leak), but nothing distinguishes "exists under
    // another brand" from "does not exist" beyond that.
    assert.ok(errorForForeignId instanceof CommerceConnectionNotFoundError);
    assert.ok(errorForMissingId instanceof CommerceConnectionNotFoundError);
    assert.equal(
      (errorForForeignId as CommerceConnectionNotFoundError).code,
      (errorForMissingId as CommerceConnectionNotFoundError).code,
    );
    assert.match(
      (errorForForeignId as CommerceConnectionNotFoundError).message,
      /^Commerce connection ".*" was not found\.$/,
    );
    assert.match(
      (errorForMissingId as CommerceConnectionNotFoundError).message,
      /^Commerce connection ".*" was not found\.$/,
    );
  });

  test("5. a provider/connection mismatch fails BEFORE any adapter/provider I/O", async () => {
    const connections: Record<string, CommerceConnectionSummary> = {
      "conn-shopify": makeSummary({ id: "conn-shopify", brandId: "brand-1", provider: CommerceProvider.SHOPIFY }),
    };
    let adapterConstructed = false;
    const deps = makeSyncDeps({
      getAdapter: () => {
        adapterConstructed = true;
        return makeAdapter() as never;
      },
    });

    await assert.rejects(
      () =>
        syncCommerceConnectionById(
          // Asking for COMMERCE7 against a connection that is actually SHOPIFY.
          { brandId: "brand-1", provider: CommerceProvider.COMMERCE7, connectionId: "conn-shopify" },
          {},
          { ...deps, getConnectionById: async (id) => connections[id] ?? null },
        ),
      (error: unknown) => {
        assert.ok(error instanceof CommerceConnectionMismatchError);
        assert.equal(error.requestedProvider, CommerceProvider.COMMERCE7);
        assert.equal(error.actualProvider, CommerceProvider.SHOPIFY);
        return true;
      },
    );
    assert.equal(adapterConstructed, false, "no adapter must be constructed on a provider mismatch");
  });

  test("a capability-unsupporting adapter still fails before any run row / write", async () => {
    const connections: Record<string, CommerceConnectionSummary> = {
      "conn-1": makeSummary({ id: "conn-1", brandId: "brand-1", provider: CommerceProvider.COMMERCE7 }),
    };
    let runCreated = false;
    const deps = makeSyncDeps({
      createSyncRun: async () => {
        runCreated = true;
        return { id: "run-1" };
      },
      getAdapter: () =>
        ({
          provider: CommerceProvider.COMMERCE7,
          getCapabilities: () => ({
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
          }),
        }) as never,
    });

    await assert.rejects(
      () =>
        syncCommerceConnectionById(
          { brandId: "brand-1", provider: CommerceProvider.COMMERCE7, connectionId: "conn-1" },
          {},
          { ...deps, getConnectionById: async (id) => connections[id] ?? null },
        ),
      UnsupportedCapabilityError,
    );
    assert.equal(runCreated, false);
  });
});

// ===========================================================================
describe("ROUTE: POST /api/brand/products/sync — provider/connection selection", () => {
  function makeContext(): BrandAdminContext {
    return {
      userId: "user-1",
      selectionRequired: false,
      brands: [{ id: "brand-1", name: "Acme", slug: "acme", membershipRole: "ADMIN" }],
      membership: {
        id: "member-1",
        role: "ADMIN",
        brand: {
          id: "brand-1",
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

  test("13. a legacy caller with no body still defaults to SHOPIFY, unaffected by this phase", async () => {
    let seenProvider: CommerceProvider | null = null;
    let seenConnectionId: string | null | undefined;
    const res = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        findRunningRun: async () => null,
        runSync: async (brandId, provider, connectionId) => {
          seenProvider = provider;
          seenConnectionId = connectionId;
          return { status: "SKIPPED", reason: "NO_CONNECTION", brandId, provider };
        },
      },
      undefined,
      undefined,
    );
    assert.equal(res.status, 400);
    assert.equal(seenProvider, CommerceProvider.SHOPIFY);
    assert.equal(seenConnectionId, null);
  });

  test("explicit provider + connectionId from the UI are threaded to runSync exactly", async () => {
    let seenArgs: [string, CommerceProvider, string | null] | null = null;
    const res = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        findRunningRun: async () => null,
        runSync: async (brandId, provider, connectionId) => {
          seenArgs = [brandId, provider, connectionId];
          return {
            status: "SUCCEEDED",
            brandId,
            provider,
            connectionId: connectionId ?? "conn-c7",
            runId: "run-1",
            stats: {
              fetchedCount: 0,
              createdCount: 0,
              updatedCount: 0,
              unchangedCount: 0,
              markedUnavailableCount: 0,
              failedCount: 0,
            },
            hasNextPage: false,
            failureSummary: null,
          };
        },
      },
      "COMMERCE7",
      "conn-c7-explicit",
    );
    assert.equal(res.status, 200);
    assert.deepEqual(seenArgs, ["brand-1", CommerceProvider.COMMERCE7, "conn-c7-explicit"]);
  });

  test("a CommerceConnectionMismatchError from runSync maps to 400, not a 500", async () => {
    const res = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        findRunningRun: async () => null,
        runSync: async () => {
          throw new CommerceConnectionMismatchError(
            "conn-1",
            CommerceProvider.COMMERCE7,
            CommerceProvider.SHOPIFY,
          );
        },
      },
      "COMMERCE7",
      "conn-1",
    );
    assert.equal(res.status, 400);
  });

  test("a CommerceConnectionNotFoundError from runSync maps to 404, not a 500", async () => {
    const res = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        findRunningRun: async () => null,
        runSync: async () => {
          throw new CommerceConnectionNotFoundError("conn-nope");
        },
      },
      "COMMERCE7",
      "conn-nope",
    );
    assert.equal(res.status, 404);
  });

  test("an unrecognized provider string is rejected before runSync is ever called", async () => {
    let called = false;
    const res = await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        findRunningRun: async () => null,
        runSync: async () => {
          called = true;
          throw new Error("must not be called");
        },
      },
      "NOT_A_REAL_PROVIDER",
      undefined,
    );
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });

  test("a whitespace-only connectionId is treated as absent (falls back to preferred-connection lookup)", async () => {
    let seenConnectionId: string | null | undefined = "unset";
    await productsSyncImpl(
      {
        getContext: async () => makeContext(),
        findRunningRun: async () => null,
        runSync: async (brandId, provider, connectionId) => {
          seenConnectionId = connectionId;
          return { status: "SKIPPED", reason: "NO_CONNECTION", brandId, provider };
        },
      },
      "SHOPIFY",
      "   ",
    );
    assert.equal(seenConnectionId, null);
  });
});

// ===========================================================================
describe("13. Shopify product sync remains unchanged", () => {
  test("syncBrandCommerceProducts still defaults to SHOPIFY and needs no connectionId", async () => {
    let seenProvider: CommerceProvider | null = null;
    const deps: Partial<ProductSyncDeps> = {
      getActiveConnection: async (_brandId, provider) => {
        seenProvider = provider;
        return null;
      },
    };
    const outcome = await syncBrandCommerceProducts("brand-1", undefined, {}, deps);
    assert.equal(seenProvider, CommerceProvider.SHOPIFY);
    assert.equal(outcome.status, "SKIPPED");
  });
});

// ===========================================================================
describe("7/8. Commerce7 safe-integer / malformed price behavior", () => {
  test("an unsafe-integer price is excluded, not silently corrupted", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 10;
    const product = normalizeCommerce7Product({
      id: "p1",
      title: "x",
      webStatus: "Available",
      adminStatus: "Available",
      security: { availableTo: "Public" },
      variants: [{ id: "v1", price: unsafe }],
    })!;
    assert.deepEqual(product.priceRangeRaw, { min: null, max: null });
  });

  test("a safe-integer price still converts correctly (no regression from the tightened check)", () => {
    const product = normalizeCommerce7Product({
      id: "p1",
      title: "x",
      webStatus: "Available",
      adminStatus: "Available",
      security: { availableTo: "Public" },
      variants: [{ id: "v1", price: 4200 }],
    })!;
    assert.deepEqual(product.priceRangeRaw, { min: "42.00", max: "42.00" });
  });

  test("a float (non-integer) price is excluded", () => {
    const product = normalizeCommerce7Product({
      id: "p1",
      title: "x",
      variants: [{ id: "v1", price: 42.5 }],
    })!;
    assert.deepEqual(product.priceRangeRaw, { min: null, max: null });
  });

  test("minorUnitsToDecimalString rejects non-integers and returns null", () => {
    assert.equal(minorUnitsToDecimalString(1.5), null);
    assert.equal(minorUnitsToDecimalString(NaN), null);
    assert.equal(minorUnitsToDecimalString(Infinity), null);
  });
});

// ===========================================================================
describe("9/10. Public Commerce7 product eligibility stays fully disabled", () => {
  test("a Public, fully-available product still persists NO public destination", () => {
    const product = normalizeCommerce7Product({
      id: "p1",
      title: "Public wine",
      slug: "public-wine",
      webStatus: "Available",
      adminStatus: "Available",
      security: { availableTo: "Public" },
      variants: [{ id: "v1", price: 1000 }],
    })!;
    assert.equal(product.hasProviderStorefrontPublication, false);
    assert.equal(product.hasProviderSuppliedStorefrontUrl, false);
    assert.equal(product.productUrl, "");
  });

  test("Club/Group/Allocation products remain equally non-public (same as Public — no destination exists at all)", () => {
    for (const availableTo of ["Club", "Group", "Allocation"]) {
      const product = normalizeCommerce7Product({
        id: "p1",
        title: "Members wine",
        webStatus: "Available",
        adminStatus: "Available",
        security: { availableTo },
        variants: [{ id: "v1", price: 1000 }],
      })!;
      assert.equal(product.hasProviderStorefrontPublication, false);
      assert.equal(product.productUrl, "");
    }
  });

  test("a malformed/missing storefront destination can never leak through — productUrl is always exactly empty", () => {
    for (const raw of [
      { id: "p1", title: "x" },
      { id: "p1", title: "x", slug: "" },
      { id: "p1", title: "x", slug: "../etc/passwd" },
      { id: "p1", title: "x", slug: null },
    ]) {
      const product = normalizeCommerce7Product(raw)!;
      assert.equal(product.productUrl, "");
    }
  });
});

// ===========================================================================
describe("11. no tenant-id hostname synthesis (reconfirmed)", () => {
  test("no source file interpolates a tenant into a URL literal", async () => {
    const { readFileSync } = await import("node:fs");
    const stripComments = (source: string) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");

    for (const file of [
      "src/lib/commerce/providers/commerce7-products.ts",
      "src/lib/commerce/providers/commerce7-commerce-adapter.ts",
      "src/lib/commerce/provider-capabilities.ts",
    ]) {
      const code = stripComments(readFileSync(file, "utf8"));
      assert.doesNotMatch(code, /v2-template/);
      assert.doesNotMatch(code, /commerce7\.com\/product/);
      assert.doesNotMatch(code, /https?:\/\/\$\{/);
    }
  });
});
