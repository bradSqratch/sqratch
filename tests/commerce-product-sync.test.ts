process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY ||= "test-shopify-api-key";
process.env.SHOPIFY_API_SECRET ||= "test-shopify-api-secret";
process.env.APP_ENCRYPTION_KEY ||= "test-encryption-key-for-commerce-product-sync-tests";

/**
 * tests/commerce-product-sync.test.ts
 *
 * Unit tests for the provider-neutral product persistence service
 * (`src/lib/commerce/product-sync.ts`). Every dependency (connection lookup,
 * adapter resolution, brand currency, existing-row lookup, sync-run
 * create/finalize, per-product write, mark-unavailable) is injected via
 * `ProductSyncDeps` and backed by an in-memory `FakeStore` — no real DB, no
 * real network anywhere in this file.
 *
 * Covered cases (numbered to match the task's review checklist):
 *  1.  Uniqueness is connection-scoped: same externalId under two different connectionIds creates two rows.
 *  2.  Repeated sync is idempotent: second run all unchanged, writes only lastSeenAt/lastSyncRunId.
 *  3.  Changed title updates the row.
 *  4.  Changed image updates the row.
 *  5.  Changed price updates minor units correctly.
 *  6.  Currency correct; null-currency brand yields null currency AND null prices, never "USD".
 *  7.  Changed SKU updates safely.
 *  8.  A product absent from a complete successful sync becomes unavailable once, never deleted.
 *  9.  A FAILED sync marks nothing unavailable.
 *  10. A TRUNCATED/PARTIAL sync (hasNextPage true) marks nothing unavailable.
 *  11. The existing catalog survives a provider error unchanged.
 *  12. A reappearing product is restored to available and unavailableSince cleared.
 *  13. Sync statistics are correct across create/update/unchanged/markedUnavailable/failed.
 *  14. A legacy-fallback brand (summary.id === null) and a brand with no connection both return
 *      an explicit SKIPPED outcome, not a silent success, and write nothing.
 *  15. providerMetadata contains ONLY whitelisted fields.
 *  16. COMMERCE7 is controlled: UnsupportedProviderError, no network call.
 *
 * Bonus coverage: the capability guard (an adapter that reports
 * canSyncProducts:false) also throws before any run row is created.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CommerceProvider, type Prisma } from "@prisma/client";

import {
  syncBrandCommerceProducts,
  type ProductSyncDeps,
  type ExistingConnectedProductRow,
  type ProductWriteDecision,
} from "../src/lib/commerce/product-sync";
import { CommerceProviderApiError, UnsupportedCapabilityError, UnsupportedProviderError } from "../src/lib/commerce/errors";
import type { CommerceAdapter } from "../src/lib/commerce/adapter";
import type {
  CommerceCapabilities,
  CommerceConnectionSummary,
  CommerceProduct,
  ProductSyncPageResult,
  ProductSyncResult,
} from "../src/lib/commerce/types";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeSummary(overrides: Partial<CommerceConnectionSummary> = {}): CommerceConnectionSummary {
  return {
    id: "conn-1",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED",
    displayName: "Test Store",
    externalAccountId: "test-shop.myshopify.com",
    storefrontUrl: "https://test-shop.myshopify.com",
    isPrimary: true,
    grantedScopes: ["read_products"],
    installedAt: new Date("2026-01-01T00:00:00Z"),
    uninstalledAt: null,
    lastProductSyncAt: null,
    isLegacyFallback: false,
    ...overrides,
  };
}

function makeProduct(overrides: Partial<CommerceProduct> = {}): CommerceProduct {
  return {
    externalId: "gid://shopify/Product/1",
    title: "Test Product",
    handle: "test-product",
    productUrl: "https://test-shop.myshopify.com/products/test-product",
    imageUrl: "https://cdn.example.com/image.jpg",
    images: ["https://cdn.example.com/image.jpg"],
    priceText: "$19.99",
    // Deliberately unreliable — the service must NEVER read this field.
    currency: "USD",
    priceRange: { min: 19.99, max: 19.99 },
    externalVariantIds: ["1001"],
    descriptionText: "A test product.",
    sku: "SKU-1",
    status: "ACTIVE",
    providerCreatedAt: new Date("2026-01-01T00:00:00Z"),
    providerUpdatedAt: new Date("2026-01-02T00:00:00Z"),
    priceRangeRaw: { min: "19.99", max: "19.99" },
    ...overrides,
  };
}

function makeSyncResult(
  connectionId: string,
  products: CommerceProduct[],
  overrides: Partial<ProductSyncResult> = {},
): ProductSyncResult {
  return {
    connectionId,
    provider: CommerceProvider.SHOPIFY,
    products,
    productCount: products.length,
    syncedAt: new Date(),
    hasNextPage: false,
    limit: 50,
    ...overrides,
  };
}

function makeAdapter(
  syncProductsImpl: (connectionId: string) => Promise<ProductSyncResult>,
  capabilities: Partial<CommerceCapabilities> = {},
): CommerceAdapter {
  return {
    provider: CommerceProvider.SHOPIFY,
    getCapabilities(): CommerceCapabilities {
      return {
        canSyncProducts: true,
        canCreateDiscount: false,
        canRevokeDiscount: false,
        canVerifyWebhooks: false,
        ...capabilities,
      };
    },
    async getConnection() {
      throw new Error("getConnection should not be called in product-sync tests");
    },
    syncProducts: syncProductsImpl,
  };
}

function makePagedAdapter(
  fetchPage: (cursor: string | null, limit: number) => Promise<ProductSyncPageResult>,
  onComplete?: (connectionId: string, completedAt: Date) => Promise<void>,
): CommerceAdapter {
  return {
    provider: CommerceProvider.SHOPIFY,
    getCapabilities(): CommerceCapabilities {
      return {
        canSyncProducts: true,
        canCreateDiscount: false,
        canRevokeDiscount: false,
        canVerifyWebhooks: false,
      };
    },
    async getConnection() {
      throw new Error("getConnection should not be called in product-sync tests");
    },
    async syncProducts() {
      throw new Error("legacy syncProducts should not be called for a paged adapter");
    },
    async fetchProductPage(connectionId, request) {
      assert.equal(connectionId, "conn-1");
      return fetchPage(request.cursor ?? null, request.limit ?? 0);
    },
    completeProductSync: onComplete,
  };
}

function makePage(
  products: CommerceProduct[],
  options: Partial<Omit<ProductSyncPageResult, "products" | "fetchedAt" | "limit">> = {},
): ProductSyncPageResult {
  return {
    products,
    nextCursor: null,
    isComplete: true,
    fetchedAt: new Date("2026-08-06T00:00:00Z"),
    limit: 100,
    ...options,
  };
}

// ---------------------------------------------------------------------------
// In-memory store + deps
// ---------------------------------------------------------------------------

type StoredRow = {
  id: string;
  connectionId: string;
  brandId: string;
  provider: CommerceProvider;
  externalKey: string;
  externalId: string;
  title: string;
  handle: string | null;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  externalVariantIds: string[];
  descriptionText: string | null;
  sku: string | null;
  currencyCode: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  priceMinorUnitExponent: number | null;
  isAvailable: boolean;
  firstSeenAt: Date;
  lastSeenAt: Date;
  unavailableSince: Date | null;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
  providerMetadata: Prisma.JsonObject;
  lastSyncRunId: string | null;
};

type StoredRun = {
  id: string;
  connectionId: string;
  brandId: string;
  provider: CommerceProvider;
  triggeredBy: string | null;
  status: string;
  finishedAt?: Date;
  stats?: unknown;
  hasNextPage?: boolean;
  requestedLimit?: number | null;
  failureSummary?: string | null;
};

class FakeStore {
  nextId = 1;
  rows = new Map<string, StoredRow>();
  runs = new Map<string, StoredRun>();
  connections = new Map<string, CommerceConnectionSummary | null>();
  brandCurrency = new Map<string, string | null>();
  adapters = new Map<CommerceProvider, CommerceAdapter>();
  /** rowId -> field names actually written by the most recent applyProductWrite call for that row. */
  lastWriteFields = new Map<string, string[]>();
  getAdapterCalls = 0;

  rowsForConnection(connectionId: string): StoredRow[] {
    return [...this.rows.values()].filter((row) => row.connectionId === connectionId);
  }
}

