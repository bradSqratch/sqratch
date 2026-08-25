/**
 * tests/shopify-commerce-adapter.test.ts
 *
 * Unit tests for ShopifyCommerceAdapter
 * (src/lib/commerce/providers/shopify-commerce-adapter.ts), the wrapper
 * that implements the provider-neutral CommerceAdapter interface on top of
 * the existing, production-tested Shopify services.
 *
 * Approach: every dependency the adapter needs (loading a CommerceConnection
 * row, resolving a Shopify access token, fetching products, creating a
 * discount code, and — for most tests — verifying a webhook HMAC) is
 * injected via ShopifyCommerceAdapterDeps. No real DB and no real network
 * call happens anywhere in this file.
 *
 *   - `makeDeps()` returns a fully-stubbed deps object where every method
 *     throws if called unexpectedly, so a test only has to override the
 *     methods it actually exercises — an accidental extra call fails loudly.
 *   - The webhook tests (9-12) inject the REAL `verifyShopifyWebhookHmac`
 *     (imported from `@/lib/shopify`, unmodified) rather than a stub that
 *     always returns true, and compute a genuine HMAC with `node:crypto` —
 *     these are real signature checks, not rubber stamps.
 *   - Test 13 imports `defaultCommerceAdapterRegistry` and only inspects the
 *     resolved adapter's identity/capabilities — it never calls a method
 *     that would touch prisma or the network (see the "lazy defaults" note
 *     in shopify-commerce-adapter.ts), so DATABASE_URL is not required here,
 *     the same reasoning tests/shopify-token-manager.test.ts documents for
 *     shopify-token-manager.ts's lazy `getDb()`.
 *
 * Covered cases (numbered to match the review checklist):
 *  1.  getCapabilities() flags, rewards.revoke:false + no revokeDiscount method
 *  2.  getConnection() known connection -> summary with no credential fields
 *  3.  getConnection() missing id -> NOT_FOUND (not a throw)
 *  4.  getConnection() non-CONNECTED status -> NOT_CONNECTED
 *  5.  syncProducts() delegates + maps products + stamps lastProductSyncAt
 *  6.  syncProducts() missing connection -> CommerceConnectionNotFoundError
 *  7.  createDiscount() field mapping (validDays -> codeValidDays, etc.)
 *  8.  createDiscount() each non-ok token variant -> typed error, no API call
 *  9.  verifyAndParseWebhook() valid HMAC -> correct event (2 topics)
 *  10. verifyAndParseWebhook() invalid HMAC -> throws, no event
 *  11. verifyAndParseWebhook() unknown topic -> typed error
 *  12. verifyAndParseWebhook() case-insensitive header lookup
 *  13. registry integration: SHOPIFY -> ShopifyCommerceAdapter, COMMERCE7 -> throws
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  CommerceProvider,
  type CommerceConnectionStatus,
} from "@prisma/client";

import {
  ShopifyCommerceAdapter,
  type ShopifyCommerceAdapterDeps,
  type ShopifyCommerceConnectionRow,
} from "../src/lib/commerce/providers/shopify-commerce-adapter";
import {
  CommerceConnectionNotFoundError,
  CommerceProviderApiError,
} from "../src/lib/commerce/errors";
import type { CreateDiscountInput } from "../src/lib/commerce/types";
import type { CommerceAdapter } from "../src/lib/commerce/adapter";
import { defaultCommerceAdapterRegistry } from "../src/lib/commerce/default-registry";

import { verifyShopifyWebhookHmac } from "../src/lib/shopify";
import type { NormalizedShopifyProduct } from "../src/lib/shopify-products";
import type { GetValidAccessTokenResult } from "../src/lib/shopify-token-manager";

// ---------------------------------------------------------------------------
// Fakes / helpers
// ---------------------------------------------------------------------------

function makeRow(
  overrides: Partial<ShopifyCommerceConnectionRow> = {},
): ShopifyCommerceConnectionRow {
  return {
    id: "conn-1",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED" as CommerceConnectionStatus,
    displayName: "Test Store",
    externalAccountId: "test-shop.myshopify.com",
    storefrontUrl: "https://test-shop.myshopify.com",
    isPrimary: true,
    grantedScopes: ["read_products", "read_discounts", "write_discounts"],
    installedAt: new Date("2026-01-01T00:00:00Z"),
    uninstalledAt: null,
    lastProductSyncAt: null,
    providerMetadata: { authMode: "LEGACY_OFFLINE", currencyCode: "USD" },
    ...overrides,
  };
}

/**
 * Every method throws by default so a test only needs to override the
 * methods it actually expects to be called — any unexpected call fails
 * the test loudly instead of silently returning a default value.
 */
