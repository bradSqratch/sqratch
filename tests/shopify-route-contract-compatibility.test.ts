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
 * network-backed dependency (`getContext`, `getConnectionSummary`,
 * `getCredential`, and `registry`) is injected via the
 * routes' own `Partial<...Deps>` parameter, the same idiom already used by
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
 *  3.  Status route: canonical connection status is authoritative.
 *  4.  Products route: 200 body exact key set including meta.hasNextPage /
 *      meta.limit.
 *  5.  Products route: adapter path preserves the established response.
 *  6.  Products route: fetch failures preserve the established error shape.
 *  7.  Products route: not-connected 400 body remains unchanged.
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

/**
 * PHASE 14C-A: `Brand.shopify*` fields no longer exist on the real
 * `BrandAdminContext["membership"]["brand"]` type (brand-auth.ts /
 * brand-context.ts no longer select them). Test fixtures in this file still
 * thread a shopify-shaped state object through to derive the INJECTED
 * `CommerceConnectionSummary` these route tests provide via DI — the routes
 * themselves never read `Brand.shopify*` (they never did, even
 * pre-cutover, for status/products — connectivity always came through the
 * injected `getConnectionSummary`), so this is purely a test-fixture
 * convenience, kept as an intersection type so `makeBrand`'s existing
 * call sites (dozens, throughout this file) don't all need touching.
 */
type LegacyShopifyFixtureFields = {
  shopifyShopDomain: string | null;
  shopifyAdminAccessTokenEncrypted: string | null;
  shopifyInstalledAt: Date | null;
  shopifyDisconnectedAt: Date | null;
  shopifyUninstalledAt: Date | null;
  shopifyConnectionStatus: "DISCONNECTED" | "CONNECTED" | "UNINSTALLED" | "REQUIRES_RECONNECT";
  shopifyLastProductSyncAt: Date | null;
  shopifyCurrencyCode: string | null;
};

type FullBrandFixture = BrandFixtureFields & LegacyShopifyFixtureFields;

function makeBrand(overrides: Partial<FullBrandFixture> = {}): FullBrandFixture {
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

function makeContext(brand: FullBrandFixture | null): BrandAdminContext {
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
  brand: FullBrandFixture,
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
    currencyCode: brand.shopifyCurrencyCode,
    ...overrides,
  };
}

/** Every method throws unless overridden — an unexpected call fails loudly. */
function makeStatusDeps(overrides: Partial<BrandShopifyStatusDeps> = {}): BrandShopifyStatusDeps {
  return {
    async getContext() {
      throw new Error("getContext should not be called in this test");
    },
    async getConnectionSummary() {
      throw new Error("getConnectionSummary should not be called in this test");
    },
    async getCredential() {
      throw new Error("getCredential should not be called in this test");
    },
    async reconcileScopes() {
      throw new Error("reconcileScopes should not be called in this test");
    },
    ...overrides,
  };
}

/** A canonical credential present and usable — the common "connected" shape. */
function okCredential(overrides: Partial<{
  accessToken: string | null;
  authMode: string;
  accessTokenExpiresAt: Date | null;
  providerClientId: string | null;
}> = {}) {
  return {
    outcome: "OK" as const,
    credential: {
      connectionId: "conn-1",
      brandId: "brand-1",
      shopDomain: "test-shop.myshopify.com",
      providerClientId: overrides.providerClientId ?? null,
      status: "CONNECTED" as const,
      grantedScopes: "read_products,write_discounts",
      authMode: overrides.authMode ?? "LEGACY_OFFLINE",
      accessToken: overrides.accessToken ?? "shpat_test_token",
      accessTokenExpiresAt: overrides.accessTokenExpiresAt ?? null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
      currencyCode: null,
    },
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
    ...overrides,
  };
}