function makeDeps(store: FakeStore, overrides: Partial<ProductSyncDeps> = {}): ProductSyncDeps {
  return {
    async getActiveConnection(brandId) {
      return store.connections.has(brandId) ? store.connections.get(brandId)! : null;
    },
    getAdapter(summary) {
      store.getAdapterCalls += 1;
      const adapter = store.adapters.get(summary.provider);
      if (!adapter) {
        throw new UnsupportedProviderError(summary.provider);
      }
      return adapter;
    },
    async getBrandCurrencyCode(brandId) {
      return store.brandCurrency.has(brandId) ? store.brandCurrency.get(brandId)! : null;
    },
    async findExistingProducts(connectionId): Promise<ExistingConnectedProductRow[]> {
      return store.rowsForConnection(connectionId).map((row) => ({
        id: row.id,
        externalKey: row.externalKey,
        title: row.title,
        handle: row.handle,
        productUrl: row.productUrl,
        imageUrl: row.imageUrl,
        images: row.images,
        externalVariantIds: row.externalVariantIds,
        descriptionText: row.descriptionText,
        sku: row.sku,
        currencyCode: row.currencyCode,
        priceMinMinor: row.priceMinMinor,
        priceMaxMinor: row.priceMaxMinor,
        priceMinorUnitExponent: row.priceMinorUnitExponent,
        isAvailable: row.isAvailable,
        unavailableSince: row.unavailableSince,
        providerMetadata: row.providerMetadata,
      }));
    },
    async createSyncRun(input) {
      const id = `run-${store.nextId++}`;
      store.runs.set(id, { id, ...input, status: "RUNNING" });
      return { id };
    },
    async finalizeSyncRun(runId, input) {
      const existing = store.runs.get(runId);
      if (!existing) throw new Error(`unknown run ${runId}`);
      store.runs.set(runId, { ...existing, ...input });
    },
    async applyProductWrite(connectionId, brandId, provider, externalKey, decision: ProductWriteDecision) {
      if (decision.kind === "CREATE") {
        const id = `prod-${store.nextId++}`;
        const row: StoredRow = {
          id,
          connectionId,
          brandId,
          provider,
          externalKey,
          firstSeenAt: decision.data.lastSeenAt,
          ...decision.data,
        };
        store.rows.set(id, row);
        store.lastWriteFields.set(id, Object.keys(decision.data));
        return;
      }
      if (decision.kind === "UPDATE") {
        const existing = store.rows.get(decision.existingId);
        if (!existing) throw new Error(`unknown row ${decision.existingId}`);
        store.rows.set(decision.existingId, { ...existing, ...decision.data });
        store.lastWriteFields.set(decision.existingId, Object.keys(decision.data));
        return;
      }
      const existing = store.rows.get(decision.existingId);
      if (!existing) throw new Error(`unknown row ${decision.existingId}`);
      store.rows.set(decision.existingId, {
        ...existing,
        lastSeenAt: decision.lastSeenAt,
        lastSyncRunId: decision.lastSyncRunId,
      });
      store.lastWriteFields.set(decision.existingId, ["lastSeenAt", "lastSyncRunId"]);
    },
    async markUnavailableExcept(connectionId, seenExternalKeys, now, runId) {
      let count = 0;
      for (const row of store.rows.values()) {
        if (row.connectionId === connectionId && row.isAvailable && !seenExternalKeys.includes(row.externalKey)) {
          row.isAvailable = false;
          row.unavailableSince = now;
          row.lastSyncRunId = runId;
          count += 1;
        }
      }
      return { count };
    },
    ...overrides,
  };
}

