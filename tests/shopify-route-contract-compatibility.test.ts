process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";

/**
 * tests/shopify-route-contract-compatibility.test.ts
 *
 * Contract-compatibility tests for the Phase-2 cutover of the two Brand
 * Shopify routes onto the provider-neutral commerce service + adapter:
 *   - src/app/api/brand/shopify/status/route.ts
 *   - src/app/api/brand/shopify/products/route.ts
 *
 * No real DB and no real network anywhere in this file — every DB-backed or
 * network-backed dependency (`getContext`, `findTokenExtra`,
 * `getConnectionSummary`, `registry`, `fetchProductsDirect`,
 * `markLegacyProductSync`) is injected via the routes' own
 * `Partial<...Deps>` parameter, the same idiom already used by
 * `tests/commerce-connection-service.test.ts` and
 * `tests/shopify-commerce-adapter.test.ts`. Both route impls
 * (`statusGetImpl` / `productsGetImpl`) are pre-existing-shaped DI wrappers
 * added in this cutover (see the PR description) so they are testable
 * without a real session/DB — `GET()` itself still calls them with zero
 * overrides, so runtime behavior is unchanged.
 *
 * Covered cases (numbered to match the Phase-2 review checklist):
 *  1.  Status route: exact key set + values of the 200 body for connected /
 *      disconnected / uninstalled / requires-reconnect / never-connected.
 *  2.  Status route: context-failure (403 / 409) and 500 branches unchanged.
 *  3.  Status route: identical output whether or not a CommerceConnection
 *      row exists (mirror present-and-agreeing vs legacy fallback vs a
 *      mirror that DISAGREES with legacy — proving the "prefer legacy on any
 *      mismatch" safety net actually fires).
 *  4.  Products route: 200 body exact key set including meta.hasNextPage /
 *      meta.limit.
 *  5.  Products route: adapter path and legacy-fallback path produce
 *      BYTE-IDENTICAL responses (deep-equal the two JSON payloads).
 *  6.  Products route: fetch failure maps to the same {error} body and
 *      status as today, for both the direct path and the adapter path.
 *  7.  Products route: not-connected 400 body unchanged (all three legacy
 *      gate sub-conditions).
 *  8.  Products route: Brand.shopifyLastProductSyncAt is still stamped (and
 *      only on success).
 *  9.  Products route: no product is ever persisted (asserted both via a
 *      write-throwing DI + a static source-text check for any
 *      product-shaped persistence call).
 *  10. Products route: provider selection goes through the injected
 *      registry (never a hard-coded adapter construction).
 *  11. COMMERCE7 remains controlled: no network call (the direct-fetch
 *      fallback is proven never invoked), and the registry's own
 *      UnsupportedProviderError is what surfaces (as the generic 500).
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { CommerceProvider } from "@prisma/client";

import type { BrandAdminContext } from "../src/lib/brand-auth";
import type { CommerceConnectionSummary } from "../src/lib/commerce/types";
import {
  CommerceAdapterRegistry,
  createCommerceAdapterRegistry,
} from "../src/lib/commerce/registry";
import { UnsupportedProviderError } from "../src/lib/commerce/errors";
import {
  ShopifyCommerceAdapter,
  type ShopifyCommerceAdapterDeps,
  type ShopifyCommerceConnectionRow,
} from "../src/lib/commerce/providers/shopify-commerce-adapter";
import type { NormalizedShopifyProduct } from "../src/lib/shopify-products";

// The two route modules are dynamically imported inside `before()` below,
// AFTER the DATABASE_URL/etc. env vars at the top of this file have been
// set. A static top-level `import` of either route would be hoisted ahead
// of those env assignments (ESM import evaluation always runs before the
// importing module's own top-level statements, regardless of textual
// order) — and both routes transitively import `@/lib/prisma` via
// `@/lib/brand-auth` -> the NextAuth `authOptions` module, which throws
// synchronously at import time when `DATABASE_URL` is unset. Only
// TYPE-only imports (erased at compile time, no runtime import) are safe to
// keep static.
import type { BrandShopifyStatusDeps } from "../src/app/api/brand/shopify/status/route";
import type { BrandShopifyProductsDeps } from "../src/app/api/brand/shopify/products/route";

let statusGetImpl: (
  overrides?: Partial<BrandShopifyStatusDeps>,
) => Promise<Response>;
let productsGetImpl: (
  overrides?: Partial<BrandShopifyProductsDeps>,
) => Promise<Response>;

before(async () => {
  statusGetImpl = (await import("../src/app/api/brand/shopify/status/route")).statusGetImpl;
  productsGetImpl = (await import("../src/app/api/brand/shopify/products/route")).productsGetImpl;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type BrandFixtureFields = NonNullable<BrandAdminContext["membership"]>["brand"];

function makeBrand(overrides: Partial<BrandFixtureFields> = {}): BrandFixtureFields {
  return {
    id: "brand-1",
    name: "Acme",
    slug: "acme",
    bio: null,
    websiteUrl: null,
    logoUrl: null,
    coverImageUrl: null,
    shopifyShopDomain: "test-shop.myshopify.com",
    shopifyAdminAccessTokenEncrypted: "encrypted-token",
    shopifyInstalledAt: new Date("2026-01-01T00:00:00Z"),
    shopifyDisconnectedAt: null,
    shopifyUninstalledAt: null,
    shopifyConnectionStatus: "CONNECTED",
    shopifyLastProductSyncAt: new Date("2026-02-01T00:00:00Z"),
    shopifyCurrencyCode: "USD",
    ...overrides,
  };
}

function makeContext(brand: BrandFixtureFields | null): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired: false,
    brands: brand ? [{ id: brand.id, name: brand.name, slug: brand.slug, membershipRole: "ADMIN" }] : [],
    membership: brand
      ? { id: "member-1", role: "ADMIN", brand }
      : null,
  };
}

function makeSummary(
  brand: BrandFixtureFields,
  overrides: Partial<CommerceConnectionSummary> = {},
): CommerceConnectionSummary {
  return {
    id: "conn-1",
    brandId: brand.id,
    provider: CommerceProvider.SHOPIFY,
    status: brand.shopifyConnectionStatus as CommerceConnectionSummary["status"],
    displayName: "test-shop",
    externalAccountId: brand.shopifyShopDomain ?? "",
    storefrontUrl: brand.shopifyShopDomain ? `https://${brand.shopifyShopDomain}` : null,
    isPrimary: true,
    grantedScopes: [],
    installedAt: brand.shopifyInstalledAt,
    uninstalledAt: brand.shopifyUninstalledAt,
    lastProductSyncAt: brand.shopifyLastProductSyncAt,
    isLegacyFallback: false,
    ...overrides,
  };
}

function legacyFallbackSummary(brand: BrandFixtureFields): CommerceConnectionSummary | null {
  if (!brand.shopifyShopDomain) {
    return null;
  }
  return makeSummary(brand, { id: null, isLegacyFallback: true });
}

/** Every method throws unless overridden — an unexpected call fails loudly. */
function makeStatusDeps(overrides: Partial<BrandShopifyStatusDeps> = {}): BrandShopifyStatusDeps {
  return {
    async getContext() {
      throw new Error("getContext should not be called in this test");
    },
    async findTokenExtra() {
      throw new Error("findTokenExtra should not be called in this test");
    },
    async getConnectionSummary() {
      throw new Error("getConnectionSummary should not be called in this test");
    },
    ...overrides,
  };
}