function makeDeps(
  overrides: Partial<ShopifyCommerceAdapterDeps> = {},
): ShopifyCommerceAdapterDeps {
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
      throw new Error(
        "fetchPublishedProductIds should not be called in this test",
      );
    },
    async createDiscountCode() {
      throw new Error("createDiscountCode should not be called in this test");
    },
    async lookupDiscountByNodeId() {
      throw new Error(
        "lookupDiscountByNodeId should not be called in this test",
      );
    },
    async lookupDiscountByCode() {
      throw new Error("lookupDiscountByCode should not be called in this test");
    },
    verifyWebhookHmac() {
      throw new Error("verifyWebhookHmac should not be called in this test");
    },
    async markProductSync() {
      throw new Error("markProductSync should not be called in this test");
    },
    ...overrides,
  };
}

function makeNormalizedProduct(
  overrides: Partial<NormalizedShopifyProduct> = {},
): NormalizedShopifyProduct {
  return {
    id: "123",
    shopifyProductGid: "gid://shopify/Product/123",
    title: "Test Product",
    handle: "test-product",
    productUrl: "https://test-shop.myshopify.com/products/test-product",
    hasProviderStorefrontPublication: true,
    hasProviderSuppliedStorefrontUrl: true,
    images: ["https://cdn.example.com/img.jpg"],
    imageUrl: "https://cdn.example.com/img.jpg",
    priceRange: { min: 10, max: 10 },
    priceText: "$10.00",
    currency: "USD",
    variantIds: ["456"],
    priceRangeRaw: { min: "10.00", max: "10.00" },
    descriptionText: "A test product.",
    status: "ACTIVE",
    providerCreatedAt: new Date("2026-01-01T00:00:00Z"),
    providerUpdatedAt: new Date("2026-01-02T00:00:00Z"),
    sku: "SKU-123",
    ...overrides,
  };
}

const sampleDiscountInput: CreateDiscountInput = {
  code: "REWARD10",
  title: "10% off",
  issuedAt: new Date("2026-03-01T00:00:00Z"),
  validDays: 30,
  discountType: "PERCENTAGE",
  discountAmountCents: null,
  discountPercentageBasisPoints: 1000,
  appliesTo: "SPECIFIC_PRODUCTS",
  externalProductIds: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
  minimumSubtotalCents: 5000,
};

/** Runs `fn` with `process.env.SHOPIFY_API_SECRET` set, always restoring it afterwards. */
async function withShopifyApiSecret<T>(
  secret: string,
  fn: () => Promise<T>,
): Promise<T> {
  const original = process.env.SHOPIFY_API_SECRET;
  process.env.SHOPIFY_API_SECRET = secret;
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.SHOPIFY_API_SECRET;
    } else {
      process.env.SHOPIFY_API_SECRET = original;
    }
  }
}