function setupBrand(
  store: FakeStore,
  brandId: string,
  connectionId: string,
  adapter: CommerceAdapter,
  currency: string | null = "USD",
): void {
  store.connections.set(brandId, makeSummary({ id: connectionId, brandId }));
  store.brandCurrency.set(brandId, currency);
  store.adapters.set(CommerceProvider.SHOPIFY, adapter);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncBrandCommerceProducts", () => {
  test("1. same externalId under two different connectionIds creates two rows", async () => {
    const store = new FakeStore();
    const product = makeProduct({ externalId: "gid://shopify/Product/1" });
    const adapter = makeAdapter(async (connectionId) => makeSyncResult(connectionId, [product]));
    setupBrand(store, "brand-A", "conn-A", adapter);
    setupBrand(store, "brand-B", "conn-B", adapter);

    const outcomeA = await syncBrandCommerceProducts("brand-A", CommerceProvider.SHOPIFY, {}, makeDeps(store));
    const outcomeB = await syncBrandCommerceProducts("brand-B", CommerceProvider.SHOPIFY, {}, makeDeps(store));

    assert.equal(outcomeA.status, "SUCCEEDED");
    assert.equal(outcomeB.status, "SUCCEEDED");

    const rows = [...store.rows.values()].filter((row) => row.externalKey === "gid://shopify/Product/1");
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].connectionId, rows[1].connectionId);
  });

  test("2. repeated sync is idempotent: second run all unchanged, writes only lastSeenAt/lastSyncRunId", async () => {
    const store = new FakeStore();
    const product = makeProduct();
    const adapter = makeAdapter(async (connectionId) => makeSyncResult(connectionId, [product]));
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    const first = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(first.status, "SUCCEEDED");
    if (first.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(first.stats.createdCount, 1);

    const second = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(second.status, "SUCCEEDED");
    if (second.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(second.stats.unchangedCount, 1);
    assert.equal(second.stats.createdCount, 0);
    assert.equal(second.stats.updatedCount, 0);

    assert.equal(store.rows.size, 1);
    const [row] = [...store.rows.values()];
    assert.deepEqual(store.lastWriteFields.get(row.id), ["lastSeenAt", "lastSyncRunId"]);
  });

  test("3. changed title updates the row", async () => {
    const store = new FakeStore();
    let title = "Original Title";
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [makeProduct({ title })]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    title = "Updated Title";
    const second = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    assert.equal(second.status, "SUCCEEDED");
    if (second.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(second.stats.updatedCount, 1);
    assert.equal(second.stats.unchangedCount, 0);
    const [row] = [...store.rows.values()];
    assert.equal(row.title, "Updated Title");
  });

  test("4. changed image updates the row", async () => {
    const store = new FakeStore();
    let imageUrl = "https://cdn.example.com/a.jpg";
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [makeProduct({ imageUrl, images: [imageUrl] })]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    imageUrl = "https://cdn.example.com/b.jpg";
    const second = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    assert.equal(second.status, "SUCCEEDED");
    if (second.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(second.stats.updatedCount, 1);
    const [row] = [...store.rows.values()];
    assert.equal(row.imageUrl, "https://cdn.example.com/b.jpg");
    assert.deepEqual(row.images, ["https://cdn.example.com/b.jpg"]);
  });

  test("5. changed price updates minor units correctly", async () => {
    const store = new FakeStore();
    let raw = { min: "24.99", max: "29.99" };
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [makeProduct({ priceRangeRaw: raw })]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");
    const deps = makeDeps(store);

    const first = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(first.status, "SUCCEEDED");
    let [row] = [...store.rows.values()];
    assert.equal(row.priceMinMinor, 2499);
    assert.equal(row.priceMaxMinor, 2999);
    assert.equal(row.priceMinorUnitExponent, 2);

    raw = { min: "34.99", max: "39.99" };
    const second = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(second.status, "SUCCEEDED");
    if (second.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(second.stats.updatedCount, 1);
    [row] = [...store.rows.values()];
    assert.equal(row.priceMinMinor, 3499);
    assert.equal(row.priceMaxMinor, 3999);
  });

  test("6. currency is correct for a known-currency brand, and null-currency brand yields null currency AND null prices, never USD", async () => {
    // Known currency (JPY, exponent 0) — never "USD" even though the
    // provider's own (unreliable) CommerceProduct.currency field says "USD".
    const storeKnown = new FakeStore();
    const adapterKnown = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [
        makeProduct({ currency: "USD", priceRangeRaw: { min: "1500", max: "2000" } }),
      ]),
    );
    setupBrand(storeKnown, "brand-1", "conn-1", adapterKnown, "JPY");
    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, makeDeps(storeKnown));
    const [knownRow] = [...storeKnown.rows.values()];
    assert.equal(knownRow.currencyCode, "JPY");
    assert.notEqual(knownRow.currencyCode, "USD");
    assert.equal(knownRow.priceMinMinor, 1500);
    assert.equal(knownRow.priceMinorUnitExponent, 0);

    // Unknown/null brand currency — everything price-related is null.
    const storeUnknown = new FakeStore();
    const adapterUnknown = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [makeProduct({ currency: "USD" })]),
    );
    setupBrand(storeUnknown, "brand-2", "conn-2", adapterUnknown, null);
    await syncBrandCommerceProducts("brand-2", CommerceProvider.SHOPIFY, {}, makeDeps(storeUnknown));
    const [unknownRow] = [...storeUnknown.rows.values()];
    assert.equal(unknownRow.currencyCode, null);
    assert.equal(unknownRow.priceMinMinor, null);
    assert.equal(unknownRow.priceMaxMinor, null);
    assert.equal(unknownRow.priceMinorUnitExponent, null);
  });

  test("7. changed SKU updates safely", async () => {
    const store = new FakeStore();
    let sku = "SKU-OLD";
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [makeProduct({ sku })]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    sku = "SKU-NEW";
    const second = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    assert.equal(second.status, "SUCCEEDED");
    if (second.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(second.stats.updatedCount, 1);
    const [row] = [...store.rows.values()];
    assert.equal(row.sku, "SKU-NEW");
  });

  test("8. a product absent from a complete successful sync becomes unavailable once, never deleted", async () => {
    const store = new FakeStore();
    const productA = makeProduct({ externalId: "A" });
    const productB = makeProduct({ externalId: "B" });
    let products = [productA, productB];
    const adapter = makeAdapter(async (connectionId) => makeSyncResult(connectionId, products));
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    products = [productA]; // B disappears
    const second = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(second.status, "SUCCEEDED");
    if (second.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(second.stats.markedUnavailableCount, 1);

    const rowB = [...store.rows.values()].find((row) => row.externalKey === "B")!;
    assert.equal(rowB.isAvailable, false);
    const firstUnavailableSince = rowB.unavailableSince;
    assert.ok(firstUnavailableSince);

    // Third sync: still absent — must not re-stamp unavailableSince, and must not delete.
    const third = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(third.status, "SUCCEEDED");
    if (third.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(third.stats.markedUnavailableCount, 0);
    const rowBAgain = store.rows.get(rowB.id);
    assert.ok(rowBAgain, "row must never be hard-deleted");
    assert.equal(rowBAgain!.unavailableSince!.getTime(), firstUnavailableSince!.getTime());
  });

  test("9. a FAILED sync marks nothing unavailable", async () => {
    const store = new FakeStore();
    const product = makeProduct();
    let shouldFail = false;
    const adapter = makeAdapter(async (connectionId) => {
      if (shouldFail) {
        throw new CommerceProviderApiError(CommerceProvider.SHOPIFY, "Simulated provider outage.");
      }
      return makeSyncResult(connectionId, [product]);
    });
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    const [rowBefore] = [...store.rows.values()];
    assert.equal(rowBefore.isAvailable, true);

    shouldFail = true;
    const failed = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(failed.status, "FAILED");
    if (failed.status !== "FAILED") throw new Error("unreachable");
    assert.equal(failed.stats.markedUnavailableCount, 0);

    const [rowAfter] = [...store.rows.values()];
    assert.equal(rowAfter.isAvailable, true);
  });

  test("10. a TRUNCATED/PARTIAL sync (hasNextPage true) marks nothing unavailable", async () => {
    const store = new FakeStore();
    const productA = makeProduct({ externalId: "A" });
    const productB = makeProduct({ externalId: "B" });
    let hasNextPage = false;
    let products = [productA, productB];
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, products, { hasNextPage }),
    );
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    // Second run only sees page 1 (product A) and reports hasNextPage: true —
    // B is simply not on the page fetched, not genuinely gone.
    products = [productA];
    hasNextPage = true;
    const partial = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(partial.status, "PARTIAL");
    if (partial.status !== "PARTIAL") throw new Error("unreachable");
    assert.equal(partial.stats.markedUnavailableCount, 0);
    assert.ok(partial.failureSummary && partial.failureSummary.length > 0);

    const rowB = [...store.rows.values()].find((row) => row.externalKey === "B")!;
    assert.equal(rowB.isAvailable, true);
  });

  test("11. the existing catalog survives a provider error unchanged", async () => {
    const store = new FakeStore();
    const product = makeProduct();
    let shouldFail = false;
    const adapter = makeAdapter(async (connectionId) => {
      if (shouldFail) {
        throw new CommerceProviderApiError(CommerceProvider.SHOPIFY, "Simulated provider outage.");
      }
      return makeSyncResult(connectionId, [product]);
    });
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    const before = JSON.stringify([...store.rows.values()]);

    shouldFail = true;
    const failed = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(failed.status, "FAILED");

    const after = JSON.stringify([...store.rows.values()]);
    assert.equal(after, before);
  });

  test("12. a reappearing product is restored to available with unavailableSince cleared", async () => {
    const store = new FakeStore();
    const productA = makeProduct({ externalId: "A" });
    const productB = makeProduct({ externalId: "B" });
    let products = [productA, productB];
    const adapter = makeAdapter(async (connectionId) => makeSyncResult(connectionId, products));
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    products = [productA];
    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    const rowB = [...store.rows.values()].find((row) => row.externalKey === "B")!;
    assert.equal(rowB.isAvailable, false);
    assert.ok(rowB.unavailableSince);

    products = [productA, productB];
    const third = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(third.status, "SUCCEEDED");
    if (third.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(third.stats.markedUnavailableCount, 0);

    const rowBAfter = store.rows.get(rowB.id)!;
    assert.equal(rowBAfter.isAvailable, true);
    assert.equal(rowBAfter.unavailableSince, null);
  });

  test("13. sync statistics are correct across create/update/unchanged/markedUnavailable, and across a failed run", async () => {
    const store = new FakeStore();
    const productA = makeProduct({ externalId: "A", title: "A" });
    const productB = makeProduct({ externalId: "B", title: "B" });
    const productC = makeProduct({ externalId: "C", title: "C" });
    let products = [productA, productB, productC];
    const adapter = makeAdapter(async (connectionId) => makeSyncResult(connectionId, products));
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    const first = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(first.status, "SUCCEEDED");
    if (first.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.deepEqual(
      { created: first.stats.createdCount, updated: first.stats.updatedCount, unchanged: first.stats.unchangedCount },
      { created: 3, updated: 0, unchanged: 0 },
    );

    // A unchanged, B's title changes, C disappears, D is new.
    const productBChanged = makeProduct({ externalId: "B", title: "B changed" });
    const productD = makeProduct({ externalId: "D", title: "D" });
    products = [productA, productBChanged, productD];
    const second = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(second.status, "SUCCEEDED");
    if (second.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(second.stats.fetchedCount, 3);
    assert.equal(second.stats.createdCount, 1); // D
    assert.equal(second.stats.updatedCount, 1); // B
    assert.equal(second.stats.unchangedCount, 1); // A
    assert.equal(second.stats.markedUnavailableCount, 1); // C
    assert.equal(second.stats.failedCount, 0);

    // A FAILED run reports failedCount and every other counter at zero.
    const failingAdapter = makeAdapter(async () => {
      throw new CommerceProviderApiError(CommerceProvider.SHOPIFY, "boom");
    });
    store.adapters.set(CommerceProvider.SHOPIFY, failingAdapter);
    const failed = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(failed.status, "FAILED");
    if (failed.status !== "FAILED") throw new Error("unreachable");
    assert.deepEqual(failed.stats, {
      fetchedCount: 0,
      createdCount: 0,
      updatedCount: 0,
      unchangedCount: 0,
      markedUnavailableCount: 0,
      failedCount: 1,
    });
  });

  test("14. a legacy-fallback brand and a brand with no connection both return SKIPPED and write nothing", async () => {
    const store = new FakeStore();
    store.connections.set(
      "brand-legacy",
      makeSummary({ id: null, isLegacyFallback: true, brandId: "brand-legacy" }),
    );
    // brand-none: no entry in store.connections at all -> getActiveConnection returns null.

    const legacyOutcome = await syncBrandCommerceProducts(
      "brand-legacy",
      CommerceProvider.SHOPIFY,
      {},
      makeDeps(store),
    );
    assert.deepEqual(legacyOutcome, {
      status: "SKIPPED",
      reason: "LEGACY_FALLBACK",
      brandId: "brand-legacy",
      provider: CommerceProvider.SHOPIFY,
    });

    const noConnectionOutcome = await syncBrandCommerceProducts(
      "brand-none",
      CommerceProvider.SHOPIFY,
      {},
      makeDeps(store),
    );
    assert.deepEqual(noConnectionOutcome, {
      status: "SKIPPED",
      reason: "NO_CONNECTION",
      brandId: "brand-none",
      provider: CommerceProvider.SHOPIFY,
    });

    assert.equal(store.rows.size, 0);
    assert.equal(store.runs.size, 0);
  });

  test("15. providerMetadata contains ONLY whitelisted fields", async () => {
    const store = new FakeStore();
    const product = makeProduct({
      status: "ACTIVE",
      priceText: "$19.99",
      providerCreatedAt: new Date("2026-01-01T00:00:00Z"),
      providerUpdatedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const adapter = makeAdapter(async (connectionId) => makeSyncResult(connectionId, [product]));
    setupBrand(store, "brand-1", "conn-1", adapter);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, makeDeps(store));

    const [row] = [...store.rows.values()];
    const keys = Object.keys(row.providerMetadata).sort();
    assert.deepEqual(keys, ["priceText", "providerCreatedAt", "providerUpdatedAt", "status"]);

    const serialized = JSON.stringify(row.providerMetadata);
    assert.equal(/token|secret|encrypted|password|authorization/i.test(serialized), false);
  });

  test("16. COMMERCE7 is controlled: throws UnsupportedProviderError, no network call", async () => {
    const store = new FakeStore();
    store.connections.set(
      "brand-c7",
      makeSummary({ id: "conn-c7", brandId: "brand-c7", provider: CommerceProvider.COMMERCE7 }),
    );
    // Deliberately do NOT register a CommerceProvider.COMMERCE7 adapter.

    await assert.rejects(
      () => syncBrandCommerceProducts("brand-c7", CommerceProvider.COMMERCE7, {}, makeDeps(store)),
      (error: unknown) => error instanceof UnsupportedProviderError,
    );

    assert.equal(store.runs.size, 0);
    assert.equal(store.rows.size, 0);
  });

  test("17. a mid-loop per-product write failure increments failedCount, does not abort remaining products, finalizes the run (never RUNNING), and marks nothing unavailable", async () => {
    const store = new FakeStore();
    const productA = makeProduct({ externalId: "A" });
    const productB = makeProduct({ externalId: "B" }); // this one's write will fail
    const productC = makeProduct({ externalId: "C" });
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [productA, productB, productC]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter);

    const deps = makeDeps(store, {
      async applyProductWrite(connectionId, brandId, provider, externalKey, decision) {
        if (externalKey === "B") {
          throw new Error("simulated transient connection reset on product B");
        }
        // Delegate to the real fake-store writer for every other product by
        // re-implementing the same CREATE/UPDATE/TOUCH branches makeDeps
        // uses internally (kept in sync with that helper deliberately).
        if (decision.kind === "CREATE") {
          const id = `prod-${store.nextId++}`;
          store.rows.set(id, {
            id,
            connectionId,
            brandId,
            provider,
            externalKey,
            firstSeenAt: decision.data.lastSeenAt,
            ...decision.data,
          });
          return;
        }
        throw new Error(`unexpected decision kind in test: ${decision.kind}`);
      },
    });

    const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    // Two of three products succeeded -> PARTIAL, not FAILED (not everything failed)
    // and not SUCCEEDED (one write did fail).
    assert.equal(outcome.status, "PARTIAL");

    assert.equal(outcome.stats.failedCount, 1);
    assert.equal(outcome.stats.createdCount, 2); // A and C still got written
    // The mark-unavailable hard rule: a run with any write failure must not
    // mark anything unavailable, exactly like a TRUNCATED/PARTIAL run.
    assert.equal(outcome.stats.markedUnavailableCount, 0);
    assert.ok(outcome.failureSummary && outcome.failureSummary.length > 0);
    assert.equal(/error|Error/.test(outcome.failureSummary ?? ""), false, "must not embed a raw error object/message pattern beyond the sanitized classified summary");

    // The stored run row itself must be terminal, never left RUNNING.
    const [storedRun] = [...store.runs.values()];
    assert.notEqual(storedRun.status, "RUNNING");
    assert.equal(storedRun.status, "PARTIAL");

    // Products A and C were actually persisted despite B's failure.
    const persistedKeys = [...store.rows.values()].map((row) => row.externalKey).sort();
    assert.deepEqual(persistedKeys, ["A", "C"]);
  });

  test("18. an out-of-range (int4-overflowing) price on one bound stores null for that bound only, and does not throw or strand the run", async () => {
    const store = new FakeStore();
    // IDR-shaped case from the Phase 3 review: brand currency not in the
    // known-exponent map defaults to exponent 2; an ordinary ~US$1,500 IDR
    // price (25,000,000.00) converts to 2,500,000,000 minor units, which
    // exceeds Postgres int4. The max bound is a normal, in-range price.
    const product = makeProduct({
      externalId: "overflow-product",
      priceRangeRaw: { min: "25000000.00", max: "19.99" },
    });
    const adapter = makeAdapter(async (connectionId) => makeSyncResult(connectionId, [product]));
    setupBrand(store, "brand-1", "conn-1", adapter, "IDR");
    const deps = makeDeps(store);

    const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    // Must not throw or strand the run — it completes as a clean SUCCEEDED
    // (the write itself succeeded; only one price bound is null).
    assert.equal(outcome.status, "SUCCEEDED");
    if (outcome.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(outcome.stats.failedCount, 0);
    assert.equal(outcome.stats.createdCount, 1);

    const [row] = [...store.rows.values()];
    assert.equal(row.priceMinMinor, null, "the out-of-range bound must be null, not a wrapped/truncated garbage value");
    assert.equal(row.priceMaxMinor, 1999, "the in-range bound must be unaffected by the other bound's failure");
  });

  test("19. paged sync follows opaque cursors, persists all unique products, and deterministically keeps the latest duplicate", async () => {
    const store = new FakeStore();
    const calls: Array<{ cursor: string | null; limit: number }> = [];
    const completed: string[] = [];
    const productA = makeProduct({ externalId: "A", title: "A" });
    const olderShared = makeProduct({ externalId: "shared", title: "Old shared title" });
    const newerShared = makeProduct({ externalId: "shared", title: "New shared title" });
    const productB = makeProduct({ externalId: "B", title: "B" });
    const adapter = makePagedAdapter(
      async (cursor, limit) => {
        calls.push({ cursor, limit });
        if (cursor === null) {
          return makePage([productA, olderShared], { isComplete: false, nextCursor: "page-2" });
        }
        assert.equal(cursor, "page-2");
        return makePage([newerShared, productB]);
      },
      async (connectionId) => {
        completed.push(connectionId);
      },
    );
    setupBrand(store, "brand-1", "conn-1", adapter);

    const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, makeDeps(store));

    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(outcome.stats.fetchedCount, 3, "duplicate page data must not inflate processed statistics");
    assert.equal(outcome.stats.createdCount, 3);
    assert.deepEqual(calls, [
      { cursor: null, limit: 100 },
      { cursor: "page-2", limit: 100 },
    ]);
    assert.deepEqual(completed, ["conn-1"]);
    assert.equal(store.rowsForConnection("conn-1").find((row) => row.externalKey === "shared")?.title, "New shared title");
  });

  test("20. a provider failure after a successful page is PARTIAL and never reconciles absence", async () => {
    const store = new FakeStore();
    const productA = makeProduct({ externalId: "A" });
    const productB = makeProduct({ externalId: "B" });
    let run = 0;
    const adapter = makePagedAdapter(async (cursor) => {
      if (run === 0) return makePage([productA, productB]);
      if (cursor === null) return makePage([productA], { isComplete: false, nextCursor: "page-2" });
      throw new CommerceProviderApiError(CommerceProvider.SHOPIFY, "page two unavailable");
    });
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    run = 1;
    const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    assert.equal(outcome.status, "PARTIAL");
    assert.equal(outcome.stats.failedCount, 1);
    assert.equal(outcome.stats.markedUnavailableCount, 0);
    assert.equal(store.rowsForConnection("conn-1").find((row) => row.externalKey === "B")?.isAvailable, true);
  });

  test("21. malformed and bounded cursors never reconcile absence; an empty failed catalog is FAILED", async () => {
    const cases: Array<{
      name: string;
      options: Parameters<typeof syncBrandCommerceProducts>[2];
      fetchPage: (cursor: string | null) => Promise<ProductSyncPageResult>;
      expectedTag: string;
      expectedStatus: "PARTIAL" | "FAILED";
    }> = [
      {
        name: "missing cursor",
        options: {},
        fetchPage: async () => makePage([makeProduct({ externalId: "A" })], { isComplete: false, nextCursor: null }),
        expectedTag: "MISSING_CURSOR",
        expectedStatus: "PARTIAL",
      },
      {
        name: "repeated cursor",
        options: {},
        fetchPage: async (cursor) =>
          cursor === null
            ? makePage([makeProduct({ externalId: "A" })], { isComplete: false, nextCursor: "same" })
            : makePage([makeProduct({ externalId: "B" })], { isComplete: false, nextCursor: "same" }),
        expectedTag: "CURSOR_LOOP",
        expectedStatus: "PARTIAL",
      },
      {
        name: "cursor cycle",
        options: {},
        fetchPage: async (cursor) =>
          cursor === null
            ? makePage([], { isComplete: false, nextCursor: "a" })
            : cursor === "a"
              ? makePage([], { isComplete: false, nextCursor: "b" })
              : makePage([], { isComplete: false, nextCursor: "a" }),
        expectedTag: "CURSOR_LOOP",
        expectedStatus: "FAILED",
      },
      {
        name: "page bound",
        options: { maxPages: 1 },
        fetchPage: async () => makePage([], { isComplete: false, nextCursor: "next" }),
        expectedTag: "MAX_PAGES_REACHED",
        expectedStatus: "FAILED",
      },
      {
        name: "product bound",
        options: { maxProducts: 1 },
        fetchPage: async () => makePage([makeProduct({ externalId: "A" }), makeProduct({ externalId: "B" })]),
        expectedTag: "MAX_PRODUCTS_REACHED",
        expectedStatus: "PARTIAL",
      },
    ];

    for (const scenario of cases) {
      const store = new FakeStore();
      const adapter = makePagedAdapter(async (cursor) => scenario.fetchPage(cursor));
      setupBrand(store, "brand-1", "conn-1", adapter);
      const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, scenario.options, makeDeps(store));
      assert.equal(outcome.status, scenario.expectedStatus, scenario.name);
      assert.equal(outcome.stats.markedUnavailableCount, 0, scenario.name);
      assert.match(outcome.failureSummary ?? "", new RegExp(scenario.expectedTag), scenario.name);
    }
  });

  test("22. elapsed-time guard prevents the second page and does not mark absence", async () => {
    const store = new FakeStore();
    const cursors: Array<string | null> = [];
    let clock = 0;
    const adapter = makePagedAdapter(async (cursor) => {
      cursors.push(cursor);
      clock = 100;
      return makePage([makeProduct({ externalId: "A" })], { isComplete: false, nextCursor: "page-2" });
    });
    setupBrand(store, "brand-1", "conn-1", adapter);

    const outcome = await syncBrandCommerceProducts(
      "brand-1",
      CommerceProvider.SHOPIFY,
      { maxDurationMs: 50, now: () => clock },
      makeDeps(store),
    );

    assert.equal(outcome.status, "PARTIAL");
    assert.deepEqual(cursors, [null]);
    assert.match(outcome.failureSummary ?? "", /PAGINATION_TIMEOUT/);
    assert.equal(outcome.stats.markedUnavailableCount, 0);
  });

  test("23. a reconciliation failure does not stamp connection completion", async () => {
    const store = new FakeStore();
    const completed: string[] = [];
    const adapter = makePagedAdapter(
      async () => makePage([makeProduct({ externalId: "A" })]),
      async (connectionId) => {
        completed.push(connectionId);
      },
    );
    setupBrand(store, "brand-1", "conn-1", adapter);

    const outcome = await syncBrandCommerceProducts(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {},
      makeDeps(store, {
        async markUnavailableExcept() {
          throw new Error("reconciliation failed");
        },
      }),
    );

    assert.equal(outcome.status, "PARTIAL");
    assert.deepEqual(completed, []);
  });

  test("bonus: an adapter without canSyncProducts throws UnsupportedCapabilityError before any run is created", async () => {
    const store = new FakeStore();
    const adapter = makeAdapter(
      async () => {
        throw new Error("syncProducts should not be called");
      },
      { canSyncProducts: false },
    );
    setupBrand(store, "brand-1", "conn-1", adapter);

    await assert.rejects(
      () => syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, makeDeps(store)),
      (error: unknown) => error instanceof UnsupportedCapabilityError,
    );
    assert.equal(store.runs.size, 0);
  });
});
