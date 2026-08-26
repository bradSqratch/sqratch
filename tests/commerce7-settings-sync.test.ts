/**
 * tests/commerce7-settings-sync.test.ts
 *
 * PHASE 20 (settings sync round, Part 20) —
 * `syncCommerce7ConnectionSettings` (`src/lib/commerce/providers/commerce7-settings-sync.ts`).
 *
 * This layer deliberately contains NO persistence logic of its own — it
 * resolves ownership, fetches Commerce7 settings, then forwards to the
 * EXISTING `configureCommerce7Storefront` (already exhaustively tested for
 * invalidation behavior in `tests/commerce7-storefront-configuration.test.ts`,
 * battery items 9-12). These tests therefore focus on what is UNIQUE to
 * this layer — ownership/provider/status ordering, provider HTTP happening
 * with no transaction open, and correct pass-through of both success and
 * `{ok: false}` validation-failure results — plus ONE end-to-end test
 * against the REAL `configureCommerce7Storefront` proving a changed
 * currency invalidates money end to end through this entry point too.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import { syncCommerce7ConnectionSettings } from "../src/lib/commerce/providers/commerce7-settings-sync";
import {
  configureCommerce7Storefront,
  type Commerce7ConfigTransactionClient,
  type Commerce7ConnectionConfigRow,
} from "../src/lib/commerce/providers/commerce7-storefront-configuration";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "../src/lib/commerce/errors";
import type { CommerceConnectionSummary } from "../src/lib/commerce/types";

function connectionSummary(overrides: Partial<CommerceConnectionSummary> = {}): CommerceConnectionSummary {
  return {
    id: "conn-1",
    brandId: "brand-a",
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    displayName: "Acme Winery",
    externalAccountId: "tenant-1",
    storefrontUrl: null,
    isPrimary: true,
    grantedScopes: [],
    installedAt: null,
    uninstalledAt: null,
    lastProductSyncAt: null,
    currencyCode: null,
    productRoute: null,
    ...overrides,
  };
}

describe("syncCommerce7ConnectionSettings — orchestration", () => {
  test("resolves the connection, fetches settings, then forwards to configure() with the extracted fields", async () => {
    let fetchCalledWithTenant: string | null = null;
    let configureCalledWith: unknown = null;

    const result = await syncCommerce7ConnectionSettings(
      { brandId: "brand-a", connectionId: "conn-1" },
      {
        getConnection: async () => connectionSummary({ externalAccountId: "tenant-xyz" }),
        fetchSettings: async (input) => {
          fetchCalledWithTenant = input.tenant;
          return { storefrontUrl: "https://shop.example.com", currencyCode: "CAD", productRoute: "/product" };
        },
        configure: async (input) => {
          configureCalledWith = input;
          return { ok: true, storefrontUrl: input.storefrontUrl, productRoute: input.productRoute, currencyCode: input.currencyCode, requiresProductSync: true };
        },
      },
    );

    assert.equal(fetchCalledWithTenant, "tenant-xyz", "tenant comes from the resolved connection's externalAccountId");
    assert.deepEqual(configureCalledWith, {
      brandId: "brand-a",
      connectionId: "conn-1",
      storefrontUrl: "https://shop.example.com",
      productRoute: "/product",
      currencyCode: "CAD",
    });
    assert.equal(result.ok, true);
  });

  test("provider HTTP happens with no transaction/lock context — configure() is called strictly AFTER fetchSettings resolves", async () => {
    const order: string[] = [];
    await syncCommerce7ConnectionSettings(
      { brandId: "brand-a", connectionId: "conn-1" },
      {
        getConnection: async () => connectionSummary(),
        fetchSettings: async () => {
          order.push("fetchSettings");
          return { storefrontUrl: "https://shop.example.com", currencyCode: "USD", productRoute: "/product" };
        },
        configure: async () => {
          order.push("configure");
          return { ok: true, storefrontUrl: "https://shop.example.com", productRoute: "/product", currencyCode: "USD", requiresProductSync: false };
        },
      },
    );
    assert.deepEqual(order, ["fetchSettings", "configure"]);
  });

  test("a foreign-brand connectionId throws CommerceConnectionNotFoundError before any provider HTTP", async () => {
    let fetchCalled = false;
    await assert.rejects(
      () =>
        syncCommerce7ConnectionSettings(
          { brandId: "brand-a", connectionId: "conn-1" },
          {
            getConnection: async () => connectionSummary({ brandId: "brand-OTHER" }),
            fetchSettings: async () => {
              fetchCalled = true;
              return { storefrontUrl: "https://x.example.com", currencyCode: "USD", productRoute: "/product" };
            },
          },
        ),
      CommerceConnectionNotFoundError,
    );
    assert.equal(fetchCalled, false);
  });

  test("a Shopify connection throws CommerceConnectionMismatchError", async () => {
    await assert.rejects(
      () =>
        syncCommerce7ConnectionSettings(
          { brandId: "brand-a", connectionId: "conn-1" },
          { getConnection: async () => connectionSummary({ provider: CommerceProvider.SHOPIFY }) },
        ),
      CommerceConnectionMismatchError,
    );
  });

  test("a non-CONNECTED connection throws CommerceConnectionNotReadyError before any provider HTTP", async () => {
    let fetchCalled = false;
    await assert.rejects(
      () =>
        syncCommerce7ConnectionSettings(
          { brandId: "brand-a", connectionId: "conn-1" },
          {
            getConnection: async () => connectionSummary({ status: "DISCONNECTED" }),
            fetchSettings: async () => {
              fetchCalled = true;
              return { storefrontUrl: "https://x.example.com", currencyCode: "USD", productRoute: "/product" };
            },
          },
        ),
      CommerceConnectionNotReadyError,
    );
    assert.equal(fetchCalled, false, "reconnect uses its own settings-before-connect flow — this manual/auto-sync path is CONNECTED-only");
  });

  test("a SQRATCH validation failure ({ok: false}) from configure() is returned verbatim, not thrown", async () => {
    const result = await syncCommerce7ConnectionSettings(
      { brandId: "brand-a", connectionId: "conn-1" },
      {
        getConnection: async () => connectionSummary(),
        fetchSettings: async () => ({ storefrontUrl: "not-a-url", currencyCode: "USD", productRoute: "/product" }),
        configure: async () => ({ ok: false, field: "storefrontUrl", error: "Invalid storefront URL." }),
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.field, "storefrontUrl");
  });
});

// ---------------------------------------------------------------------------
// End-to-end confidence check against the REAL configureCommerce7Storefront
// (invalidation behavior itself is exhaustively covered by
// tests/commerce7-storefront-configuration.test.ts, battery 9-12 — this one
// test proves THIS entry point reaches that same real machinery, not a copy).
// ---------------------------------------------------------------------------

type FakeProductRow = {
  connectionId: string;
  currencyCode: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  priceMinorUnitExponent: number | null;
  hasPublicStorefrontUrl: boolean;
};

class FakeConfigStore {
  connections = new Map<string, Commerce7ConnectionConfigRow>();
  products = new Map<string, FakeProductRow>();
  currencyInvalidatedFor: string[] = [];

  async runInTransaction<T>(fn: (client: Commerce7ConfigTransactionClient) => Promise<T>): Promise<T> {
    const stagedConnections = new Map(this.connections);
    const stagedProducts = new Map(this.products);
    const client: Commerce7ConfigTransactionClient = {
      findConnection: async (id) => stagedConnections.get(id) ?? null,
      updateConnectionConfiguration: async (id, data) => {
        const existing = stagedConnections.get(id);
        if (!existing) return;
        stagedConnections.set(id, { ...existing, storefrontUrl: data.storefrontUrl, providerMetadata: data.providerMetadata });
      },
      invalidateCurrencyDerivedProductData: async (id) => {
        this.currencyInvalidatedFor.push(id);
        for (const product of stagedProducts.values()) {
          if (product.connectionId === id) {
            product.currencyCode = null;
            product.priceMinMinor = null;
            product.priceMaxMinor = null;
            product.priceMinorUnitExponent = null;
          }
        }
      },
      invalidatePublicDestinationDerivedProductData: async (id) => {
        for (const product of stagedProducts.values()) {
          if (product.connectionId === id) product.hasPublicStorefrontUrl = false;
        }
      },
    };
    const result = await fn(client);
    this.connections = stagedConnections;
    this.products = stagedProducts;
    return result;
  }
}

describe("syncCommerce7ConnectionSettings — end-to-end through the real configureCommerce7Storefront", () => {
  test("a changed currency, fetched from Commerce7, invalidates money fields on this connection's products end to end", async () => {
    const store = new FakeConfigStore();
    store.connections.set("conn-1", {
      id: "conn-1",
      brandId: "brand-a",
      provider: CommerceProvider.COMMERCE7,
      status: "CONNECTED",
      storefrontUrl: "https://shop.example.com",
      providerMetadata: { currencyCode: "USD", productRoute: "/product" },
    });
    store.products.set("p1", {
      connectionId: "conn-1",
      currencyCode: "USD",
      priceMinMinor: 1000,
      priceMaxMinor: 1000,
      priceMinorUnitExponent: 2,
      hasPublicStorefrontUrl: true,
    });

    const result = await syncCommerce7ConnectionSettings(
      { brandId: "brand-a", connectionId: "conn-1" },
      {
        getConnection: async () => connectionSummary({ storefrontUrl: "https://shop.example.com", currencyCode: "USD" }),
        fetchSettings: async () => ({ storefrontUrl: "https://shop.example.com", currencyCode: "CAD", productRoute: "/product" }),
        configure: (input) =>
          configureCommerce7Storefront(input, { runInTransaction: (fn) => store.runInTransaction(fn as never) }),
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.requiresProductSync, true);
    assert.deepEqual(store.currencyInvalidatedFor, ["conn-1"]);
    assert.equal(store.products.get("p1")!.currencyCode, null);
    assert.equal(store.products.get("p1")!.priceMinMinor, null);
  });

  test("unchanged settings (idempotent re-sync) invalidate nothing", async () => {
    const store = new FakeConfigStore();
    store.connections.set("conn-1", {
      id: "conn-1",
      brandId: "brand-a",
      provider: CommerceProvider.COMMERCE7,
      status: "CONNECTED",
      storefrontUrl: "https://shop.example.com",
      providerMetadata: { currencyCode: "USD", productRoute: "/product" },
    });

    const result = await syncCommerce7ConnectionSettings(
      { brandId: "brand-a", connectionId: "conn-1" },
      {
        getConnection: async () => connectionSummary({ storefrontUrl: "https://shop.example.com", currencyCode: "USD" }),
        fetchSettings: async () => ({ storefrontUrl: "https://shop.example.com", currencyCode: "USD", productRoute: "/product" }),
        configure: (input) =>
          configureCommerce7Storefront(input, { runInTransaction: (fn) => store.runInTransaction(fn as never) }),
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.requiresProductSync, false);
    assert.deepEqual(store.currencyInvalidatedFor, []);
  });

  test("a Commerce7-reported invalid storefront URL writes NOTHING — no partial configuration", async () => {
    const store = new FakeConfigStore();
    store.connections.set("conn-1", {
      id: "conn-1",
      brandId: "brand-a",
      provider: CommerceProvider.COMMERCE7,
      status: "CONNECTED",
      storefrontUrl: "https://old.example.com",
      providerMetadata: { currencyCode: "USD", productRoute: "/product" },
    });

    const result = await syncCommerce7ConnectionSettings(
      { brandId: "brand-a", connectionId: "conn-1" },
      {
        getConnection: async () => connectionSummary({ storefrontUrl: "https://old.example.com", currencyCode: "USD" }),
        fetchSettings: async () => ({ storefrontUrl: "http://not-https.example.com", currencyCode: "USD", productRoute: "/product" }),
        configure: (input) =>
          configureCommerce7Storefront(input, { runInTransaction: (fn) => store.runInTransaction(fn as never) }),
      },
    );

    assert.equal(result.ok, false);
    assert.equal(store.connections.get("conn-1")!.storefrontUrl, "https://old.example.com", "the OLD value must be untouched");
  });
});