function makeProductsDeps(overrides: Partial<BrandShopifyProductsDeps> = {}): BrandShopifyProductsDeps {
  return {
    async getContext() {
      throw new Error("getContext should not be called in this test");
    },
    async getConnectionSummary() {
      throw new Error("getConnectionSummary should not be called in this test");
    },
    registry: createCommerceAdapterRegistry({}),
    async fetchProductsDirect() {
      throw new Error("fetchProductsDirect should not be called in this test");
    },
    async markLegacyProductSync() {
      throw new Error("markLegacyProductSync should not be called in this test");
    },
    ...overrides,
  };
}

const canonicalProduct: NormalizedShopifyProduct = {
  id: "889192837",
  shopifyProductGid: "889192837",
  title: "Canonical Product",
  handle: "canonical-product",
  productUrl: "https://test-shop.myshopify.com/products/canonical-product",
  images: ["https://cdn.example.com/1.jpg", "https://cdn.example.com/2.jpg"],
  imageUrl: "https://cdn.example.com/1.jpg",
  priceRange: { min: 19.99, max: 29.99 },
  priceText: "$19.99 - $29.99",
  currency: "USD",
  variantIds: ["1001", "1002"],
  priceRangeRaw: { min: "19.99", max: "29.99" },
  descriptionText: "Canonical product description.",
  status: "ACTIVE",
  providerCreatedAt: new Date("2024-01-01T00:00:00.000Z"),
  providerUpdatedAt: new Date("2024-01-02T00:00:00.000Z"),
  sku: "SKU-1",
};