function computeHmac(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ShopifyCommerceAdapter", () => {
  test("1. getCapabilities returns exactly the expected flags; rewards.revoke is false and revokeDiscount is undefined", () => {
    // Typed as the CommerceAdapter interface (not the concrete class) so
    // that the optional `revokeDiscount` member is visible for the
    // feature-detection check below, exactly as a real caller would see it.
    const adapter: CommerceAdapter = new ShopifyCommerceAdapter(makeDeps());
    const capabilities = adapter.getCapabilities();

    assert.deepEqual(capabilities, {
      products: { sync: true, publicDestinations: true },
      rewards: {
        create: true,
        lookup: true,
        usageLookup: true,
        revoke: false,
        fixedAmount: true,
        percentage: true,
        minimumSubtotal: true,
        productSpecific: true,
        singleUse: true,
      },
    });
    assert.equal(capabilities.rewards.revoke, false);
    assert.equal(adapter.revokeDiscount, undefined);
  });

  test("2. getConnection on a known connection returns a correct summary with no credential fields", async () => {
    const row = makeRow({
      grantedScopes: "read_products, read_discounts,write_discounts",
    });
    const deps = makeDeps({
      async loadConnection(connectionId) {
        assert.equal(connectionId, "conn-1");
        return row;
      },
    });

    const adapter = new ShopifyCommerceAdapter(deps);
    const result = await adapter.getConnection("conn-1");

    assert.ok(result.ok, "expected ok:true");
    assert.deepEqual(result.connection, {
      id: "conn-1",
      brandId: "brand-1",
      provider: CommerceProvider.SHOPIFY,
      status: "CONNECTED",
      displayName: "Test Store",
      externalAccountId: "test-shop.myshopify.com",
      storefrontUrl: "https://test-shop.myshopify.com",
      isPrimary: true,
      grantedScopes: ["read_products", "read_discounts", "write_discounts"],
      installedAt: row.installedAt,
      uninstalledAt: null,
      lastProductSyncAt: null,
      currencyCode: "USD",
    });

    const serialized = JSON.stringify(result.connection);
    assert.doesNotMatch(
      serialized,
      /token|secret|encrypted|password/i,
      "connection summary must never serialize credential-shaped fields",
    );
  });

  test("3. getConnection on a missing id returns the NOT_FOUND variant rather than throwing", async () => {
    const deps = makeDeps({
      async loadConnection() {
        return null;
      },
    });
    const adapter = new ShopifyCommerceAdapter(deps);

    const result = await adapter.getConnection("missing-id");
    assert.deepEqual(result, { ok: false, reason: "NOT_FOUND" });
  });

  test("4. getConnection on a disconnected/uninstalled connection returns NOT_CONNECTED", async () => {
    const uninstalledRow = makeRow({
      status: "UNINSTALLED" as CommerceConnectionStatus,
      uninstalledAt: new Date("2026-02-01T00:00:00Z"),
    });
    const adapter1 = new ShopifyCommerceAdapter(
      makeDeps({
        async loadConnection() {
          return uninstalledRow;
        },
      }),
    );
    assert.deepEqual(await adapter1.getConnection("conn-1"), {
      ok: false,
      reason: "NOT_CONNECTED",
    });

    const disconnectedRow = makeRow({
      status: "DISCONNECTED" as CommerceConnectionStatus,
    });
    const adapter2 = new ShopifyCommerceAdapter(
      makeDeps({
        async loadConnection() {
          return disconnectedRow;
        },
      }),
    );
    assert.deepEqual(await adapter2.getConnection("conn-1"), {
      ok: false,
      reason: "NOT_CONNECTED",
    });
  });

  test("5b. syncProducts maps provider storefront-publication evidence through unchanged", async () => {
    const deps = makeDeps({
      async loadConnection() {
        return makeRow();
      },
      async fetchProducts() {
        return {
          ok: true,
          items: [
            makeNormalizedProduct({
              status: "ACTIVE",
              hasProviderStorefrontPublication: false,
            }),
          ],
          hasNextPage: false,
          limit: 100,
          endCursor: null,
        };
      },
      async markProductSync() {},
    });

    const result = await new ShopifyCommerceAdapter(deps).syncProducts(
      "conn-1",
    );
    const product = result.products[0];
    assert.equal(product.status, "ACTIVE");
    assert.equal(product.hasProviderStorefrontPublication, false);
  });

  test("5. syncProducts delegates to the injected fetcher with brandId + shop domain, maps products, stamps lastProductSyncAt", async () => {
    const row = makeRow();
    const normalizedProduct = makeNormalizedProduct();
    // Captured-call state is boxed in an object property rather than a
    // reassigned `let` — TS's control-flow narrowing cannot see assignments
    // made inside a nested async callback as reachable at the read site
    // below, which would otherwise narrow a `T | null` local to `never`
    // after the truthiness check.
    const calls: {
      fetchProductsInput: unknown;
      markProductSync: { connectionId: string; syncedAt: Date } | null;
    } = { fetchProductsInput: null, markProductSync: null };

    const deps = makeDeps({
      async loadConnection(connectionId) {
        assert.equal(connectionId, "conn-1");
        return row;
      },
      async fetchProducts(input) {
        calls.fetchProductsInput = input;
        return {
          ok: true,
          items: [normalizedProduct],
          hasNextPage: true,
          limit: 100,
          endCursor: "cursor-abc",
        };
      },
      async markProductSync(connectionId, syncedAt) {
        calls.markProductSync = { connectionId, syncedAt };
      },
    });

    const adapter = new ShopifyCommerceAdapter(deps);
    const result = await adapter.syncProducts("conn-1");

    assert.deepEqual(calls.fetchProductsInput, {
      shopDomain: "test-shop.myshopify.com",
      brandId: "brand-1",
      connectionId: "conn-1",
    });

    assert.equal(result.connectionId, "conn-1");
    assert.equal(result.provider, CommerceProvider.SHOPIFY);
    assert.equal(result.productCount, 1);
    // ProductSyncResult's widened pagination fields pass through unchanged
    // from fetchNormalizedShopifyProducts's own ok:true result.
    assert.equal(result.hasNextPage, true);
    assert.equal(result.limit, 100);

    const product = result.products[0];
    assert.equal(product.externalId, "gid://shopify/Product/123");
    assert.equal(product.title, "Test Product");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(product, "shopifyProductGid"),
      "neutral product must not carry the shopifyProductGid key",
    );
    assert.ok(
      !Object.prototype.hasOwnProperty.call(product, "variantIds"),
      "neutral product must not carry the Shopify-named variantIds key",
    );
    // Widened fields: priceRange mirrors NormalizedShopifyProduct.priceRange
    // exactly, and externalVariantIds mirrors variantIds exactly.
    assert.deepEqual(product.priceRange, { min: 10, max: 10 });
    assert.deepEqual(product.externalVariantIds, ["456"]);
    // New optional additive fields (Task 4) map through unchanged.
    assert.equal(product.descriptionText, "A test product.");
    assert.equal(product.sku, "SKU-123");
    assert.equal(product.status, "ACTIVE");
    assert.deepEqual(
      product.providerCreatedAt,
      new Date("2026-01-01T00:00:00Z"),
    );
    assert.deepEqual(
      product.providerUpdatedAt,
      new Date("2026-01-02T00:00:00Z"),
    );
    assert.deepEqual(product.priceRangeRaw, { min: "10.00", max: "10.00" });
    // The provider storefront-URL fact maps through verbatim and is never
    // inferred from status or from productUrl.
    assert.equal(product.hasProviderStorefrontPublication, true);

    assert.ok(calls.markProductSync, "markProductSync should have been called");
    assert.equal(calls.markProductSync.connectionId, "conn-1");
    assert.equal(calls.markProductSync.syncedAt, result.syncedAt);
  });

  test("6. syncProducts on a missing connection throws CommerceConnectionNotFoundError", async () => {
    const deps = makeDeps({
      async loadConnection() {
        return null;
      },
    });
    const adapter = new ShopifyCommerceAdapter(deps);

    await assert.rejects(
      () => adapter.syncProducts("missing-id"),
      (error: unknown) => {
        assert.ok(error instanceof CommerceConnectionNotFoundError);
        assert.equal(error.connectionId, "missing-id");
        return true;
      },
    );
  });

  test("6d. X/Y product requests preserve the exact connection id and account", async () => {
    const rows = new Map([
      ["shopify-X", makeRow({ id: "shopify-X", externalAccountId: "x.myshopify.com" })],
      ["shopify-Y", makeRow({ id: "shopify-Y", externalAccountId: "y.myshopify.com" })],
    ]);
    const inputs: unknown[] = [];
    const adapter = new ShopifyCommerceAdapter(
      makeDeps({
        async loadConnection(connectionId) {
          return rows.get(connectionId) ?? null;
        },
        async fetchProducts(input) {
          inputs.push(input);
          return { ok: true, items: [], hasNextPage: false, endCursor: null, limit: 100 };
        },
        async markProductSync() {},
      }),
    );

    await adapter.syncProducts("shopify-X");
    await adapter.syncProducts("shopify-Y");

    assert.deepEqual(inputs, [
      { brandId: "brand-1", connectionId: "shopify-X", shopDomain: "x.myshopify.com" },
      { brandId: "brand-1", connectionId: "shopify-Y", shopDomain: "y.myshopify.com" },
    ]);
  });

  test("6e. a Commerce7 connection id fails closed before Shopify product I/O", async () => {
    let fetchCalls = 0;
    const adapter = new ShopifyCommerceAdapter(
      makeDeps({
        async loadConnection() {
          return makeRow({
            id: "commerce7-connection",
            provider: CommerceProvider.COMMERCE7,
            externalAccountId: "commerce7-tenant",
          });
        },
        async fetchProducts() {
          fetchCalls += 1;
          throw new Error("Shopify product transport must not run");
        },
      }),
    );

    await assert.rejects(
      () => adapter.syncProducts("commerce7-connection"),
      (error: unknown) => error instanceof CommerceConnectionNotFoundError,
    );
    assert.equal(fetchCalls, 0);
  });

  test("6a. fetchProductPage maps Shopify cursor state to the neutral page contract without stamping completion", async () => {
    const row = makeRow();
    const product = makeNormalizedProduct();
    const calls: { captured: Record<string, unknown> | null } = {
      captured: null,
    };
    const publishedProductIds = new Set(["123"]);
    let stampCount = 0;
    const adapter = new ShopifyCommerceAdapter(
      makeDeps({
        async loadConnection() {
          return row;
        },
        async fetchPublishedProductIds(input) {
          assert.equal(input.shopDomain, "test-shop.myshopify.com");
          assert.equal(input.brandId, "brand-1");
          return {
            ok: true,
            productIds: publishedProductIds,
            pagesFetched: 1,
            limit: 25,
          };
        },
        async fetchProducts(input) {
          calls.captured = input;
          return {
            ok: true,
            items: [product],
            hasNextPage: true,
            endCursor: "opaque-next-cursor",
            limit: 25,
          };
        },
        async markProductSync() {
          stampCount += 1;
        },
      }),
    );

    const syncContext = await adapter.prepareProductSync("conn-1", {
      limit: 25,
    });
    const page = await adapter.fetchProductPage("conn-1", {
      cursor: "opaque-current-cursor",
      limit: 25,
      syncContext,
    });

    assert.ok(calls.captured);
    assert.equal(calls.captured.shopDomain, "test-shop.myshopify.com");
    assert.equal(calls.captured.brandId, "brand-1");
    assert.equal(calls.captured.after, "opaque-current-cursor");
    assert.equal(calls.captured.limit, 25);
    assert.equal(calls.captured.publishedProductIds, publishedProductIds);
    assert.equal(page.isComplete, false);
    assert.equal(page.nextCursor, "opaque-next-cursor");
    assert.equal(page.products[0]?.externalId, product.shopifyProductGid);
    assert.equal(stampCount, 0);

    await adapter.completeProductSync("conn-1", page.fetchedAt);
    assert.equal(stampCount, 1);
  });

  test("6aa. fetchProductPage fails closed when no complete publication context was prepared", async () => {
    const adapter = new ShopifyCommerceAdapter(
      makeDeps({
        async loadConnection() {
          return makeRow();
        },
      }),
    );

    await assert.rejects(
      () => adapter.fetchProductPage("conn-1", { limit: 100 }),
      (error: unknown) => error instanceof CommerceProviderApiError,
    );
  });

  test("6b. fetchProductPage ignores Shopify's final-edge cursor on a complete page", async () => {
    const row = makeRow();
    const adapter = new ShopifyCommerceAdapter(
      makeDeps({
        async loadConnection() {
          return row;
        },
        async fetchProducts() {
          return {
            ok: true,
            items: [makeNormalizedProduct()],
            hasNextPage: false,
            endCursor: "final-edge-cursor",
            limit: 100,
          };
        },
      }),
    );

    const page = await adapter.fetchProductPage("conn-1", {
      limit: 100,
      syncContext: { publishedProductIds: new Set(["123"]) },
    });

    assert.equal(page.isComplete, true);
    assert.equal(page.nextCursor, null);
  });

  test("6c. empty and null-cursor final Shopify pages are complete, while a non-final page without a cursor stays incomplete", async () => {
    const row = makeRow();
    const results = [
      {
        ok: true as const,
        items: [],
        hasNextPage: false,
        endCursor: null,
        limit: 100,
      },
      {
        ok: true as const,
        items: [],
        hasNextPage: true,
        endCursor: null,
        limit: 100,
      },
    ];
    let index = 0;
    const adapter = new ShopifyCommerceAdapter(
      makeDeps({
        async loadConnection() {
          return row;
        },
        async fetchProducts() {
          return results[index++];
        },
      }),
    );

    const finalPage = await adapter.fetchProductPage("conn-1", {
      limit: 100,
      syncContext: { publishedProductIds: new Set() },
    });
    assert.deepEqual(finalPage.products, []);
    assert.equal(finalPage.isComplete, true);
    assert.equal(finalPage.nextCursor, null);

    const incompletePage = await adapter.fetchProductPage("conn-1", {
      limit: 100,
      syncContext: { publishedProductIds: new Set() },
    });
    assert.equal(incompletePage.isComplete, false);
    assert.equal(incompletePage.nextCursor, null);
  });

  test("7. createDiscount maps CreateDiscountInput fields onto createShopifyRewardDiscountCode's input exactly", async () => {
    const row = makeRow();
    let createDiscountCodeCalledWith: unknown = null;

    const deps = makeDeps({
      async loadConnection() {
        return row;
      },
      async getAccessToken(brandId) {
        assert.equal(brandId, "brand-1");
        return { ok: true, accessToken: "shpat_test_token" };
      },
      async createDiscountCode(input) {
        createDiscountCodeCalledWith = input;
        return {
          ok: true,
          discountNodeId: "gid://shopify/DiscountCodeNode/1",
          code: "REWARD10",
          startsAt: sampleDiscountInput.issuedAt,
          endsAt: new Date("2026-03-31T00:00:00Z"),
          userErrors: [],
        };
      },
    });

    const adapter = new ShopifyCommerceAdapter(deps);
    const result = await adapter.createDiscount("conn-1", sampleDiscountInput);

    assert.deepEqual(createDiscountCodeCalledWith, {
      shopDomain: "test-shop.myshopify.com",
      accessToken: "shpat_test_token",
      title: "10% off",
      code: "REWARD10",
      issuedAt: sampleDiscountInput.issuedAt,
      codeValidDays: 30,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      appliesTo: "SPECIFIC_PRODUCTS",
      shopifyProductGids: [
        "gid://shopify/Product/1",
        "gid://shopify/Product/2",
      ],
      minimumSubtotalCents: 5000,
    });

    assert.equal(result.externalDiscountId, "gid://shopify/DiscountCodeNode/1");
    assert.equal(result.code, "REWARD10");
    assert.deepEqual(result.expiresAt, new Date("2026-03-31T00:00:00Z"));
  });

  test("8. createDiscount: each non-ok token result yields a typed error and never calls createDiscountCode", async () => {
    const row = makeRow();
    const nonOkResults: Extract<GetValidAccessTokenResult, { ok: false }>[] = [
      { ok: false, reason: "NEEDS_RECONNECT" },
      { ok: false, reason: "NOT_CONNECTED" },
    ];

    for (const tokenResult of nonOkResults) {
      let createDiscountCodeCalled = false;
      const deps = makeDeps({
        async loadConnection() {
          return row;
        },
        async getAccessToken() {
          return tokenResult;
        },
        async createDiscountCode() {
          createDiscountCodeCalled = true;
          throw new Error(
            "createDiscountCode must not be called when the token lookup fails",
          );
        },
      });

      const adapter = new ShopifyCommerceAdapter(deps);

      await assert.rejects(
        () => adapter.createDiscount("conn-1", sampleDiscountInput),
        (error: unknown) => {
          assert.ok(error instanceof CommerceProviderApiError);
          return true;
        },
        `expected a typed error for token reason ${tokenResult.reason}`,
      );
      assert.equal(createDiscountCodeCalled, false);
    }
  });

  test("8a. getDiscount binds the token and Shopify lookup to the exact connection", async () => {
    const row = makeRow({
      id: "connection-x",
      externalAccountId: "x.myshopify.com",
    });
    let tokenOptions: unknown;
    let lookupInput: unknown;
    const adapter = new ShopifyCommerceAdapter(
      makeDeps({
        async loadConnection(connectionId) {
          return connectionId === "connection-x" ? row : null;
        },
        async getAccessToken(_brandId, options) {
          tokenOptions = options;
          return { ok: true, accessToken: "token-x" };
        },
        async lookupDiscountByNodeId(input) {
          lookupInput = input;
          return {
            ok: true,
            status: "ACTIVE",
            asyncUsageCount: 2,
            usageLimit: 1,
            endsAt: new Date("2026-03-31T00:00:00.000Z"),
            derivedStatus: "ISSUED",
          };
        },
      }),
    );

    const result = await adapter.getDiscount("connection-x", {
      externalDiscountId: "gid://shopify/DiscountCodeNode/x",
    });

    assert.deepEqual(tokenOptions, {
      connectionId: "connection-x",
      expectedExternalAccountId: "x.myshopify.com",
    });
    assert.deepEqual(lookupInput, {
      shopDomain: "x.myshopify.com",
      accessToken: "token-x",
      discountNodeId: "gid://shopify/DiscountCodeNode/x",
    });
    assert.deepEqual(result, {
      exists: true,
      externalDiscountId: "gid://shopify/DiscountCodeNode/x",
      externalStatus: "ACTIVE",
      usageCount: 2,
      expiresAt: new Date("2026-03-31T00:00:00.000Z"),
    });
  });

  test("9. verifyAndParseWebhook with a valid HMAC returns the right normalized event (app/uninstalled and a GDPR topic)", async () => {
    const secret = "test-webhook-secret-9";
    const rawBody = JSON.stringify({ id: 12345 });
    const hmac = computeHmac(rawBody, secret);
    const adapter = new ShopifyCommerceAdapter(
      makeDeps({ verifyWebhookHmac: verifyShopifyWebhookHmac }),
    );

    await withShopifyApiSecret(secret, async () => {
      const uninstalledEvent = await adapter.verifyAndParseWebhook("conn-1", {
        rawBody,
        headers: {
          "X-Shopify-Hmac-Sha256": hmac,
          "X-Shopify-Topic": "app/uninstalled",
          "X-Shopify-Shop-Domain": "Test-Shop.MyShopify.com",
        },
      });
      assert.equal(uninstalledEvent.type, "APP_UNINSTALLED");
      assert.equal(uninstalledEvent.provider, CommerceProvider.SHOPIFY);
      assert.equal(
        uninstalledEvent.externalAccountId,
        "test-shop.myshopify.com",
      );
      assert.deepEqual(uninstalledEvent.payload, { id: 12345 });

      const redactEvent = await adapter.verifyAndParseWebhook("conn-1", {
        rawBody,
        headers: {
          "x-shopify-hmac-sha256": hmac,
          "x-shopify-topic": "customers/redact",
          "x-shopify-shop-domain": "test-shop.myshopify.com",
        },
      });
      assert.equal(redactEvent.type, "CUSTOMER_REDACT");
    });
  });

  test("10. verifyAndParseWebhook with an invalid HMAC throws and never returns an event", async () => {
    const secret = "test-webhook-secret-10";
    const rawBody = JSON.stringify({ id: 1 });
    const adapter = new ShopifyCommerceAdapter(
      makeDeps({ verifyWebhookHmac: verifyShopifyWebhookHmac }),
    );

    await withShopifyApiSecret(secret, async () => {
      await assert.rejects(
        () =>
          adapter.verifyAndParseWebhook("conn-1", {
            rawBody,
            headers: {
              "x-shopify-hmac-sha256": "not-a-real-hmac",
              "x-shopify-topic": "app/uninstalled",
              "x-shopify-shop-domain": "test-shop.myshopify.com",
            },
          }),
        (error: unknown) => {
          assert.ok(error instanceof CommerceProviderApiError);
          assert.match(error.message, /signature/i);
          return true;
        },
      );
    });
  });

  test("11. verifyAndParseWebhook with an unknown topic throws a typed commerce error", async () => {
    const secret = "test-webhook-secret-11";
    const rawBody = JSON.stringify({ id: 1 });
    const hmac = computeHmac(rawBody, secret);
    const adapter = new ShopifyCommerceAdapter(
      makeDeps({ verifyWebhookHmac: verifyShopifyWebhookHmac }),
    );

    await withShopifyApiSecret(secret, async () => {
      await assert.rejects(
        () =>
          adapter.verifyAndParseWebhook("conn-1", {
            rawBody,
            headers: {
              "x-shopify-hmac-sha256": hmac,
              "x-shopify-topic": "orders/create",
              "x-shopify-shop-domain": "test-shop.myshopify.com",
            },
          }),
        (error: unknown) => {
          assert.ok(error instanceof CommerceProviderApiError);
          return true;
        },
      );
    });
  });

  test("12. verifyAndParseWebhook header lookup is case-insensitive", async () => {
    const secret = "test-webhook-secret-12";
    const rawBody = JSON.stringify({ ok: true });
    const hmac = computeHmac(rawBody, secret);
    const adapter = new ShopifyCommerceAdapter(
      makeDeps({ verifyWebhookHmac: verifyShopifyWebhookHmac }),
    );

    await withShopifyApiSecret(secret, async () => {
      const event = await adapter.verifyAndParseWebhook("conn-1", {
        rawBody,
        headers: {
          "X-SHOPIFY-HMAC-SHA256": hmac,
          "x-Shopify-TOPIC": "shop/redact",
          "X-shopify-shop-domain": "CASE-TEST.myshopify.com",
        },
      });
      assert.equal(event.type, "ACCOUNT_REDACT");
      assert.equal(event.externalAccountId, "case-test.myshopify.com");
    });
  });

  test("13. the default registry resolves each provider to its own adapter, and Shopify capabilities are unchanged", () => {
    const shopifyAdapter = defaultCommerceAdapterRegistry.get(
      CommerceProvider.SHOPIFY,
    );
    assert.ok(shopifyAdapter instanceof ShopifyCommerceAdapter);
    assert.equal(shopifyAdapter.provider, CommerceProvider.SHOPIFY);
    assert.deepEqual(shopifyAdapter.getCapabilities(), {
      products: { sync: true, publicDestinations: true },
      rewards: {
        create: true,
        lookup: true,
        usageLookup: true,
        revoke: false,
        fixedAmount: true,
        percentage: true,
        minimumSubtotal: true,
        productSpecific: true,
        singleUse: true,
      },
    });

    // PHASE 16C1: COMMERCE7 is now registered (read-only catalog). It must
    // resolve to its OWN adapter — never to the Shopify one — and must not
    // have acquired any Shopify capability by being registered alongside it.
    const commerce7Adapter = defaultCommerceAdapterRegistry.get(
      CommerceProvider.COMMERCE7,
    );
    assert.equal(commerce7Adapter.provider, CommerceProvider.COMMERCE7);
    assert.ok(!(commerce7Adapter instanceof ShopifyCommerceAdapter));
    assert.notEqual(commerce7Adapter, shopifyAdapter);
    // PHASE 16 BIG ROUND / SUBPHASE 2: publicDestinations is now true — a
    // merchant-configured connection can produce a real, host-pinned
    // public product destination. See
    // tests/commerce7-storefront-public-destinations.test.ts.
    assert.deepEqual(commerce7Adapter.getCapabilities(), {
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
    });
  });
});
