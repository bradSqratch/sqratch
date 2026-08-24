/**
 * tests/commerce7-canonical-product-sync.test.ts
 *
 * PHASE 16C1 — end-to-end: Commerce7 products travel through the REAL
 * provider-neutral sync service (`syncBrandCommerceProducts`) and the REAL
 * `Commerce7CommerceAdapter` into the canonical catalog shape.
 *
 * Only the persistence boundary and the Commerce7 HTTP boundary are faked; the
 * pagination loop, change detection, unavailability policy, and normalization
 * are all production code. No database, no network.
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
  type ProductSyncDeps,
  type ExistingConnectedProductRow,
  type ProductWriteDecision,
} from "../src/lib/commerce/product-sync";
import type { CommerceConnectionSummary } from "../src/lib/commerce/types";
import {
  Commerce7CommerceAdapter,
  type Commerce7CommerceConnectionRow,
} from "../src/lib/commerce/providers/commerce7-commerce-adapter";
import type { Commerce7Fetch } from "../src/lib/commerce/providers/commerce7-products";

// ---------------------------------------------------------------------------
// Minimal in-memory catalog
// ---------------------------------------------------------------------------

type Row = Record<string, unknown> & {
  id: string;
  connectionId: string;
  externalKey: string;
  isAvailable: boolean;
};

class Catalog {
  nextId = 1;
  rows = new Map<string, Row>();
  runs = new Map<string, Record<string, unknown>>();

  forConnection(connectionId: string): Row[] {
    return [...this.rows.values()].filter((r) => r.connectionId === connectionId);
  }
}

const TENANT = "sqratch-inc";
const CONNECTION_ID = "conn-c7";
const BRAND_ID = "brand-c7";

function summary(
  overrides: Partial<CommerceConnectionSummary> = {},
): CommerceConnectionSummary {
  return {
    id: CONNECTION_ID,
    brandId: BRAND_ID,
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    displayName: TENANT,
    externalAccountId: TENANT,
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

function connectionRow(): Commerce7CommerceConnectionRow {
  return {
    id: CONNECTION_ID,
    brandId: BRAND_ID,
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    displayName: TENANT,
    externalAccountId: TENANT,
    storefrontUrl: null,
    isPrimary: true,
    grantedScopes: null,
    installedAt: new Date("2026-01-01"),
    uninstalledAt: null,
    lastProductSyncAt: null,
    providerMetadata: null,
  };
}

function makeFetch(pages: Array<{ ok?: boolean; status?: number; body: unknown }>) {
  let index = 0;
  const impl: Commerce7Fetch = async () => {
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return {
      ok: page.ok ?? true,
      status: page.status ?? 200,
      json: async () => page.body,
    };
  };
  return impl;
}

function c7Product(overrides: Record<string, unknown> = {}) {
  return {
    id: "prod-1",
    title: "Sample - 2015 Chardonnay",
    slug: "2015-chardonnay",
    webStatus: "Available",
    adminStatus: "Available",
    security: { availableTo: "Public" },
    variants: [{ id: "var-1", sku: "2015C", price: 4200 }],
    ...overrides,
  };
}

function makeDeps(
  catalog: Catalog,
  fetchImpl: Commerce7Fetch,
  connectionSummary: CommerceConnectionSummary = summary(),
): ProductSyncDeps {
  const adapter = new Commerce7CommerceAdapter({
    loadConnection: async (id) => (id === CONNECTION_ID ? connectionRow() : null),
    markProductSync: async () => {},
    fetchImpl,
  });

  return {
    async getActiveConnection(brandId, provider) {
      return brandId === BRAND_ID && provider === CommerceProvider.COMMERCE7
        ? connectionSummary
        : null;
    },
    getAdapter() {
      return adapter;
    },
    async findExistingProducts(connectionId): Promise<ExistingConnectedProductRow[]> {
      return catalog.forConnection(connectionId).map(
        (row) => row as unknown as ExistingConnectedProductRow,
      );
    },
    async createSyncRun(input) {
      const id = `run-${catalog.nextId++}`;
      catalog.runs.set(id, { id, ...input, status: "RUNNING" });
      return { id };
    },
    async finalizeSyncRun(runId, input) {
      catalog.runs.set(runId, { ...(catalog.runs.get(runId) ?? {}), ...input });
    },
    async applyProductWrite(connectionId, brandId, provider, externalKey, decision: ProductWriteDecision) {
      if (decision.kind === "CREATE") {
        const id = `row-${catalog.nextId++}`;
        catalog.rows.set(id, {
          id,
          connectionId,
          brandId,
          provider,
          externalKey,
          ...decision.data,
        } as Row);
        return;
      }
      if (decision.kind === "UPDATE") {
        const existing = catalog.rows.get(decision.existingId)!;
        catalog.rows.set(decision.existingId, { ...existing, ...decision.data } as Row);
        return;
      }
      const existing = catalog.rows.get(decision.existingId)!;
      catalog.rows.set(decision.existingId, {
        ...existing,
        lastSeenAt: decision.lastSeenAt,
        lastSyncRunId: decision.lastSyncRunId,
      } as Row);
    },
    async markUnavailableExcept(connectionId, seenExternalKeys, now, runId) {
      let count = 0;
      for (const row of catalog.rows.values()) {
        if (
          row.connectionId === connectionId &&
          row.isAvailable &&
          !seenExternalKeys.includes(row.externalKey)
        ) {
          row.isAvailable = false;
          row.unavailableSince = now;
          row.lastSyncRunId = runId;
          count += 1;
        }
      }
      return { count };
    },
  };
}

// ===========================================================================
describe("Commerce7 products enter the canonical catalog", () => {
  test("a paginated Commerce7 catalog persists as canonical rows", async () => {
    const catalog = new Catalog();
    const deps = makeDeps(
      catalog,
      makeFetch([
        { body: { products: [c7Product({ id: "p1" })], cursor: "c2" } },
        {
          body: {
            products: [
              c7Product({ id: "p2", title: "Second", slug: "second" }),
              c7Product({ id: "p3", title: "Third", slug: "third" }),
            ],
          },
        },
      ]),
    );

    const outcome = await syncBrandCommerceProducts(
      BRAND_ID,
      CommerceProvider.COMMERCE7,
      {},
      deps,
    );

    assert.equal(outcome.status, "SUCCEEDED");
    const rows = catalog.forConnection(CONNECTION_ID);
    assert.equal(rows.length, 3, "all pages persisted");
    assert.deepEqual(
      rows.map((r) => r.externalKey).sort(),
      ["p1", "p2", "p3"],
    );
    // Every row is COMMERCE7 and bound to the exact connection.
    for (const row of rows) {
      assert.equal(row.provider, CommerceProvider.COMMERCE7);
      assert.equal(row.connectionId, CONNECTION_ID);
      assert.equal(row.brandId, BRAND_ID);
    }
  });

  test("19. no persisted Commerce7 row carries a guessed storefront URL", async () => {
    const catalog = new Catalog();
    const deps = makeDeps(
      catalog,
      makeFetch([{ body: { products: [c7Product()] } }]),
    );

    await syncBrandCommerceProducts(BRAND_ID, CommerceProvider.COMMERCE7, {}, deps);

    const row = catalog.forConnection(CONNECTION_ID)[0];
    assert.equal(row.productUrl, "", "canonical absence, never a synthesized URL");
    assert.equal(
      row.hasPublicStorefrontUrl,
      false,
      "the public-destination gate must persist false",
    );
    // The slug survives as catalog data, but never as a URL.
    assert.equal(row.handle, "2015-chardonnay");
    const serialized = JSON.stringify(row);
    assert.ok(!serialized.includes("v2-template"));
    assert.ok(!serialized.includes("https://sqratch-inc"));
  });

  test("availability maps onto the canonical isAvailable flag", async () => {
    const catalog = new Catalog();
    const deps = makeDeps(
      catalog,
      makeFetch([
        {
          body: {
            products: [
              c7Product({ id: "live" }),
              c7Product({ id: "retired", webStatus: "Retired" }),
              c7Product({ id: "hidden", adminStatus: "Hidden" }),
              // Club-only: a genuine live catalog entry, but never public.
              c7Product({ id: "club", security: { availableTo: "Club" } }),
            ],
          },
        },
      ]),
    );

    await syncBrandCommerceProducts(BRAND_ID, CommerceProvider.COMMERCE7, {}, deps);

    const byKey = new Map(
      catalog.forConnection(CONNECTION_ID).map((r) => [r.externalKey, r]),
    );
    assert.equal(byKey.get("live")!.isAvailable, true);
    assert.equal(byKey.get("retired")!.isAvailable, false);
    assert.equal(byKey.get("hidden")!.isAvailable, false);
    assert.equal(byKey.get("club")!.isAvailable, true);

    // 18. NOTHING is publicly exposed, regardless of access tier.
    for (const row of byKey.values()) {
      assert.equal(row.hasPublicStorefrontUrl, false);
    }
  });

  test("16. cents survive into integer minor units when the connection currency is known", async () => {
    const catalog = new Catalog();
    const deps = makeDeps(
      catalog,
      makeFetch([
        {
          body: {
            products: [
              c7Product({
                variants: [
                  { id: "v1", price: 4200 },
                  { id: "v2", price: 12550 },
                ],
              }),
            ],
          },
        },
      ]),
      summary({ currencyCode: "CAD" }),
    );

    await syncBrandCommerceProducts(BRAND_ID, CommerceProvider.COMMERCE7, {}, deps);

    const row = catalog.forConnection(CONNECTION_ID)[0];
    assert.equal(row.currencyCode, "CAD");
    assert.equal(row.priceMinMinor, 4200, "42.00 CAD round-trips to exactly 4200 cents");
    assert.equal(row.priceMaxMinor, 12550);
    assert.equal(row.priceMinorUnitExponent, 2);
  });

  test("H. a negative Commerce7 variant price with a KNOWN connection currency never persists a negative (or any) invalid amount", async () => {
    // Same production path as test 16 above (real syncBrandCommerceProducts
    // -> real Commerce7CommerceAdapter -> real fetchCommerce7ProductPage ->
    // real normalizeCommerce7Product -> real computeProductFields ->
    // decideProductWrite -> a CREATE write), the ONLY difference being the
    // variant price is negative. Currency comes from `summary.currencyCode`
    // — the exact same `CommerceConnectionSummary.currencyCode` field
    // production reads (sourced from `CommerceConnection.providerMetadata`
    // via `extractCurrencyCodeFromProviderMetadata` — see
    // connection-resolver.ts), not a test-only authority.
    const catalog = new Catalog();
    const deps = makeDeps(
      catalog,
      makeFetch([
        { body: { products: [c7Product({ variants: [{ id: "v1", price: -500 }] })] } },
      ]),
      summary({ currencyCode: "CAD" }),
    );

    const outcome = await syncBrandCommerceProducts(BRAND_ID, CommerceProvider.COMMERCE7, {}, deps);
    assert.equal(outcome.status, "SUCCEEDED", "an invalid price does not fail the whole sync");

    const row = catalog.forConnection(CONNECTION_ID)[0];
    assert.ok(row, "the product row is still created — invalid money nulls only the money fields");

    // THE invariant this test exists to prove: no negative (or otherwise
    // invalid) integer is ever persisted. This assertion is exact, not a
    // range/truthy check, so it fails immediately if production regressed to
    // persisting -500 (or any other negative value) here.
    assert.equal(row.priceMinMinor, null);
    assert.equal(row.priceMaxMinor, null);

    // PRODUCTION'S ACTUAL CONTRACT (computePrice in product-sync.ts): when
    // the brand currency IS known, currencyCode and priceMinorUnitExponent
    // are resolved from THAT currency independently of whether any
    // individual price string parsed — only the specific invalid amount(s)
    // are nulled. This is the existing behavior; this test asserts it
    // exactly rather than the alternative (nulling the whole tuple).
    assert.equal(row.currencyCode, "CAD");
    assert.equal(row.priceMinorUnitExponent, 2);
  });

  test("an unknown connection currency yields null prices, never a guessed currency", async () => {
    const catalog = new Catalog();
    const deps = makeDeps(
      catalog,
      makeFetch([{ body: { products: [c7Product()] } }]),
      summary({ currencyCode: null }),
    );

    await syncBrandCommerceProducts(BRAND_ID, CommerceProvider.COMMERCE7, {}, deps);

    const row = catalog.forConnection(CONNECTION_ID)[0];
    assert.equal(row.currencyCode, null);
    assert.equal(row.priceMinMinor, null);
    assert.equal(row.priceMaxMinor, null);
  });

  test("24. a repeated sync is idempotent — no duplicate rows", async () => {
    const catalog = new Catalog();
    const pages = () => makeFetch([{ body: { products: [c7Product()] } }]);

    await syncBrandCommerceProducts(BRAND_ID, CommerceProvider.COMMERCE7, {}, makeDeps(catalog, pages()));
    const afterFirst = catalog.forConnection(CONNECTION_ID).length;

    await syncBrandCommerceProducts(BRAND_ID, CommerceProvider.COMMERCE7, {}, makeDeps(catalog, pages()));
    const afterSecond = catalog.forConnection(CONNECTION_ID).length;

    assert.equal(afterFirst, 1);
    assert.equal(afterSecond, 1, "resync updates in place rather than duplicating");
  });

  test("25. a product removed from the provider becomes unavailable, never deleted", async () => {
    const catalog = new Catalog();

    await syncBrandCommerceProducts(
      BRAND_ID,
      CommerceProvider.COMMERCE7,
      {},
      makeDeps(
        catalog,
        makeFetch([
          { body: { products: [c7Product({ id: "keep" }), c7Product({ id: "gone" })] } },
        ]),
      ),
    );
    assert.equal(catalog.forConnection(CONNECTION_ID).length, 2);

    // "gone" disappears from the provider catalog.
    await syncBrandCommerceProducts(
      BRAND_ID,
      CommerceProvider.COMMERCE7,
      {},
      makeDeps(catalog, makeFetch([{ body: { products: [c7Product({ id: "keep" })] } }])),
    );

    const byKey = new Map(
      catalog.forConnection(CONNECTION_ID).map((r) => [r.externalKey, r]),
    );
    assert.equal(byKey.size, 2, "the row is retained, never deleted");
    assert.equal(byKey.get("keep")!.isAvailable, true);
    assert.equal(byKey.get("gone")!.isAvailable, false);
    assert.ok(byKey.get("gone")!.unavailableSince, "unavailableSince is stamped");
  });

  test("26. a failed LATER page must not mark existing products unavailable", async () => {
    const catalog = new Catalog();

    await syncBrandCommerceProducts(
      BRAND_ID,
      CommerceProvider.COMMERCE7,
      {},
      makeDeps(
        catalog,
        makeFetch([
          { body: { products: [c7Product({ id: "a" }), c7Product({ id: "b" })] } },
        ]),
      ),
    );
    assert.equal(catalog.forConnection(CONNECTION_ID).every((r) => r.isAvailable), true);

    // First page succeeds, second page 500s mid-catalog.
    const outcome = await syncBrandCommerceProducts(
      BRAND_ID,
      CommerceProvider.COMMERCE7,
      {},
      makeDeps(
        catalog,
        makeFetch([
          { body: { products: [c7Product({ id: "a" })], cursor: "c2" } },
          { ok: false, status: 500, body: {} },
        ]),
      ),
    );

    assert.notEqual(outcome.status, "SUCCEEDED", "a truncated catalog is not a success");
    assert.equal(
      catalog.forConnection(CONNECTION_ID).every((r) => r.isAvailable),
      true,
      "a partial catalog must NEVER mark live products unavailable",
    );
  });

  test("the sync selects the intended provider's connection, not just any brand connection", async () => {
    const catalog = new Catalog();
    const deps = makeDeps(catalog, makeFetch([{ body: { products: [] } }]));

    // Asking for SHOPIFY on a Commerce7-only brand resolves no connection.
    const outcome = await syncBrandCommerceProducts(
      BRAND_ID,
      CommerceProvider.SHOPIFY,
      {},
      deps,
    );

    assert.equal(outcome.status, "SKIPPED");
    assert.equal(catalog.rows.size, 0);
  });
});