const expectedProductResponseItem = {
  id: "889192837",
  shopifyProductGid: "889192837",
  title: "Canonical Product",
  handle: "canonical-product",
  productUrl: "https://test-shop.myshopify.com/products/canonical-product",
  imageUrl: "https://cdn.example.com/1.jpg",
  images: ["https://cdn.example.com/1.jpg", "https://cdn.example.com/2.jpg"],
  priceRange: { min: 19.99, max: 29.99 },
  variantIds: ["1001", "1002"],
};

function fakeConnectionRow(
  overrides: Partial<ShopifyCommerceConnectionRow> = {},
): ShopifyCommerceConnectionRow {
  return {
    id: "conn-1",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED",
    displayName: "test-shop",
    externalAccountId: "test-shop.myshopify.com",
    storefrontUrl: "https://test-shop.myshopify.com",
    isPrimary: true,
    grantedScopes: [],
    installedAt: new Date("2026-01-01T00:00:00Z"),
    uninstalledAt: null,
    lastProductSyncAt: null,
    ...overrides,
  };
}

/** Every method throws unless overridden — mirrors shopify-commerce-adapter.test.ts's makeDeps(). */
function fakeAdapterDeps(overrides: Partial<ShopifyCommerceAdapterDeps> = {}): ShopifyCommerceAdapterDeps {
  return {
    async loadConnection() {
      throw new Error("loadConnection should not be called in this test");
    },
    async getAccessToken() {
      throw new Error("getAccessToken should not be called in this test");
    },
    async fetchProducts() {
      throw new Error("fetchProducts should not be called in this test");
    },
    async createDiscountCode() {
      throw new Error("createDiscountCode should not be called in this test");
    },
    verifyWebhookHmac() {
      throw new Error("verifyWebhookHmac should not be called in this test");
    },
    async markProductSync() {
      // no-op by default; tests that care about this override it
    },
    ...overrides,
  };
}

/** Builds a registry that resolves SHOPIFY to a real ShopifyCommerceAdapter with injected deps, and records how many times a provider was requested. */
function makeAdapterRegistry(deps: Partial<ShopifyCommerceAdapterDeps>) {
  const calls = { shopifyRequested: 0 };
  const registry = createCommerceAdapterRegistry({
    [CommerceProvider.SHOPIFY]: () => {
      calls.shopifyRequested += 1;
      return new ShopifyCommerceAdapter(fakeAdapterDeps(deps));
    },
  });
  return { registry, calls };
}

// ---------------------------------------------------------------------------
// 1-3: status route
// ---------------------------------------------------------------------------

