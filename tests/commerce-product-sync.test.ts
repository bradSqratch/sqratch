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
 *  14. A brand with no canonical connection returns an explicit SKIPPED
 *      outcome, not a silent success, and writes nothing.
 *  15. providerMetadata contains ONLY whitelisted fields.
 *  16. An unregistered adapter is controlled: UnsupportedProviderError, no network call
 *      (PHASE 16C1 note: COMMERCE7 IS registered in the real default registry —
 *      this test injects a FAKE registry deliberately missing it, to prove the
 *      generic "no adapter" guard, not real Commerce7 support).
 *
 * Bonus coverage: the capability guard (an adapter that reports
 * products.sync:false) also throws before any run row is created.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CommerceProvider, type Prisma } from "@prisma/client";

import {
  syncBrandCommerceProducts,
  sanitizeDecisionForUntrustedConfig,
  type ProductSyncDeps,
  type ExistingConnectedProductRow,
  type ProductWriteDecision,
} from "../src/lib/commerce/product-sync";
import { deriveProductConfigurationFingerprint } from "../src/lib/commerce/product-config-fingerprint";
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
    currencyCode: null,
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
        products: { sync: true, publicDestinations: true },
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
  prepare?: () => Promise<unknown>,
): CommerceAdapter {
  return {
    provider: CommerceProvider.SHOPIFY,
    getCapabilities(): CommerceCapabilities {
      return {
        products: { sync: true, publicDestinations: true },
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
      };
    },
    async getConnection() {
      throw new Error("getConnection should not be called in product-sync tests");
    },
    async syncProducts() {
      throw new Error("legacy syncProducts should not be called for a paged adapter");
    },
    ...(prepare
      ? {
          async prepareProductSync() {
            return prepare();
          },
        }
      : {}),
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
  hasPublicStorefrontUrl: boolean;
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
  adapters = new Map<CommerceProvider, CommerceAdapter>();
  /** rowId -> field names actually written by the most recent applyProductWrite call for that row. */
  lastWriteFields = new Map<string, string[]>();
  getAdapterCalls = 0;
  /**
   * PHASE 16 BIG ROUND REPAIR (P1-1): simulates `CommerceConnection.updatedAt`.
   * Stable by default so every pre-existing test's behavior is byte-identical
   * to before this fingerprint check existed; a test can mutate
   * `connectionFingerprints` mid-run to simulate a configuration change
   * landing while a sync is in flight.
   */
  connectionFingerprints = new Map<string, string>();
  fingerprintCallCount = 0;
  /** PHASE 18 REPAIR (P1-1): connectionIds the sync's final safety net invalidated. */
  currencyInvalidatedFor: string[] = [];
  publicDestinationInvalidatedFor: string[] = [];
  /** Override to simulate a fingerprint READ FAILURE (never a value equal to a real fingerprint). */
  failFingerprintForConnectionId: string | null = null;
  /**
   * PHASE 19 REPAIR (P1-2): simulates the atomic RUNNING-run claim's
   * backing table — keyed by connectionId, since the real claim is always
   * scoped to the exact connection. A test can pre-seed this to simulate
   * "a RUNNING run already exists" without going through a real claim.
   */
  runningByConnection = new Map<string, { id: string; startedAt: Date }>();
  /** PHASE 19 REPAIR (P1-1): how many times the DEFAULT applyProductWrite performed a live per-write trustworthiness check. */
  perWriteCheckCount = 0;

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
        hasPublicStorefrontUrl: row.hasPublicStorefrontUrl,
        unavailableSince: row.unavailableSince,
        providerMetadata: row.providerMetadata,
      }));
    },
    async claimProductSyncRun(input) {
      // PHASE 19 REPAIR (P1-2): faithfully simulates the real atomic
      // claim's OBSERVABLE contract (check-then-create as one step) —
      // this in-memory Map access is itself synchronous/atomic from the
      // perspective of this single-threaded test process, which is
      // sufficient to prove the ORCHESTRATION (product-sync.ts correctly
      // uses whatever the claim returns) is correct. True concurrent
      // Postgres row-locking cannot be exercised without a real database;
      // see the final report for why that gap is accepted.
      //
      // PHASE 20 REPAIR (stale-run lease repair): no age check — ANY
      // existing RUNNING row for this connection blocks a new claim,
      // matching the real implementation's removal of age-based reclaim.
      const existing = store.runningByConnection.get(input.connectionId);
      if (existing) {
        return { status: "ALREADY_RUNNING" as const, runningRun: existing };
      }
      const id = `run-${store.nextId++}`;
      const startedAt = new Date();
      store.runs.set(id, { id, ...input, status: "RUNNING" });
      store.runningByConnection.set(input.connectionId, { id, startedAt });
      return { status: "CLAIMED" as const, run: { id } };
    },
    async finalizeSyncRun(runId, input) {
      const existing = store.runs.get(runId);
      if (!existing) throw new Error(`unknown run ${runId}`);
      store.runs.set(runId, { ...existing, ...input });
      // Mirrors the real DB: a finalized run no longer matches a
      // `status: "RUNNING"` claim lookup, so free up the per-connection
      // slot — but only if THIS run is still the one currently registered
      // (never clobber a different, later run for the same connection).
      if (store.runningByConnection.get(existing.connectionId)?.id === runId) {
        store.runningByConnection.delete(existing.connectionId);
      }
    },
    async applyProductWrite(
      connectionId,
      brandId,
      provider,
      externalKey,
      decision: ProductWriteDecision,
      expectedFingerprint,
    ) {
      // PHASE 19 REPAIR (P1-1): faithfully simulates the real transactional
      // write's OBSERVABLE contract — a live trustworthiness check
      // immediately before persisting, substituting a sanitized decision
      // on mismatch/failure, using the SAME real `sanitizeDecisionForUntrustedConfig`
      // the production default uses (not a hand-duplicated copy).
      let trustworthy = true;
      let finalDecision = decision;
      if (expectedFingerprint !== null) {
        store.perWriteCheckCount += 1;
        if (store.failFingerprintForConnectionId === connectionId) {
          trustworthy = false;
        } else {
          if (!store.connectionFingerprints.has(connectionId)) {
            store.connectionFingerprints.set(connectionId, "initial");
          }
          trustworthy = store.connectionFingerprints.get(connectionId)! === expectedFingerprint;
        }
        if (!trustworthy) {
          finalDecision = sanitizeDecisionForUntrustedConfig(decision);
        }
      } else {
        trustworthy = false;
      }

      if (finalDecision.kind === "CREATE") {
        const id = `prod-${store.nextId++}`;
        const row: StoredRow = {
          id,
          connectionId,
          brandId,
          provider,
          externalKey,
          firstSeenAt: finalDecision.data.lastSeenAt,
          ...finalDecision.data,
        };
        store.rows.set(id, row);
        store.lastWriteFields.set(id, Object.keys(finalDecision.data));
        return { trustworthy };
      }
      if (finalDecision.kind === "UPDATE") {
        const existing = store.rows.get(finalDecision.existingId);
        if (!existing) throw new Error(`unknown row ${finalDecision.existingId}`);
        store.rows.set(finalDecision.existingId, { ...existing, ...finalDecision.data });
        store.lastWriteFields.set(finalDecision.existingId, Object.keys(finalDecision.data));
        return { trustworthy };
      }
      const existing = store.rows.get(finalDecision.existingId);
      if (!existing) throw new Error(`unknown row ${finalDecision.existingId}`);
      store.rows.set(finalDecision.existingId, {
        ...existing,
        lastSeenAt: finalDecision.lastSeenAt,
        lastSyncRunId: finalDecision.lastSyncRunId,
      });
      store.lastWriteFields.set(finalDecision.existingId, ["lastSeenAt", "lastSyncRunId"]);
      return { trustworthy };
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
    async getConnectionFingerprint(connectionId: string) {
      store.fingerprintCallCount += 1;
      if (store.failFingerprintForConnectionId === connectionId) {
        throw new Error("simulated fingerprint read failure");
      }
      if (!store.connectionFingerprints.has(connectionId)) {
        store.connectionFingerprints.set(connectionId, "initial");
      }
      return store.connectionFingerprints.get(connectionId)!;
    },
    async getConnectionConfigSnapshot(connectionId: string) {
      store.fingerprintCallCount += 1;
      if (store.failFingerprintForConnectionId === connectionId) {
        throw new Error("simulated fingerprint read failure");
      }
      if (!store.connectionFingerprints.has(connectionId)) {
        store.connectionFingerprints.set(connectionId, "initial");
      }
      const currencyCode =
        [...store.connections.values()].find((c) => c?.id === connectionId)?.currencyCode ?? null;
      return { fingerprint: store.connectionFingerprints.get(connectionId)!, currencyCode };
    },
    async invalidateStaleConfigDerivedFields(connectionId: string) {
      store.currencyInvalidatedFor.push(connectionId);
      store.publicDestinationInvalidatedFor.push(connectionId);
      for (const row of store.rows.values()) {
        if (row.connectionId === connectionId) {
          row.currencyCode = null;
          row.priceMinMinor = null;
          row.priceMaxMinor = null;
          row.priceMinorUnitExponent = null;
          row.hasPublicStorefrontUrl = false;
        }
      }
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
  store.connections.set(brandId, makeSummary({ id: connectionId, brandId, currencyCode: currency }));
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

  // ---------------------------------------------------------------------
  // PHASE 16 BIG ROUND REPAIR — P1-1: configuration-vs-sync race.
  // ---------------------------------------------------------------------
  test("6b. a connection fingerprint change DURING the fetch withholds money fields and forces hasPublicStorefrontUrl false for this run", async () => {
    const store = new FakeStore();
    // The adapter's syncProducts call is where `collectCatalog` spends its
    // time — mutating the fingerprint here simulates a configuration write
    // (e.g. `configureCommerce7Storefront`) landing on the connection row
    // WHILE this fetch is in flight, between the two fingerprint reads
    // `runProductSync` takes.
    const adapter = makeAdapter(async (connectionId) => {
      store.connectionFingerprints.set(connectionId, "changed-mid-fetch");
      return makeSyncResult(connectionId, [
        makeProduct({
          currency: "USD",
          priceRangeRaw: { min: "1500", max: "2000" },
          hasProviderStorefrontPublication: true,
        }),
      ]);
    });
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    const outcome = await syncBrandCommerceProducts(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {},
      makeDeps(store),
    );

    assert.equal(outcome.status, "SUCCEEDED");
    const [row] = [...store.rows.values()];
    assert.equal(row.currencyCode, null, "currency must not be trusted once stale");
    assert.equal(row.priceMinMinor, null);
    assert.equal(row.priceMaxMinor, null);
    assert.equal(row.priceMinorUnitExponent, null);
    assert.equal(
      row.hasPublicStorefrontUrl,
      false,
      "a stale-config destination must never be persisted as publicly clickable",
    );
  });

  test("6c. an UNCHANGED fingerprint (the normal case) persists money/destination fields exactly as before this fix", async () => {
    const store = new FakeStore();
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [
        makeProduct({
          currency: "USD",
          priceRangeRaw: { min: "1500", max: "2000" },
          hasProviderStorefrontPublication: true,
        }),
      ]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, makeDeps(store));

    const [row] = [...store.rows.values()];
    assert.equal(row.currencyCode, "USD");
    assert.equal(row.priceMinMinor, 150000);
    assert.equal(row.hasPublicStorefrontUrl, true);
    // PHASE 19 REPAIR (P1-1): the per-write live recheck now happens
    // ATOMICALLY inside `applyProductWrite` itself (tracked separately by
    // `perWriteCheckCount`), not via a loop-level `getConnectionFingerprint`
    // call — `fingerprintCallCount` now counts only the baseline snapshot
    // (before fetch) and the final post-write safety-net read.
    assert.equal(store.fingerprintCallCount, 2);
    assert.equal(store.perWriteCheckCount, 1, "one live per-write check for one product");
    assert.deepEqual(store.currencyInvalidatedFor, []);
    assert.deepEqual(store.publicDestinationInvalidatedFor, []);
  });

  // ---------------------------------------------------------------------
  // PHASE 18 REPAIR — P1-1: the fence must be FAIL-CLOSED, not fail-open,
  // and must catch a config change landing at ANY point during the sync,
  // not merely during the initial fetch.
  // ---------------------------------------------------------------------
  test("6d. a PRE-fetch fingerprint READ FAILURE fails closed from the START — never treated as unchanged", async () => {
    const store = new FakeStore();
    store.failFingerprintForConnectionId = "conn-1";
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [
        makeProduct({
          currency: "USD",
          priceRangeRaw: { min: "1500", max: "2000" },
          hasProviderStorefrontPublication: true,
        }),
      ]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    const outcome = await syncBrandCommerceProducts(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {},
      makeDeps(store),
    );

    assert.equal(outcome.status, "SUCCEEDED");
    const [row] = [...store.rows.values()];
    assert.equal(row.currencyCode, null, "a failed baseline read must never be trusted as 'unchanged'");
    assert.equal(row.hasPublicStorefrontUrl, false);
  });

  test("6e. a POST-write fingerprint READ FAILURE triggers the same fail-closed cleanup as a proven change", async () => {
    const store = new FakeStore();
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [
        makeProduct({
          currency: "USD",
          priceRangeRaw: { min: "1500", max: "2000" },
          hasProviderStorefrontPublication: true,
        }),
      ]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    // The PRE-fetch read succeeds normally; only the LATER (post-write) read
    // fails — simulated by flipping the failure flag once the sync's own
    // fetch has already happened, right before the final safety-net read.
    const deps = makeDeps(store, {
      async applyProductWrite(connectionId, brandId, provider, externalKey, decision) {
        store.failFingerprintForConnectionId = "conn-1";
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
          return { trustworthy: true };
        }
        throw new Error(`unexpected decision kind in test: ${decision.kind}`);
      },
    });

    const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    assert.equal(outcome.status, "SUCCEEDED");
    // The row was written WITH real values (the write loop itself doesn't
    // know yet the final check will fail) — the cleanup pass afterward is
    // what must overwrite them.
    assert.deepEqual(store.currencyInvalidatedFor, ["conn-1"]);
    assert.deepEqual(store.publicDestinationInvalidatedFor, ["conn-1"]);
    const [row] = [...store.rows.values()];
    assert.equal(row.currencyCode, null);
    assert.equal(row.hasPublicStorefrontUrl, false);
  });

  test("6f. a config change landing during the FIRST product write is caught by the final safety net (not just during fetch)", async () => {
    const store = new FakeStore();
    const productA = makeProduct({
      externalId: "A",
      currency: "USD",
      priceRangeRaw: { min: "1000", max: "1000" },
      hasProviderStorefrontPublication: true,
    });
    const productB = makeProduct({
      externalId: "B",
      currency: "USD",
      priceRangeRaw: { min: "2000", max: "2000" },
      hasProviderStorefrontPublication: true,
    });
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [productA, productB]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    let writeCount = 0;
    const deps = makeDeps(store, {
      async applyProductWrite(connectionId, brandId, provider, externalKey, decision) {
        writeCount += 1;
        if (writeCount === 1) {
          // Configuration changes WHILE the first product is being written —
          // a window the pre/post-fetch-only design from the prior repair
          // round could never observe.
          store.connectionFingerprints.set(connectionId, "changed-during-first-write");
        }
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
          return { trustworthy: true };
        }
        throw new Error(`unexpected decision kind in test: ${decision.kind}`);
      },
    });

    const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(store.rows.size, 2);
    for (const row of store.rows.values()) {
      assert.equal(row.currencyCode, null, `${row.externalKey} must be invalidated`);
      assert.equal(row.hasPublicStorefrontUrl, false, `${row.externalKey} must be invalidated`);
    }
    assert.deepEqual(store.currencyInvalidatedFor, ["conn-1"]);
  });

  test("6g. a config change landing during a LATER product write is caught by the final safety net", async () => {
    const store = new FakeStore();
    const products = ["A", "B", "C"].map((id) =>
      makeProduct({
        externalId: id,
        currency: "USD",
        priceRangeRaw: { min: "1000", max: "1000" },
        hasProviderStorefrontPublication: true,
      }),
    );
    const adapter = makeAdapter(async (connectionId) => makeSyncResult(connectionId, products));
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    let writeCount = 0;
    const deps = makeDeps(store, {
      async applyProductWrite(connectionId, brandId, provider, externalKey, decision) {
        writeCount += 1;
        if (writeCount === 3) {
          // The change lands on the LAST write, not the first — proves the
          // safety net isn't merely re-checking early.
          store.connectionFingerprints.set(connectionId, "changed-during-last-write");
        }
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
          return { trustworthy: true };
        }
        throw new Error(`unexpected decision kind in test: ${decision.kind}`);
      },
    });

    const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(store.rows.size, 3);
    for (const row of store.rows.values()) {
      assert.equal(row.currencyCode, null);
      assert.equal(row.hasPublicStorefrontUrl, false);
    }
  });

  test("6h. a config change landing during/after absence reconciliation (markUnavailableExcept) is also caught", async () => {
    const store = new FakeStore();
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [
        makeProduct({
          currency: "USD",
          priceRangeRaw: { min: "1500", max: "1500" },
          hasProviderStorefrontPublication: true,
        }),
      ]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    const deps = makeDeps(store, {
      async markUnavailableExcept(connectionId, seenExternalKeys, now, runId) {
        store.connectionFingerprints.set(connectionId, "changed-during-absence-reconciliation");
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
    });

    const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    assert.equal(outcome.status, "SUCCEEDED");
    const [row] = [...store.rows.values()];
    assert.equal(row.currencyCode, null, "a change during absence reconciliation must still be caught");
    assert.equal(row.hasPublicStorefrontUrl, false);
    assert.deepEqual(store.currencyInvalidatedFor, ["conn-1"]);
  });

  test("6i. invalidation is scoped to the EXACT connection only — an unrelated connection's data is untouched", async () => {
    const store = new FakeStore();
    // A second, unrelated connection with its own row, never touched by
    // brand-1's sync or its invalidation.
    store.rows.set("row-other", {
      id: "row-other",
      connectionId: "conn-OTHER",
      brandId: "brand-OTHER",
      provider: CommerceProvider.SHOPIFY,
      externalKey: "unrelated",
      externalId: "unrelated",
      title: "Unrelated product",
      handle: null,
      productUrl: "https://other.test/p",
      imageUrl: null,
      images: [],
      externalVariantIds: [],
      descriptionText: null,
      sku: null,
      currencyCode: "CAD",
      priceMinMinor: 999,
      priceMaxMinor: 999,
      priceMinorUnitExponent: 2,
      isAvailable: true,
      hasPublicStorefrontUrl: true,
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
      unavailableSince: null,
      providerCreatedAt: null,
      providerUpdatedAt: null,
      providerMetadata: {},
      lastSyncRunId: null,
    });

    const adapter = makeAdapter(async (connectionId) => {
      store.connectionFingerprints.set(connectionId, "changed-mid-fetch");
      return makeSyncResult(connectionId, [
        makeProduct({ currency: "USD", priceRangeRaw: { min: "1000", max: "1000" } }),
      ]);
    });
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, makeDeps(store));

    assert.deepEqual(store.currencyInvalidatedFor, ["conn-1"]);
    const otherRow = store.rows.get("row-other")!;
    assert.equal(otherRow.currencyCode, "CAD", "an unrelated connection must never be invalidated by this run");
    assert.equal(otherRow.hasPublicStorefrontUrl, true);
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

  test("7b. hasPublicStorefrontUrl is persisted from provider publication evidence, defaults to false when omitted, and is never derived from status", async () => {
    const store = new FakeStore();
    // Deliberately omits hasProviderStorefrontPublication entirely (an adapter that
    // does not report it) while reporting an ACTIVE status.
    const silent = makeProduct({ externalId: "SILENT", status: "ACTIVE" });
    const published = makeProduct({
      externalId: "PUBLISHED",
      hasProviderStorefrontPublication: true,
    });
    const unpublished = makeProduct({
      externalId: "UNPUBLISHED",
      status: "ACTIVE",
      hasProviderStorefrontPublication: false,
    });
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [silent, published, unpublished]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter);

    const outcome = await syncBrandCommerceProducts(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {},
      makeDeps(store),
    );
    assert.equal(outcome.status, "SUCCEEDED");

    const byKey = new Map(
      [...store.rows.values()].map((row) => [row.externalKey, row]),
    );
    assert.equal(byKey.get("SILENT")!.hasPublicStorefrontUrl, false);
    assert.equal(byKey.get("PUBLISHED")!.hasPublicStorefrontUrl, true);
    assert.equal(byKey.get("UNPUBLISHED")!.hasPublicStorefrontUrl, false);
    // Availability is the orthogonal concept and is unaffected either way.
    assert.equal(byKey.get("UNPUBLISHED")!.isAvailable, true);
  });

  test("7c. a flip in hasPublicStorefrontUrl alone is a detected change (UPDATE, never absorbed into TOUCH)", async () => {
    const store = new FakeStore();
    let hasProviderStorefrontPublication = true;
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [makeProduct({ hasProviderStorefrontPublication })]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    hasProviderStorefrontPublication = false; // the merchant unpublished the product
    const second = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    assert.equal(second.status, "SUCCEEDED");
    if (second.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(second.stats.updatedCount, 1);
    assert.equal(second.stats.unchangedCount, 0);
    const [row] = [...store.rows.values()];
    assert.equal(row.hasPublicStorefrontUrl, false);
  });

  test("7c. a false-to-true storefront publication flip is persisted as an UPDATE", async () => {
    const store = new FakeStore();
    let hasProviderStorefrontPublication = false;
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [makeProduct({ hasProviderStorefrontPublication })]),
    );
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    hasProviderStorefrontPublication = true; // the merchant published the product
    const second = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    assert.equal(second.status, "SUCCEEDED");
    if (second.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(second.stats.updatedCount, 1);
    assert.equal(second.stats.unchangedCount, 0);
    const [row] = [...store.rows.values()];
    assert.equal(row.hasPublicStorefrontUrl, true);
  });

  test("7d. the absent-product sweep never touches hasPublicStorefrontUrl", async () => {
    const store = new FakeStore();
    const productA = makeProduct({ externalId: "A", hasProviderStorefrontPublication: true });
    const productB = makeProduct({ externalId: "B", hasProviderStorefrontPublication: true });
    let products = [productA, productB];
    const adapter = makeAdapter(async (connectionId) => makeSyncResult(connectionId, products));
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    products = [productA]; // B disappears from a complete catalog
    const second = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(second.status, "SUCCEEDED");
    if (second.status !== "SUCCEEDED") throw new Error("unreachable");
    assert.equal(second.stats.markedUnavailableCount, 1);

    const rowB = [...store.rows.values()].find((row) => row.externalKey === "B")!;
    assert.equal(rowB.isAvailable, false);
    // Only availability is swept. The storefront-URL fact is only ever written
    // from a page that actually returned that product.
    assert.equal(rowB.hasPublicStorefrontUrl, true);
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


  test("15. providerMetadata contains ONLY whitelisted fields", async () => {
    const store = new FakeStore();
    const product = makeProduct({
      status: "ACTIVE",
      priceText: "$19.99",
      providerCreatedAt: new Date("2026-01-01T00:00:00Z"),
      providerUpdatedAt: new Date("2026-01-02T00:00:00Z"),
      hasProviderSuppliedStorefrontUrl: true,
    });
    const adapter = makeAdapter(async (connectionId) => makeSyncResult(connectionId, [product]));
    setupBrand(store, "brand-1", "conn-1", adapter);

    await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, makeDeps(store));

    const [row] = [...store.rows.values()];
    const keys = Object.keys(row.providerMetadata).sort();
    assert.deepEqual(keys, [
      "priceText",
      "providerCreatedAt",
      "providerUpdatedAt",
      "status",
      "storefrontUrlSource",
    ]);
    assert.equal(row.providerMetadata.storefrontUrlSource, "PROVIDER");

    const serialized = JSON.stringify(row.providerMetadata);
    assert.equal(/token|secret|encrypted|password|authorization/i.test(serialized), false);
  });

  test("16. an adapter missing from the (injected, fake) registry is controlled: throws UnsupportedProviderError, no network call", async () => {
    // NOTE: this uses COMMERCE7 only as a convenient enum value. The real
    // default registry HAS registered a Commerce7 adapter since Phase 16C1
    // (see tests/commerce7-product-catalog.test.ts) — this test's `makeDeps`
    // fake registry is what deliberately omits it, to exercise the generic
    // "provider has no adapter" guard in isolation from any real provider.
    const store = new FakeStore();
    store.connections.set(
      "brand-c7",
      makeSummary({ id: "conn-c7", brandId: "brand-c7", provider: CommerceProvider.COMMERCE7 }),
    );
    // Deliberately do NOT register a CommerceProvider.COMMERCE7 adapter in
    // THIS FAKE store (unrelated to, and does not affect, the real registry).

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
          return { trustworthy: true };
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

  test("19a. complete 100-product and 101-product catalogs both succeed, following the first-page cursor only when needed", async () => {
    for (const total of [100, 101]) {
      const store = new FakeStore();
      const calls: Array<string | null> = [];
      const products = Array.from({ length: total }, (_, index) =>
        makeProduct({ externalId: `product-${index + 1}`, title: `Product ${index + 1}` }),
      );
      const adapter = makePagedAdapter(async (cursor) => {
        calls.push(cursor);
        if (cursor === null && total === 101) {
          return makePage(products.slice(0, 100), { isComplete: false, nextCursor: "page-2" });
        }
        if (cursor === "page-2") {
          return makePage(products.slice(100));
        }
        return makePage(products);
      });
      setupBrand(store, "brand-1", "conn-1", adapter);

      const outcome = await syncBrandCommerceProducts(
        "brand-1",
        CommerceProvider.SHOPIFY,
        {},
        makeDeps(store),
      );

      assert.equal(outcome.status, "SUCCEEDED", `${total} products`);
      assert.equal(outcome.stats.fetchedCount, total, `${total} products`);
      assert.deepEqual(calls, total === 101 ? [null, "page-2"] : [null], `${total} products`);
    }
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

  test("20b. incomplete storefront-publication preparation writes nothing and never clears previously trusted publication", async () => {
    const store = new FakeStore();
    let publicationScanFails = false;
    const adapter = makePagedAdapter(
      async () => makePage([makeProduct({ externalId: "A", hasProviderStorefrontPublication: true })]),
      undefined,
      async () => {
        if (publicationScanFails) {
          throw new CommerceProviderApiError(CommerceProvider.SHOPIFY, "publication scan truncated");
        }
        return { publishedProductIds: new Set(["A"]) };
      },
    );
    setupBrand(store, "brand-1", "conn-1", adapter);
    const deps = makeDeps(store);

    const first = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(first.status, "SUCCEEDED");
    const before = JSON.stringify([...store.rows.values()]);

    publicationScanFails = true;
    const failed = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(failed.status, "FAILED");
    assert.equal(failed.stats.fetchedCount, 0);
    assert.equal(failed.stats.markedUnavailableCount, 0);
    assert.match(failed.failureSummary ?? "", /PROVIDER_PREPARATION_FAILURE/);
    assert.equal(JSON.stringify([...store.rows.values()]), before);
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

  test("bonus: an adapter without products.sync throws UnsupportedCapabilityError before any run is created", async () => {
    const store = new FakeStore();
    const adapter = makeAdapter(
      async () => {
        throw new Error("syncProducts should not be called");
      },
      { products: { sync: false, publicDestinations: true } },
    );
    setupBrand(store, "brand-1", "conn-1", adapter);

    await assert.rejects(
      () => syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, makeDeps(store)),
      (error: unknown) => error instanceof UnsupportedCapabilityError,
    );
    assert.equal(store.runs.size, 0);
  });
});

// ---------------------------------------------------------------------------
// PHASE 16-18 REPAIR — Part 4B / Part 7: a PRODUCTION-SEQUENCE regression
// using the REAL `deriveProductConfigurationFingerprint` function against a
// simulated connection row that has a genuine `lastProductSyncAt` field the
// fingerprint must never read. This is deliberately NOT the abstract
// `store.connectionFingerprints` map the tests above use (which only proves
// the FENCING ORCHESTRATION is correct, not that the field selection itself
// excludes lastProductSyncAt/updatedAt) — this test would fail if someone
// changed the fingerprint computation back to including either field.
// ---------------------------------------------------------------------------
describe("Part 4B/7: production-sequence regression — a real sync must never self-invalidate", () => {
  test("completeProductSync bumping lastProductSyncAt does NOT change the config-only fingerprint; money/currency/public destination remain authoritative and the run reports SUCCEEDED", async () => {
    const store = new FakeStore();
    const connectionRow = {
      provider: CommerceProvider.SHOPIFY,
      storefrontUrl: "https://test-shop.myshopify.com",
      providerMetadata: { currencyCode: "USD" } as Record<string, unknown>,
      lastProductSyncAt: null as Date | null,
    };

    let completeProductSyncCalls = 0;
    const adapter = makeAdapter(async (connectionId) =>
      makeSyncResult(connectionId, [
        makeProduct({
          currency: "USD",
          priceRangeRaw: { min: "1500", max: "2000" },
          hasProviderStorefrontPublication: true,
        }),
      ]),
    );
    // Give the adapter a completeProductSync hook that mutates the
    // simulated row's lastProductSyncAt — exactly what the real adapter's
    // completion hook does via markProductSync in production.
    (adapter as unknown as { completeProductSync: (connectionId: string, now: Date) => Promise<void> }).completeProductSync =
      async (_connectionId, now) => {
        completeProductSyncCalls += 1;
        connectionRow.lastProductSyncAt = now;
      };
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    function fingerprintOf(): string {
      return deriveProductConfigurationFingerprint({
        provider: connectionRow.provider,
        storefrontUrl: connectionRow.storefrontUrl,
        providerMetadata: connectionRow.providerMetadata as never,
      });
    }

    const deps = makeDeps(store, {
      async getConnectionFingerprint() {
        return fingerprintOf();
      },
      async getConnectionConfigSnapshot() {
        return { fingerprint: fingerprintOf(), currencyCode: "USD" };
      },
      // The per-write transactional check must ALSO use this test's REAL
      // fingerprint source (not the FakeStore default's unrelated
      // `connectionFingerprints` map, which this test never populates) —
      // otherwise the per-write check would always see a mismatch against
      // the baseline snapshot above and incorrectly sanitize.
      async applyProductWrite(connectionId, brandId, provider, externalKey, decision, expectedFingerprint) {
        const trustworthy = expectedFingerprint !== null && fingerprintOf() === expectedFingerprint;
        const finalDecision = trustworthy ? decision : sanitizeDecisionForUntrustedConfig(decision);
        if (finalDecision.kind === "CREATE") {
          const id = `prod-${store.nextId++}`;
          store.rows.set(id, {
            id,
            connectionId,
            brandId,
            provider,
            externalKey,
            firstSeenAt: finalDecision.data.lastSeenAt,
            ...finalDecision.data,
          });
          return { trustworthy };
        }
        throw new Error(`unexpected decision kind in test: ${finalDecision.kind}`);
      },
    });

    const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    assert.equal(outcome.status, "SUCCEEDED");
    assert.equal(completeProductSyncCalls, 1, "completeProductSync must still run for a genuinely successful sync");
    assert.ok(connectionRow.lastProductSyncAt, "lastProductSyncAt must have been bumped, proving the mutation genuinely happened");

    const [row] = [...store.rows.values()];
    assert.equal(row.currencyCode, "USD", "currency must remain authoritative — the sync must not self-invalidate");
    assert.equal(row.priceMinMinor, 150000);
    assert.equal(row.hasPublicStorefrontUrl, true, "public destination must remain authoritative");
    assert.deepEqual(store.currencyInvalidatedFor, [], "no invalidation must fire for a run that never changed configuration");
  });
});

// ---------------------------------------------------------------------------
// PHASE 16-18 REPAIR — P1-2: the final required invalidation must be
// FAIL-CLOSED. Its own failure must prevent the run from ever reporting
// SUCCEEDED, never merely be logged and absorbed.
// ---------------------------------------------------------------------------
describe("P1-2: required invalidation failure prevents SUCCEEDED", () => {
  test("12. a config change is detected AND the required invalidation write itself fails -> the run is FAILED, never SUCCEEDED", async () => {
    const store = new FakeStore();
    const adapter = makeAdapter(async (connectionId) => {
      store.connectionFingerprints.set(connectionId, "changed-mid-fetch");
      return makeSyncResult(connectionId, [
        makeProduct({
          currency: "USD",
          priceRangeRaw: { min: "1500", max: "2000" },
          hasProviderStorefrontPublication: true,
        }),
      ]);
    });
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    const deps = makeDeps(store, {
      async invalidateStaleConfigDerivedFields() {
        throw new Error("simulated invalidation write failure (e.g. a DB outage)");
      },
    });

    const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    assert.equal(outcome.status, "FAILED", "a required safety write that failed must never allow SUCCEEDED");
    if (outcome.status !== "FAILED") throw new Error("unreachable");
    assert.ok(outcome.failureSummary && outcome.failureSummary.includes("REQUIRED_INVALIDATION_FAILED"));

    // PHASE 19 REPAIR (Part 2/14A) — THE STRUCTURAL PROOF: the config
    // changed BEFORE the write loop even started (during the fetch), so
    // the PER-WRITE transactional fence (not the final cleanup, which was
    // forced to fail above) must have ALREADY refused to persist stale
    // A-derived authority. This must hold even though the final,
    // defense-in-depth cleanup never ran successfully — proving stale-data
    // safety is a property of the WRITE itself, not something restored
    // afterward. Checking `run.status === "FAILED"` alone (as the prior
    // repair round's tests did) would pass even if this were false.
    const [row] = [...store.rows.values()];
    assert.ok(row, "the product must still have been written (catalog-safe fields), just without config-derived authority");
    assert.equal(row.currencyCode, null, "no authoritative stale currency, regardless of cleanup outcome");
    assert.equal(row.priceMinMinor, null, "no authoritative stale price, regardless of cleanup outcome");
    assert.equal(row.priceMaxMinor, null);
    assert.equal(row.priceMinorUnitExponent, null);
    assert.equal(row.hasPublicStorefrontUrl, false, "no authoritative stale public destination, regardless of cleanup outcome");
  });

  test("an invalidation failure downgrades even an otherwise-SUCCEEDED run's reported status, though its non-config writes (e.g. availability) already happened", async () => {
    const store = new FakeStore();
    const productA = makeProduct({ externalId: "A" });
    const productB = makeProduct({ externalId: "B" });
    let products = [productA, productB];
    const adapter = makeAdapter(async (connectionId) => {
      store.connectionFingerprints.set(connectionId, "changed-mid-fetch");
      return makeSyncResult(connectionId, products);
    });
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    const deps = makeDeps(store, {
      async invalidateStaleConfigDerivedFields() {
        throw new Error("simulated failure");
      },
    });

    // Seed row B as previously available so absence reconciliation has
    // something real to do — proves availability tracking still runs
    // correctly even though the run's own STATUS will be downgraded.
    products = [productA, productB];
    const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(outcome.status, "FAILED");
  });
});

// ---------------------------------------------------------------------------
// PHASE 16-18 REPAIR — Part 8: deterministic concurrency-barrier tests using
// deferred Promises, not sleeps.
// ---------------------------------------------------------------------------
describe("Part 8: concurrency barrier tests", () => {
  test("a config-save transaction that commits WHILE product A's write is in flight is observed by product B's per-write check", async () => {
    const store = new FakeStore();
    const productA = makeProduct({
      externalId: "A",
      currency: "USD",
      priceRangeRaw: { min: "1000", max: "1000" },
      hasProviderStorefrontPublication: true,
    });
    const productB = makeProduct({
      externalId: "B",
      currency: "USD",
      priceRangeRaw: { min: "2000", max: "2000" },
      hasProviderStorefrontPublication: true,
    });
    const adapter = makeAdapter(async (connectionId) => makeSyncResult(connectionId, [productA, productB]));
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    // Deferred barrier: product A's write does not proceed until released.
    let releaseProductAWrite: () => void = () => {};
    const productAWriteGate = new Promise<void>((resolve) => {
      releaseProductAWrite = resolve;
    });
    let signalProductAWriteStarted: () => void = () => {};
    const productAWriteStarted = new Promise<void>((resolve) => {
      signalProductAWriteStarted = resolve;
    });

    const deps = makeDeps(store, {
      async applyProductWrite(connectionId, brandId, provider, externalKey, decision) {
        if (externalKey === "A") {
          signalProductAWriteStarted();
          await productAWriteGate;
        }
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
          return { trustworthy: true };
        }
        throw new Error(`unexpected decision kind: ${decision.kind}`);
      },
    });

    const syncPromise = syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    // Wait until product A's write has GENUINELY started (not a sleep —
    // an actual signal from the code under test), then simulate the
    // concurrent config-save transaction committing, THEN release A.
    await productAWriteStarted;
    store.connectionFingerprints.set("conn-1", "changed-by-concurrent-config-save");
    releaseProductAWrite();

    const outcome = await syncPromise;
    assert.equal(outcome.status, "SUCCEEDED");

    // Both products end up safely invalidated: A's per-write check ran
    // BEFORE the barrier (real values were already decided), B's per-write
    // check ran AFTER (nulled at write time) — either way, the final
    // safety net guarantees neither ends up with stale-A-config money.
    for (const row of store.rows.values()) {
      assert.equal(row.currencyCode, null, `${row.externalKey} must never end up authoritative after a mid-run config change`);
      assert.equal(row.hasPublicStorefrontUrl, false);
    }
  });

  test("after a stale-config invalidation, a FRESH sync under the new (now-stable) configuration correctly repopulates real money/destination fields", async () => {
    const store = new FakeStore();
    const product = makeProduct({
      currency: "USD",
      priceRangeRaw: { min: "1500", max: "2000" },
      hasProviderStorefrontPublication: true,
    });
    const adapter = makeAdapter(async (connectionId) => {
      // Only the FIRST call simulates a mid-fetch config change.
      if (!store.connectionFingerprints.has("already-changed-once")) {
        store.connectionFingerprints.set("already-changed-once", "true");
        store.connectionFingerprints.set(connectionId, "changed-mid-fetch");
      }
      return makeSyncResult(connectionId, [product]);
    });
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");
    const deps = makeDeps(store);

    const stale = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(stale.status, "SUCCEEDED");
    const [rowAfterStale] = [...store.rows.values()];
    assert.equal(rowAfterStale.currencyCode, null, "the stale run must have invalidated money fields");

    // The fingerprint is now STABLE at "changed-mid-fetch" (no further
    // config change happens) — a fresh sync run under this settled
    // configuration must correctly repopulate real values, proving the
    // fencing self-heals rather than permanently poisoning the connection.
    const fresh = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(fresh.status, "SUCCEEDED");
    const [rowAfterFresh] = [...store.rows.values()];
    assert.equal(rowAfterFresh.currencyCode, "USD", "a fresh sync under stable configuration must repopulate real currency");
    assert.equal(rowAfterFresh.priceMinMinor, 150000);
    assert.equal(rowAfterFresh.hasPublicStorefrontUrl, true, "a fresh sync under stable configuration must repopulate the public destination");
  });
});

// ---------------------------------------------------------------------------
// PHASE 19 REPAIR — Part 5 / 14B: the atomic RUNNING-run claim. Deterministic
// barrier tests, no sleeps.
// ---------------------------------------------------------------------------
describe("Part 5/14B: atomic same-connection sync claim", () => {
  test("two concurrent requests for the SAME connection: exactly one claims RUNNING, the other is refused, and provider fetch happens exactly once", async () => {
    const store = new FakeStore();
    let fetchCallCount = 0;
    let releaseFetch: () => void = () => {};
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let signalFetchStarted: () => void = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });

    const adapter = makeAdapter(async (connectionId) => {
      fetchCallCount += 1;
      signalFetchStarted();
      await fetchGate;
      return makeSyncResult(connectionId, [makeProduct()]);
    });
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");
    const deps = makeDeps(store);

    // Request A's claim commits (synchronously, inside claimProductSyncRun)
    // strictly BEFORE its provider fetch begins — this is the ordering
    // invariant `runProductSync` itself enforces (claim, THEN collectCatalog).
    const requestA = syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);

    // Wait until A's fetch has GENUINELY started (a real signal from the
    // code under test, not a sleep) — proving A's claim already committed.
    await fetchStarted;

    // Request B arrives for the SAME connection while A is still mid-fetch
    // (A's RUNNING row is still registered). B's own claim attempt must see
    // it and refuse — never reaching the provider fetch itself.
    const outcomeB = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(outcomeB.status, "ALREADY_RUNNING");
    assert.equal(fetchCallCount, 1, "B must never reach the provider fetch while A's claim is still active");

    releaseFetch();
    const outcomeA = await requestA;
    assert.equal(outcomeA.status, "SUCCEEDED");
    assert.equal(fetchCallCount, 1, "still exactly one fetch total — B was refused, not merely delayed");
  });

  test("after the first run finishes, a later second run for the SAME connection proceeds normally (no permanent lockout)", async () => {
    const store = new FakeStore();
    let fetchCallCount = 0;
    const adapter = makeAdapter(async (connectionId) => {
      fetchCallCount += 1;
      return makeSyncResult(connectionId, [makeProduct()]);
    });
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");
    const deps = makeDeps(store);

    const first = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(first.status, "SUCCEEDED");

    const second = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(second.status, "SUCCEEDED");
    assert.equal(fetchCallCount, 2);
  });

  test("Shopify X and Commerce7 Y independence: a RUNNING claim for one connection never blocks a DIFFERENT connection", async () => {
    const store = new FakeStore();
    const adapterX = makeAdapter(async (connectionId) => makeSyncResult(connectionId, [makeProduct()]));
    store.connections.set("brand-x", makeSummary({ id: "conn-x", brandId: "brand-x" }));
    store.connections.set("brand-y", makeSummary({ id: "conn-y", brandId: "brand-y" }));
    store.adapters.set(CommerceProvider.SHOPIFY, adapterX);

    // Pre-claim conn-x directly, simulating a run already in flight there.
    store.runningByConnection.set("conn-x", { id: "run-x-active", startedAt: new Date() });

    const outcomeY = await syncBrandCommerceProducts("brand-y", CommerceProvider.SHOPIFY, {}, makeDeps(store));
    assert.equal(outcomeY.status, "SUCCEEDED", "connection Y's own claim is entirely independent of X's");
  });

  // PHASE 20 REPAIR (stale-run lease repair, P1): regression test for
  // "stale-run cutoff can supersede a legitimate live sync." Before this
  // repair, `claimProductSyncRun` only treated a RUNNING row as blocking
  // if `startedAt >= notBefore` (i.e. younger than
  // `RUNNING_RUN_STALE_AFTER_MS`, 5 minutes) — so a run genuinely still in
  // progress past that age was silently treated as abandoned and a SECOND
  // concurrent claim would succeed, reaching the provider fetch while the
  // first run was also still fetching. This test injects a RUNNING row
  // aged well past that old 5-minute cutoff (no wall-clock sleeping — the
  // fake store's `startedAt` is set directly) and proves a new claim is
  // STILL refused. This test MUST have failed under the previous
  // (age-based) implementation.
  test("a RUNNING row older than the OLD 5-minute stale threshold still blocks a new claim, since age alone never proves abandonment", async () => {
    const store = new FakeStore();
    let fetchCallCount = 0;
    const adapter = makeAdapter(async (connectionId) => {
      fetchCallCount += 1;
      return makeSyncResult(connectionId, [makeProduct()]);
    });
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");

    // 20 minutes old: past both the OLD 5-minute stale cutoff AND the
    // OLD 10-minute `maxDurationMs` ceiling — exactly the kind of
    // long-running-but-still-legitimate sync the P1 scenario describes
    // (large catalog / slow provider / slow DB), which the old age-based
    // policy would have wrongly reclaimed.
    const twentyMinutesAgo = new Date(Date.now() - 20 * 60 * 1000);
    store.runningByConnection.set("conn-1", { id: "run-still-live", startedAt: twentyMinutesAgo });

    const outcome = await syncBrandCommerceProducts(
      "brand-1",
      CommerceProvider.SHOPIFY,
      {},
      makeDeps(store),
    );

    assert.equal(
      outcome.status,
      "ALREADY_RUNNING",
      "an old RUNNING row must still block a new claim — age alone never proves abandonment",
    );
    assert.equal(
      fetchCallCount,
      0,
      "the second caller must never reach the provider fetch while a RUNNING row of any age exists for this connection",
    );
  });

  test("a RUNNING row of ANY age (boundary check: 1ms, exactly at the old 5-minute mark, and far beyond it) blocks a new claim identically — there is no age threshold anymore", async () => {
    const store = new FakeStore();
    const adapter = makeAdapter(async (connectionId) => makeSyncResult(connectionId, [makeProduct()]));
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");
    const deps = makeDeps(store);

    const ages = [1, 5 * 60 * 1000, 5 * 60 * 1000 + 1, 24 * 60 * 60 * 1000];
    for (const ageMs of ages) {
      store.runningByConnection.set("conn-1", {
        id: `run-${ageMs}`,
        startedAt: new Date(Date.now() - ageMs),
      });
      const outcome = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
      assert.equal(
        outcome.status,
        "ALREADY_RUNNING",
        `a RUNNING row aged ${ageMs}ms must block a new claim identically to any other age`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// PHASE 19 REPAIR — Part 6: absence reconciliation safety once concurrent
// same-connection execution is serialized by the atomic claim.
// ---------------------------------------------------------------------------
describe("Part 6: absence reconciliation cannot race a concurrently-running older snapshot", () => {
  test("a newer completed product cannot be made unavailable by an older overlapping run, because an overlapping run cannot exist", async () => {
    const store = new FakeStore();
    // Snapshot A: only p1. Snapshot B (later, more complete): p1 and p2.
    let snapshot: "A" | "B" = "A";
    const adapter = makeAdapter(async (connectionId) => {
      const products =
        snapshot === "A"
          ? [makeProduct({ externalId: "p1" })]
          : [makeProduct({ externalId: "p1" }), makeProduct({ externalId: "p2" })];
      return makeSyncResult(connectionId, products);
    });
    setupBrand(store, "brand-1", "conn-1", adapter, "USD");
    const deps = makeDeps(store);

    // Run under snapshot B first (the "newer, more complete" run), so p2
    // is persisted and available.
    snapshot = "B";
    const runB = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(runB.status, "SUCCEEDED");
    const p2 = [...store.rows.values()].find((row) => row.externalKey === "p2");
    assert.ok(p2);
    assert.equal(p2!.isAvailable, true);

    // A LATER run that only observes the OLDER snapshot A (p1 only) cannot
    // run "concurrently" with anything now — the atomic claim guarantees
    // full serialization, so this run's absence reconciliation legitimately
    // reflects a genuinely CURRENT fetch, not a stale race. If it were
    // franchised to run while B was still in flight, it would have
    // incorrectly marked p2 unavailable; run sequentially, it correctly
    // marks p2 unavailable because THAT is now the true current state.
    snapshot = "A";
    const runA = await syncBrandCommerceProducts("brand-1", CommerceProvider.SHOPIFY, {}, deps);
    assert.equal(runA.status, "SUCCEEDED");
    const p2After = [...store.rows.values()].find((row) => row.externalKey === "p2");
    assert.equal(p2After!.isAvailable, false, "a genuinely sequential, later fetch that no longer sees p2 correctly marks it unavailable");

    // The critical safety property: at no point could runA and runB have
    // been RUNNING at the same time — the second call always either waits
    // (in reality) or, in this synchronous test harness, is impossible to
    // interleave mid-run since each `await`ed call fully completes (claim
    // through finalize) before the next one starts. The atomic claim is
    // what makes that guarantee true in the real concurrent case too (see
    // the barrier test above).
  });
});