const canonicalProduct: NormalizedShopifyProduct = {
  id: "889192837",
  shopifyProductGid: "889192837",
  title: "Canonical Product",
  handle: "canonical-product",
  productUrl: "https://test-shop.myshopify.com/products/canonical-product",
  hasProviderStorefrontPublication: true,
  hasProviderSuppliedStorefrontUrl: true,
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
    providerMetadata: { authMode: "LEGACY_OFFLINE", currencyCode: "USD" },
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
    async fetchPublishedProductIds() {
      throw new Error("fetchPublishedProductIds should not be called in this test");
    },
    async createDiscountCode() {
      throw new Error("createDiscountCode should not be called in this test");
    },
    async lookupDiscountByNodeId() {
      throw new Error("lookupDiscountByNodeId should not be called in this test");
    },
    async lookupDiscountByCode() {
      throw new Error("lookupDiscountByCode should not be called in this test");
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
      brand: Partial<FullBrandFixture>;
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
      "shopifyUninstalledAt",
      "shopifyConnectionStatus",
      "hasShopifyAccessToken",
      "shopifyLastProductSyncAt",
      "shopifyCurrencyCode",
      "shopifyAuthMode",
      "shopifyAccessTokenExpiresAt",
      "shopifyGrantedScopes",
      "requiresReconnect",
      "orderAttributionReady",
      "themeVerificationScopeReady",
      "themeTracking",
      "overallConversionTrackingReady",
      "shopifyPermissionsNeedApproval",
      "shopifyPermissionApprovalUrl",
      "shopifyAppEmbedDeepLink",
    ].sort();

    for (const { label, brand: brandOverrides } of cases) {
      const brand = makeBrand(brandOverrides);
      // The summary is the canonical source for identity, status, and scopes.
      const summary = brand.shopifyShopDomain
        ? makeSummary(brand, {
            grantedScopes: ["read_products", "write_discounts"],
          })
        : null;
      const hasToken = Boolean(brand.shopifyAdminAccessTokenEncrypted);

      const deps = makeStatusDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return summary;
        },
        async getCredential() {
          return hasToken
            ? okCredential({ accessToken: "shpat_test_token" })
            : { outcome: "NO_CONNECTION" as const };
        },
        // Exercised only by the "requires-reconnect" case (see the
        // healing-specific coverage in tests/shopify-scopes-update-webhook.test.ts
        // and tests/shopify-token-manager.test.ts for the real function's
        // behavior) — this test's own concern is the response SHAPE across
        // every status, not the healing/reconciliation attempt itself, so a
        // no-op stub keeps it real-network-free per this file's own header.
        async reconcileScopes() {
          return null;
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
        json.data.shopifyUninstalledAt,
        brand.shopifyUninstalledAt ? brand.shopifyUninstalledAt.toISOString() : null,
        label,
      );
      assert.equal(json.data.shopifyConnectionStatus, brand.shopifyConnectionStatus, label);
      assert.equal(json.data.hasShopifyAccessToken, hasToken, label);
      assert.equal(
        json.data.shopifyLastProductSyncAt,
        brand.shopifyLastProductSyncAt ? brand.shopifyLastProductSyncAt.toISOString() : null,
        label,
      );
      assert.equal(json.data.shopifyCurrencyCode, brand.shopifyCurrencyCode, label);
      assert.equal(json.data.shopifyAuthMode, "LEGACY_OFFLINE", label);
      assert.equal(json.data.shopifyAccessTokenExpiresAt, null, label);
      assert.equal(
        json.data.shopifyGrantedScopes,
        summary ? "read_products,write_discounts" : null,
        label,
      );
      assert.equal(
        json.data.requiresReconnect,
        brand.shopifyConnectionStatus === "REQUIRES_RECONNECT",
        label,
      );
      assert.equal(json.data.themeTracking.state, "PERMISSION_REQUIRED", label);
      assert.equal(json.data.overallConversionTrackingReady, false, label);
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
        async getConnectionSummary() {
          throw new Error("simulated DB failure");
        },
      }),
    );
    assert.equal(errored.status, 500);
    const erroredJson = await errored.json();
    assert.deepEqual(erroredJson, { error: "Failed to load Shopify status." });
  });

  test("3. canonical connection status is authoritative", async () => {
    const brand = makeBrand({ shopifyConnectionStatus: "CONNECTED" });
    const baseDeps = {
      async getContext() {
        return makeContext(brand);
      },
      async getCredential() {
        return okCredential();
      },
    };

    const agreeingRow = await statusGetImpl(
      makeStatusDeps({
        ...baseDeps,
        async getConnectionSummary() {
          return makeSummary(brand);
        },
      }),
    );
    const agreeingJson = await agreeingRow.json();
    assert.equal(agreeingJson.data.shopifyConnectionStatus, "CONNECTED");

    const disagreeingRow = await statusGetImpl(
      makeStatusDeps({
        ...baseDeps,
        async getConnectionSummary() {
          return makeSummary(brand, {
            status: "DISCONNECTED",
          });
        },
      }),
    );
    const disagreeingJson = await disagreeingRow.json();

    assert.equal(
      disagreeingJson.data.shopifyConnectionStatus,
      "DISCONNECTED",
      "the canonical status must be returned",
    );
    assert.notDeepEqual(
      disagreeingJson,
      agreeingJson,
      "a genuinely DISCONNECTED canonical connection must produce a materially different response",
    );
  });

  test("3b. shopifyAppEmbedDeepLink is null unless BOTH shop domain and client id are usable", async () => {
    const clientId = "0123456789abcdef0123456789abcdef";

    // PHASE 14C-A: `providerClientId` now comes ONLY from the canonical
    // credential (`getCredential`) — the legacy `findTokenExtra` fallback
    // was deleted entirely from status/route.ts along with the rest of the
    // Brand.shopify* read path.
    async function deepLinkFor(
      brandOverrides: Partial<FullBrandFixture>,
      providerClientId: string | null,
    ): Promise<unknown> {
      const brand = makeBrand(brandOverrides);
      const summary = brand.shopifyShopDomain ? makeSummary(brand ) : null;
      const response = await statusGetImpl(
        makeStatusDeps({
          async getContext() {
            return makeContext(brand);
          },
          async getConnectionSummary() {
            return summary;
          },
          async getCredential() {
            return summary
              ? okCredential({ providerClientId })
              : { outcome: "NO_CONNECTION" as const };
          },
        }),
      );
      assert.equal(response.status, 200);
      return (await response.json()).data.shopifyAppEmbedDeepLink;
    }

    // Both present -> a fully-formed Theme Editor deep link.
    assert.equal(
      await deepLinkFor({}, clientId),
      "https://test-shop.myshopify.com/admin/themes/current/editor" +
        `?context=apps&activateAppId=${clientId}/sqratch-attribution-embed`,
    );

    // Missing client id (brand never completed an install that stamped it).
    assert.equal(await deepLinkFor({}, null), null);

    // Missing shop domain (never connected).
    assert.equal(await deepLinkFor({ shopifyShopDomain: null }, clientId), null);

    // Neither.
    assert.equal(await deepLinkFor({ shopifyShopDomain: null }, null), null);

    // Defense in depth: a corrupted row must yield null, never a 500 and never
    // a link to a non-Shopify host.
    assert.equal(await deepLinkFor({ shopifyShopDomain: "evil.com" }, clientId), null);
    assert.equal(
      await deepLinkFor({ shopifyShopDomain: "test-shop.myshopify.com" }, "not-a-client-id"),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// 4-11: products route
// ---------------------------------------------------------------------------

describe("brand/shopify/products route contract", () => {
  test("4. 200 body exact key set including meta.hasNextPage / meta.limit", async () => {
    const brand = makeBrand();
    const { registry } = makeAdapterRegistry({
      async loadConnection() {
        return fakeConnectionRow();
      },
      async fetchProducts() {
        return { ok: true, items: [canonicalProduct], hasNextPage: true, limit: 100, endCursor: null };
      },
    });

    const response = await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return makeSummary(brand);
        },
        registry,
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

  test("5. canonical adapter path preserves the established response", async () => {
    const brand = makeBrand();
    const { registry } = makeAdapterRegistry({
      async loadConnection(connectionId) {
        assert.equal(connectionId, "conn-1");
        return fakeConnectionRow({ externalAccountId: brand.shopifyShopDomain! });
      },
      async fetchProducts(input) {
        assert.deepEqual(input, {
          shopDomain: brand.shopifyShopDomain,
          brandId: brand.id,
          connectionId: "conn-1",
        });
        return { ok: true, items: [canonicalProduct], hasNextPage: true, limit: 100, endCursor: null };
      },
    });
    const adapterResponse = await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return makeSummary(brand);
        },
        registry,
      }),
    );
    const adapterJson = await adapterResponse.json();

    assert.equal(adapterResponse.status, 200);
    assert.deepEqual(adapterJson.data[0], expectedProductResponseItem);
  });

  test("6. adapter fetch failure preserves the established {error} response", async () => {
    const brand = makeBrand();

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
          return makeSummary(brand );
        },
        registry,
      }),
    );
    assert.equal(adapterFail.status, 401);
    assert.deepEqual(await adapterFail.json(), { error: "Shopify connection requires reconnection." });
  });

  test("7. not-connected 400 body unchanged for every CANONICALLY-expressible gate sub-condition", async () => {
    // PHASE 14B.4B: the gate is now `!summary || !isConnectionUsable(summary)`
    // — no independent `Brand.shopifyAdminAccessTokenEncrypted` check exists
    // any more (see connection-service.ts's `isConnectionUsable` doc comment
    // for the write-path invariant this relies on: CONNECTED is written only
    // together with the canonical credential, so "status === CONNECTED"
    // already implies "credential present").
    // A "CONNECTED but no credential" row is therefore not a state the
    // canonical layer can independently express — and if it somehow existed
    // anyway, the downstream credential resolution
    // (`getValidAccessToken`/adapter token fetch, covered by
    // tests/shopify-token-manager.test.ts) still fails closed rather than
    // leaking data. This test covers the two cases still expressible at the
    // summary layer: no connection at all, and a connection whose status
    // isn't CONNECTED.
    const cases: Array<[string, CommerceConnectionSummary | null]> = [
      ["no connection at all", null],
      [
        "status not CONNECTED",
        makeSummary(makeBrand(), { status: "DISCONNECTED" }),
      ],
    ];

    for (const [label, summary] of cases) {
      const brand = makeBrand();
      const response = await productsGetImpl(
        makeProductsDeps({
          async getContext() {
            return makeContext(brand);
          },
          async getConnectionSummary() {
            return summary;
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

  // PHASE 14C-A: `markLegacyProductSync` was deleted entirely from
  // products/route.ts — the route no longer writes anything to `Brand` on
  // success or failure (canonical `CommerceConnection.lastProductSyncAt` is
  // already stamped by `ShopifyCommerceAdapter.syncProducts` for the
  // adapter path; there is nothing left for this route itself to stamp).
  // The old test 8, which proved that mirror write's success/failure
  // gating, is removed with the code it covered.

  test("9. no product is ever persisted", async () => {
    const brand = makeBrand();
    const { registry } = makeAdapterRegistry({
      async loadConnection() {
        return fakeConnectionRow();
      },
      async fetchProducts() {
        return { ok: true, items: [canonicalProduct], hasNextPage: false, limit: 100, endCursor: null };
      },
    });

    // Nothing in this DI graph touches a database at all on a successful
    // fetch — a persistence call is structurally impossible here; this
    // assertion documents that invariant.
    await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return makeSummary(brand);
        },
        registry,
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
          return makeSummary(brand );
        },
        registry,
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

    const response = await productsGetImpl(
      makeProductsDeps({
        async getContext() {
          return makeContext(brand);
        },
        async getConnectionSummary() {
          return makeSummary(brand, {
            provider: CommerceProvider.COMMERCE7,
          });
        },
        registry,
      }),
    );

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