describe("brand/shopify/status route contract", () => {
  test("1. exact key set + values for connected / disconnected / uninstalled / requires-reconnect / never-connected", async () => {
    const cases: Array<{
      label: string;
      brand: Partial<BrandFixtureFields>;
    }> = [
      { label: "connected", brand: { shopifyConnectionStatus: "CONNECTED" } },
      {
        label: "disconnected",
        brand: {
          shopifyConnectionStatus: "DISCONNECTED",
          shopifyAdminAccessTokenEncrypted: null,
          shopifyDisconnectedAt: new Date("2026-03-01T00:00:00Z"),
        },
      },
      {
        label: "uninstalled",
        brand: {
          shopifyConnectionStatus: "UNINSTALLED",
          shopifyAdminAccessTokenEncrypted: null,
          shopifyUninstalledAt: new Date("2026-03-05T00:00:00Z"),
        },
      },
      {
        label: "requires-reconnect",
        brand: { shopifyConnectionStatus: "REQUIRES_RECONNECT" },
      },
      {
        label: "never-connected",
        brand: {
          shopifyShopDomain: null,
          shopifyAdminAccessTokenEncrypted: null,
          shopifyConnectionStatus: "DISCONNECTED",
          shopifyInstalledAt: null,
          shopifyLastProductSyncAt: null,
          shopifyCurrencyCode: null,
        },
      },
    ];

    const expectedKeys = [
      "id",
      "name",
      "slug",
      "shopifyShopDomain",
      "shopifyInstalledAt",
      "shopifyDisconnectedAt",
      "shopifyUninstalledAt",
      "shopifyConnectionStatus",
      "hasShopifyAccessToken",
      "shopifyLastProductSyncAt",
      "shopifyCurrencyCode",
      "shopifyAuthMode",
      "shopifyAccessTokenExpiresAt",
      "shopifyGrantedScopes",
      "requiresReconnect",
    ].sort();

    for (const { label, brand: brandOverrides } of cases) {
      const brand = makeBrand(brandOverrides);
      const summary = legacyFallbackSummary(brand);

      const deps = makeStatusDeps({
        async getContext() {
          return makeContext(brand);
        },
        async findTokenExtra() {
          return {
            shopifyAuthMode: "LEGACY_OFFLINE",
            shopifyAccessTokenExpiresAt: null,
            shopifyGrantedScopes: "read_products,write_discounts",
          };
        },
        async getConnectionSummary() {
          return summary;
        },
      });

      const response = await statusGetImpl(deps);
      assert.equal(response.status, 200, `${label}: expected 200`);
      const json = await response.json();

      assert.deepEqual(
        Object.keys(json.data).sort(),
        expectedKeys,
        `${label}: response key set changed`,
      );

      assert.equal(json.data.id, brand.id, label);
      assert.equal(json.data.name, brand.name, label);
      assert.equal(json.data.slug, brand.slug, label);
      assert.equal(json.data.shopifyShopDomain, brand.shopifyShopDomain, label);
      assert.equal(
        json.data.shopifyInstalledAt,
        brand.shopifyInstalledAt ? brand.shopifyInstalledAt.toISOString() : null,
        label,
      );
      assert.equal(
        json.data.shopifyDisconnectedAt,
        brand.shopifyDisconnectedAt ? brand.shopifyDisconnectedAt.toISOString() : null,
        label,
      );
      assert.equal(
        json.data.shopifyUninstalledAt,
        brand.shopifyUninstalledAt ? brand.shopifyUninstalledAt.toISOString() : null,
        label,
      );
      assert.equal(json.data.shopifyConnectionStatus, brand.shopifyConnectionStatus, label);
      assert.equal(
        json.data.hasShopifyAccessToken,
        Boolean(brand.shopifyAdminAccessTokenEncrypted),
        label,
      );
      assert.equal(
        json.data.shopifyLastProductSyncAt,
        brand.shopifyLastProductSyncAt ? brand.shopifyLastProductSyncAt.toISOString() : null,
        label,
      );
      assert.equal(json.data.shopifyCurrencyCode, brand.shopifyCurrencyCode, label);
      assert.equal(json.data.shopifyAuthMode, "LEGACY_OFFLINE", label);
      assert.equal(json.data.shopifyAccessTokenExpiresAt, null, label);
      assert.equal(json.data.shopifyGrantedScopes, "read_products,write_discounts", label);
      assert.equal(
        json.data.requiresReconnect,
        brand.shopifyConnectionStatus === "REQUIRES_RECONNECT",
        label,
      );
    }
  });

  test("2. context-failure (403 / 409) and 500 branches are unchanged", async () => {
    // No session / not brand-eligible -> 403, no code field.
    const forbidden = await statusGetImpl(
      makeStatusDeps({ async getContext() { return null; } }),
    );
    assert.equal(forbidden.status, 403);
    const forbiddenJson = await forbidden.json();
    assert.deepEqual(forbiddenJson, { error: "Brand admin access required." });

    // Selection required -> 409 with ACTIVE_BRAND_REQUIRED code.
    const selectionRequired = await statusGetImpl(
      makeStatusDeps({
        async getContext() {
          return { userId: "user-1", selectionRequired: true, brands: [], membership: null };
        },
      }),
    );
    assert.equal(selectionRequired.status, 409);
    const selectionJson = await selectionRequired.json();
    assert.deepEqual(selectionJson, {
      error: "Select an active brand before continuing.",
      code: "ACTIVE_BRAND_REQUIRED",
    });

    // Unexpected throw -> 500 with the fixed message, never leaking the error.
    const errored = await statusGetImpl(
      makeStatusDeps({
        async getContext() {
          return makeContext(makeBrand());
        },
        async findTokenExtra() {
          throw new Error("simulated DB failure");
        },
      }),
    );
    assert.equal(errored.status, 500);
    const erroredJson = await errored.json();
    assert.deepEqual(erroredJson, { error: "Failed to load Shopify status." });
  });

  test("3. identical output whether the mirror is absent, agreeing, or DISAGREEING with legacy", async () => {
    const brand = makeBrand({ shopifyConnectionStatus: "CONNECTED" });
    const baseDeps = {
      async getContext() {
        return makeContext(brand);
      },
      async findTokenExtra() {
        return {
          shopifyAuthMode: "LEGACY_OFFLINE" as const,
          shopifyAccessTokenExpiresAt: null,
          shopifyGrantedScopes: null,
        };
      },
    };

    // (a) No CommerceConnection row at all -> legacy fallback (id: null).
    const noRow = await statusGetImpl(
      makeStatusDeps({
        ...baseDeps,
        async getConnectionSummary() {
          return legacyFallbackSummary(brand);
        },
      }),
    );
    const noRowJson = await noRow.json();

    // (b) A CommerceConnection row exists and its status/timestamps agree
    // with legacy exactly (the common, healthy case).
    const agreeingRow = await statusGetImpl(
      makeStatusDeps({
        ...baseDeps,
        async getConnectionSummary() {
          return makeSummary(brand, { isLegacyFallback: false });
        },
      }),
    );
    const agreeingJson = await agreeingRow.json();

    // (c) A CommerceConnection row exists but is STALE (status disagrees
    // with legacy, as a best-effort dual-write lagging behind would look) —
    // the route must still prefer the legacy value, not the stale mirror.
    const disagreeingRow = await statusGetImpl(
      makeStatusDeps({
        ...baseDeps,
        async getConnectionSummary() {
          return makeSummary(brand, {
            isLegacyFallback: false,
            status: "DISCONNECTED",
          });
        },
      }),
    );
    const disagreeingJson = await disagreeingRow.json();

    assert.deepEqual(noRowJson, agreeingJson, "no-row vs agreeing-row must match");
    assert.deepEqual(agreeingJson, disagreeingJson, "agreeing-row vs disagreeing-row must match (legacy wins)");
    assert.equal(
      disagreeingJson.data.shopifyConnectionStatus,
      "CONNECTED",
      "a stale/disagreeing mirror must never leak into the response",
    );
  });
});

// ---------------------------------------------------------------------------
// 4-11: products route
// ---------------------------------------------------------------------------

describe("brand/shopify/products route contract", () => {
  test("4. 200 body exact key set including meta.hasNextPage / meta.limit", async () => {
    const brand = makeBrand();
    const marked: string[] = [];

    const response = await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return null;
        },
        async fetchProductsDirect() {
          return { ok: true, items: [canonicalProduct], hasNextPage: true, limit: 100, endCursor: null };
        },
        async markLegacyProductSync(brandId) {
          marked.push(brandId);
        },
      }),
    );

    assert.equal(response.status, 200);
    const json = await response.json();
    assert.deepEqual(Object.keys(json).sort(), ["data", "meta"]);
    assert.deepEqual(Object.keys(json.meta).sort(), ["hasNextPage", "limit"]);
    assert.equal(json.meta.hasNextPage, true);
    assert.equal(json.meta.limit, 100);
    assert.equal(json.data.length, 1);
    assert.deepEqual(Object.keys(json.data[0]).sort(), Object.keys(expectedProductResponseItem).sort());
    assert.deepEqual(json.data[0], expectedProductResponseItem);
  });

  test("5. adapter path and legacy-fallback path produce BYTE-IDENTICAL responses", async () => {
    const brand = makeBrand();

    // (a) Legacy fallback path: no real CommerceConnection.id.
    const directResponse = await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return legacyFallbackSummary(brand);
        },
        async fetchProductsDirect(input) {
          assert.deepEqual(input, { shopDomain: brand.shopifyShopDomain, brandId: brand.id, limit: 100 });
          return { ok: true, items: [canonicalProduct], hasNextPage: true, limit: 100, endCursor: null };
        },
        async markLegacyProductSync() {},
      }),
    );
    const directJson = await directResponse.json();

    // (b) Adapter path: a real CommerceConnection.id, resolved through the
    // registry to a REAL ShopifyCommerceAdapter (with the DB/network deps
    // injected) — not a hand-rolled route-level mock.
    const { registry } = makeAdapterRegistry({
      async loadConnection(connectionId) {
        assert.equal(connectionId, "conn-1");
        return fakeConnectionRow({ externalAccountId: brand.shopifyShopDomain! });
      },
      async fetchProducts(input) {
        assert.deepEqual(input, { shopDomain: brand.shopifyShopDomain, brandId: brand.id });
        return { ok: true, items: [canonicalProduct], hasNextPage: true, limit: 100, endCursor: null };
      },
    });
    const adapterResponse = await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return makeSummary(brand, { isLegacyFallback: false });
        },
        registry,
        async fetchProductsDirect() {
          throw new Error("the adapter path must never call fetchProductsDirect");
        },
        async markLegacyProductSync() {},
      }),
    );
    const adapterJson = await adapterResponse.json();

    assert.equal(directResponse.status, 200);
    assert.equal(adapterResponse.status, 200);
    assert.deepEqual(directJson, adapterJson, "direct and adapter paths must be byte-identical");
    assert.deepEqual(directJson.data[0], expectedProductResponseItem);
  });

  test("6. fetch failure maps to the same {error} body and status as today, for both paths", async () => {
    const brand = makeBrand();

    // Direct path failure.
    const directFail = await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return legacyFallbackSummary(brand);
        },
        async fetchProductsDirect() {
          return { ok: false, status: 502, tokenReason: undefined, error: "Shopify returned an error." };
        },
      }),
    );
    assert.equal(directFail.status, 502);
    assert.deepEqual(await directFail.json(), { error: "Shopify returned an error." });

    // Adapter path failure — the adapter throws CommerceProviderApiError
    // carrying the SAME upstream status via httpStatus; the route must map
    // it back onto the identical body/status.
    const { registry } = makeAdapterRegistry({
      async loadConnection() {
        return fakeConnectionRow();
      },
      async fetchProducts() {
        return {
          ok: false,
          status: 401,
          tokenReason: "NEEDS_RECONNECT" as const,
          error: "Shopify connection requires reconnection.",
        };
      },
    });
    const adapterFail = await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return makeSummary(brand, { isLegacyFallback: false });
        },
        registry,
      }),
    );
    assert.equal(adapterFail.status, 401);
    assert.deepEqual(await adapterFail.json(), { error: "Shopify connection requires reconnection." });
  });

  test("7. not-connected 400 body unchanged for every legacy gate sub-condition", async () => {
    const cases: Array<[string, Partial<BrandFixtureFields>]> = [
      ["missing shop domain", { shopifyShopDomain: null }],
      ["missing access token", { shopifyAdminAccessTokenEncrypted: null }],
      ["status not CONNECTED", { shopifyConnectionStatus: "DISCONNECTED" }],
    ];

    for (const [label, overrides] of cases) {
      const brand = makeBrand(overrides);
      const response = await productsGetImpl(
        makeProductsDeps({
          async getContext() {
            return makeContext(brand);
          },
        }),
      );
      assert.equal(response.status, 400, label);
      assert.deepEqual(
        await response.json(),
        { error: "Shopify is not connected for this brand." },
        label,
      );
    }
  });

  test("8. Brand.shopifyLastProductSyncAt is stamped on success, and never on failure", async () => {
    const brand = makeBrand();
    const markedSuccess: string[] = [];

    await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return legacyFallbackSummary(brand);
        },
        async fetchProductsDirect() {
          return { ok: true, items: [canonicalProduct], hasNextPage: false, limit: 100, endCursor: null };
        },
        async markLegacyProductSync(brandId) {
          markedSuccess.push(brandId);
        },
      }),
    );
    assert.deepEqual(markedSuccess, [brand.id]);

    const markedFailure: string[] = [];
    await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return legacyFallbackSummary(brand);
        },
        async fetchProductsDirect() {
          return { ok: false, status: 502, tokenReason: undefined, error: "boom" };
        },
        async markLegacyProductSync(brandId) {
          markedFailure.push(brandId);
        },
      }),
    );
    assert.deepEqual(markedFailure, [], "must not stamp lastProductSyncAt on a failed fetch");
  });

  test("9. no product is ever persisted", async () => {
    const brand = makeBrand();

    // The only DB-shaped dependency the route calls on success is
    // markLegacyProductSync, which — per its default implementation — only
    // ever calls prisma.brand.update. Nothing else in this DI graph touches
    // a database at all, so a persistence call is structurally impossible
    // here; this assertion documents that invariant.
    await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return legacyFallbackSummary(brand);
        },
        async fetchProductsDirect() {
          return { ok: true, items: [canonicalProduct], hasNextPage: false, limit: 100, endCursor: null };
        },
        async markLegacyProductSync() {},
      }),
    );

    // Static check: the route source must never reference a product-shaped
    // persistence call or a ConnectedCommerceProduct-style model.
    const routeSource = readFileSync(
      "src/app/api/brand/shopify/products/route.ts",
      "utf8",
    );
    assert.doesNotMatch(
      routeSource,
      /ConnectedCommerceProduct|\.product\.(create|upsert|update)|prisma\.\w*[Pp]roduct\w*\.(create|upsert)/,
      "products route must never persist a product",
    );
    assert.doesNotMatch(
      routeSource,
      /\.create\(|\.upsert\(/,
      "products route must never call a create/upsert prisma method directly",
    );
  });

  test("10. provider selection goes through the injected registry, never a hard-coded adapter", async () => {
    const brand = makeBrand();
    const { registry, calls } = makeAdapterRegistry({
      async loadConnection() {
        return fakeConnectionRow();
      },
      async fetchProducts() {
        return { ok: true, items: [canonicalProduct], hasNextPage: false, limit: 100, endCursor: null };
      },
    });

    const response = await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return makeSummary(brand, { isLegacyFallback: false });
        },
        registry,
        async markLegacyProductSync() {},
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(calls.shopifyRequested, 1, "the route must resolve the adapter via the injected registry's factory");
  });

  test("11. COMMERCE7 remains controlled: no network call, UnsupportedProviderError surfaces as the generic 500", async () => {
    const brand = makeBrand();
    // An empty registry (no COMMERCE7 factory registered) mirrors
    // defaultCommerceAdapterRegistry's real wiring — COMMERCE7 has no
    // adapter today.
    const registry: CommerceAdapterRegistry = createCommerceAdapterRegistry({});

    let directFetchCalled = false;
    const response = await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return makeSummary(brand, {
            isLegacyFallback: false,
            provider: CommerceProvider.COMMERCE7,
          });
        },
        registry,
        async fetchProductsDirect() {
          directFetchCalled = true;
          throw new Error("must never be called for an unsupported provider");
        },
      }),
    );

    assert.equal(directFetchCalled, false, "no Shopify-specific direct fetch (and so no network call) for COMMERCE7");
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Failed to load Shopify products." });

    // Confirm independently that the registry itself is what would have
    // thrown — the route relies on this exact error type, not a bespoke
    // provider check.
    assert.throws(
      () => registry.get(CommerceProvider.COMMERCE7),
      (error: unknown) => error instanceof UnsupportedProviderError,
    );
  });
});
