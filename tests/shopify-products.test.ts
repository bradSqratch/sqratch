process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY = "test_shopify_api_key";
process.env.SHOPIFY_API_SECRET = "test_shopify_api_secret";
process.env.APP_ENCRYPTION_KEY = "test-encryption-key-for-shopify-products-tests";
process.env.NEXTAUTH_SECRET = "test-secret-for-shopify-products-tests-32ch";

/**
 * tests/shopify-products.test.ts
 *
 * Unit tests for src/lib/shopify-products.ts, covering the two things the
 * interrupted workstream added:
 *   1. The additive GraphQL fields (description, status, createdAt,
 *      updatedAt, variants[].sku) being parsed correctly out of a mocked
 *      Admin GraphQL response into NormalizedShopifyProduct.
 *   2. Cursor pagination (`after` on fetchNormalizedShopifyProducts,
 *      `endCursor` in its result, and fetchAllNormalizedShopifyProducts'
 *      multi-page loop) following `pageInfo.endCursor` and respecting the
 *      `maxPages` bound.
 *
 * Approach — no real DB, no real network:
 *   - `global.fetch` is replaced with an in-memory fake that returns
 *     canned GraphQL JSON bodies, keyed off the `after` variable in the
 *     request body so a test can hand back different pages.
 *   - `getValidAccessToken` (called internally, not injectable) resolves
 *     for a fake brand by having `prisma.brand.findUnique` — reached via
 *     shopify-token-manager's lazy `getDb()` — replaced with a stub
 *     returning a LEGACY_OFFLINE brand row, exactly like the
 *     "getValidAccessToken → mirror orchestration" tests in
 *     tests/shopify-token-manager.test.ts (`prismaModule.brand = {...}`).
 *     LEGACY_OFFLINE is deliberately chosen because it returns the
 *     decrypted token after a single `reloadBrand` read, with no lock/CAS/
 *     mirror logic to also fake.
 */

import { before, beforeEach, after as afterAll, test, describe } from "node:test";
import assert from "node:assert/strict";

import { encryptSecret } from "../src/lib/crypto";
import {
  fetchNormalizedShopifyProducts,
  fetchPublishedShopifyProductIds,
  fetchAllNormalizedShopifyProducts,
  type NormalizedShopifyProduct,
} from "../src/lib/shopify-products";

// ---------------------------------------------------------------------------
// Fake prisma.brand — makes getValidAccessToken resolve without a real DB.
// ---------------------------------------------------------------------------

const FAKE_BRAND_ID = "brand-products-test-1";
const FAKE_SHOP_DOMAIN = "products-test-shop.myshopify.com";
const FAKE_ACCESS_TOKEN = "shpat_products_test_token";

let originalBrandDelegate: unknown;
let originalCommerceConnectionDelegate: unknown;

before(async () => {
  const prismaModule = (await import("../src/lib/prisma")).default as unknown as {
    brand: Record<string, unknown>;
    commerceConnection: Record<string, unknown>;
  };
  // PHASE 14B: `getValidAccessToken` resolves the CANONICAL credential first
  // (`CommerceConnection` -> `CommerceConnectionSecret`), so this harness
  // models the canonical row rather than only the legacy `Brand` mirror. The
  // `Brand` fake below is retained deliberately: it holds the SAME token, so
  // any regression that starts reading it instead still yields a working
  // fetch, while the canonical row proves this suite runs on the real
  // authority path.
  originalCommerceConnectionDelegate = prismaModule.commerceConnection;
  prismaModule.commerceConnection = {
    async findFirst() {
      return {
        id: "conn-products-test-1",
        brandId: FAKE_BRAND_ID,
        status: "CONNECTED",
        externalAccountId: FAKE_SHOP_DOMAIN,
        providerClientId: "client_products_test",
        grantedScopes: ["read_products", "read_discounts", "write_discounts"],
        secret: {
          encryptedPayload: encryptSecret(
            JSON.stringify({
              accessToken: FAKE_ACCESS_TOKEN,
              accessTokenExpiresAt: null,
              refreshToken: null,
              refreshTokenExpiresAt: null,
              authMode: "LEGACY_OFFLINE",
            }),
          ),
        },
      };
    },
  };
  originalBrandDelegate = prismaModule.brand;
  prismaModule.brand = {
    async findUnique() {
      return {
        id: FAKE_BRAND_ID,
        shopifyShopDomain: FAKE_SHOP_DOMAIN,
        shopifyAdminAccessTokenEncrypted: encryptSecret(FAKE_ACCESS_TOKEN),
        shopifyConnectionStatus: "CONNECTED",
        shopifyAuthMode: "LEGACY_OFFLINE",
        shopifyAccessTokenExpiresAt: null,
        shopifyRefreshTokenEncrypted: null,
        shopifyRefreshTokenExpiresAt: null,
        shopifyGrantedScopes: "read_products,read_discounts,write_discounts",
        shopifyClientId: "client_products_test",
        shopifyTokenRefreshLockedUntil: null,
        shopifyTokenRefreshLockId: null,
        shopifyCurrencyCode: "USD",
      };
    },
  };
});

afterAll(async () => {
  const prismaModule = (await import("../src/lib/prisma")).default as unknown as {
    brand: unknown;
    commerceConnection: unknown;
  };
  prismaModule.brand = originalBrandDelegate;
  prismaModule.commerceConnection = originalCommerceConnectionDelegate;
});

// ---------------------------------------------------------------------------
// Fake fetch — returns a page of Shopify GraphQL products JSON, selected by
// the `after` cursor in the request body.
// ---------------------------------------------------------------------------

type FakePage = {
  nodes: Array<Record<string, unknown>>;
  hasNextPage: boolean;
  endCursor: string | null;
};

type FakePublishedPage = {
  nodes: Array<{ id?: string | number | null }>;
  hasNextPage: boolean;
  endCursor: string | null;
};

let pagesByCursor: Map<string | null, FakePage>;
let publishedPagesByCursor: Map<string | null, FakePublishedPage>;
let fetchCallCount = 0;
let lastFetchBody: { variables?: { first?: number; after?: string | null } } | null = null;

let originalFetch: typeof globalThis.fetch;

before(() => {
  originalFetch = globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  fetchCallCount = 0;
  lastFetchBody = null;
  pagesByCursor = new Map();
  publishedPagesByCursor = new Map();

  globalThis.fetch = (async (
    _url: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    fetchCallCount += 1;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    lastFetchBody = body;
    const after: string | null = body?.variables?.after ?? null;

    const isPublicationQuery = String(body?.query ?? "").includes("SqratchPublishedOnlineStoreProducts");
    const page = isPublicationQuery
      ? publishedPagesByCursor.get(after)
      : pagesByCursor.get(after);
    if (!page) {
      throw new Error(`No fake page registered for cursor ${String(after)}`);
    }

    const responseBody = {
      data: {
        products: {
          nodes: page.nodes,
          pageInfo: {
            hasNextPage: page.hasNextPage,
            endCursor: page.endCursor,
          },
        },
      },
    };

    return {
      ok: true,
      status: 200,
      json: async () => responseBody,
    } as Response;
  }) as typeof globalThis.fetch;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rawProductNode(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id: "gid://shopify/Product/1",
    title: "Full Field Product",
    handle: "full-field-product",
    onlineStoreUrl: null,
    description: "A richly-described product.",
    status: "ACTIVE",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-15T12:30:00Z",
    featuredImage: { url: "https://cdn.example.com/featured.jpg" },
    images: { nodes: [{ url: "https://cdn.example.com/extra.jpg" }] },
    variants: {
      nodes: [
        { id: "gid://shopify/ProductVariant/1", price: "19.99", sku: "SKU-A" },
        { id: "gid://shopify/ProductVariant/2", price: "29.99", sku: "" },
      ],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. New GraphQL fields are parsed from a mocked response
// ---------------------------------------------------------------------------

describe("fetchNormalizedShopifyProducts — new GraphQL field parsing", () => {
  test("parses description, status, createdAt, updatedAt, and variant sku into NormalizedShopifyProduct", async () => {
    pagesByCursor.set(null, {
      nodes: [rawProductNode()],
      hasNextPage: false,
      endCursor: "final-edge-cursor",
    });

    const result = await fetchNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    assert.equal(result.items.length, 1);
    const product: NormalizedShopifyProduct = result.items[0];

    assert.equal(product.descriptionText, "A richly-described product.");
    assert.equal(product.status, "ACTIVE");
    assert.equal(product.hasProviderSuppliedStorefrontUrl, false);
    assert.deepEqual(product.providerCreatedAt, new Date("2026-01-01T00:00:00Z"));
    assert.deepEqual(product.providerUpdatedAt, new Date("2026-01-15T12:30:00Z"));
    // First non-empty variant sku, in variant order — the second variant's
    // empty string sku is skipped.
    assert.equal(product.sku, "SKU-A");
    assert.deepEqual(product.priceRangeRaw, { min: "19.99", max: "29.99" });
    // Shopify may provide an endCursor for the final returned edge. The
    // low-level page helper preserves raw provider page information; the
    // commerce adapter decides whether the cursor is actionable.
    assert.equal(result.endCursor, "final-edge-cursor");
    assert.equal(result.hasNextPage, false);
  });

  test("missing/unparseable createdAt, updatedAt, description, status, and sku normalize to null, never throwing", async () => {
    pagesByCursor.set(null, {
      nodes: [
        rawProductNode({
          description: null,
          status: null,
          createdAt: "not-a-real-date",
          updatedAt: undefined,
          variants: { nodes: [{ id: "v1", price: "5.00", sku: null }] },
        }),
      ],
      hasNextPage: false,
      endCursor: null,
    });

    const result = await fetchNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const product = result.items[0];
    assert.equal(product.descriptionText, null);
    assert.equal(product.status, null);
    assert.equal(product.providerCreatedAt, null);
    assert.equal(product.providerUpdatedAt, null);
    assert.equal(product.sku, null);
  });

  test("a password-protected development store can have onlineStoreUrl:null while the published-product set authorizes storefront use", async () => {
    pagesByCursor.set(null, {
      nodes: [rawProductNode({ onlineStoreUrl: null })],
      hasNextPage: false,
      endCursor: null,
    });

    const result = await fetchNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      publishedProductIds: new Set(["gid://shopify/Product/1"]),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const product = result.items[0];
    // The fallback is navigation data only; the independently-complete
    // publication set is the authorization evidence.
    assert.equal(
      product.productUrl,
      `https://${FAKE_SHOP_DOMAIN}/products/full-field-product`,
    );
    assert.equal(product.hasProviderStorefrontPublication, true);
    assert.equal(product.hasProviderSuppliedStorefrontUrl, false);
  });

  test("an ACTIVE Hidden-Snowboard-equivalent remains unpublished when absent from the provider publication set", async () => {
    pagesByCursor.set(null, {
      nodes: [rawProductNode({ onlineStoreUrl: "" })],
      hasNextPage: false,
      endCursor: null,
    });

    const result = await fetchNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      publishedProductIds: new Set(),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.items[0].status, "ACTIVE");
    assert.equal(result.items[0].hasProviderStorefrontPublication, false);
  });

  test("a whitespace-only onlineStoreUrl uses the canonical fallback but cannot create publication evidence", async () => {
    pagesByCursor.set(null, {
      nodes: [rawProductNode({ onlineStoreUrl: "   " })],
      hasNextPage: false,
      endCursor: null,
    });

    const result = await fetchNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      publishedProductIds: new Set(),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.items[0].hasProviderStorefrontPublication, false);
    assert.equal(
      result.items[0].productUrl,
      `https://${FAKE_SHOP_DOMAIN}/products/full-field-product`,
    );
  });

  test("a production-like published product keeps Shopify's actual onlineStoreUrl", async () => {
    pagesByCursor.set(null, {
      nodes: [
        rawProductNode({
          onlineStoreUrl: "https://shop.example.com/products/full-field-product",
        }),
      ],
      hasNextPage: false,
      endCursor: null,
    });

    const result = await fetchNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      publishedProductIds: new Set(["gid://shopify/Product/1"]),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;

    const product = result.items[0];
    assert.equal(
      product.productUrl,
      "https://shop.example.com/products/full-field-product",
    );
    assert.equal(product.hasProviderStorefrontPublication, true);
    assert.equal(product.hasProviderSuppliedStorefrontUrl, true);
  });

  test("a draft product is never made available by a handle or publication membership", async () => {
    pagesByCursor.set(null, {
      nodes: [rawProductNode({ status: "DRAFT", onlineStoreUrl: null })],
      hasNextPage: false,
      endCursor: null,
    });

    const result = await fetchNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      publishedProductIds: new Set(["gid://shopify/Product/1"]),
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.items[0].status, "DRAFT");
    assert.equal(result.items[0].hasProviderStorefrontPublication, true);
  });

  test("the request body's GraphQL query text includes the new fields (description, status, createdAt, updatedAt, variants.sku) and none of the forbidden inventory fields", async () => {
    pagesByCursor.set(null, { nodes: [], hasNextPage: false, endCursor: null });

    await fetchNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
    });

    const queryText = String((lastFetchBody as unknown as { query?: string })?.query ?? "");
    for (const field of [
      "onlineStoreUrl",
      "description",
      "status",
      "createdAt",
      "updatedAt",
      "sku",
    ]) {
      assert.ok(queryText.includes(field), `query text should include "${field}"`);
    }
    for (const forbidden of ["inventoryQuantity", "totalInventory", "InventoryItem"]) {
      assert.ok(
        !queryText.includes(forbidden),
        `query text must NOT include forbidden inventory field "${forbidden}"`,
      );
    }
  });
});

describe("fetchPublishedShopifyProductIds — authoritative Online Store publication scan", () => {
  test("follows multiple publication pages and returns only provider-confirmed product IDs", async () => {
    publishedPagesByCursor.set(null, {
      nodes: [{ id: "gid://shopify/Product/1" }, { id: "gid://shopify/Product/2" }],
      hasNextPage: true,
      endCursor: "published-cursor-1",
    });
    publishedPagesByCursor.set("published-cursor-1", {
      nodes: [{ id: "gid://shopify/Product/3" }],
      hasNextPage: false,
      endCursor: null,
    });

    const result = await fetchPublishedShopifyProductIds({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      limit: 2,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual([...result.productIds], [
      "gid://shopify/Product/1",
      "gid://shopify/Product/2",
      "gid://shopify/Product/3",
    ]);
    assert.equal(result.pagesFetched, 2);
    assert.match(
      String((lastFetchBody as unknown as { query?: string })?.query ?? ""),
      /published_status:published/,
    );
  });

  test("rejects missing cursors, cursor loops, and page-cap truncation rather than returning a partial set", async () => {
    publishedPagesByCursor.set(null, {
      nodes: [{ id: "gid://shopify/Product/1" }],
      hasNextPage: true,
      endCursor: null,
    });
    const missingCursor = await fetchPublishedShopifyProductIds({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
    });
    assert.equal(missingCursor.ok, false);

    publishedPagesByCursor.set(null, {
      nodes: [{ id: "gid://shopify/Product/1" }],
      hasNextPage: true,
      endCursor: "same-cursor",
    });
    publishedPagesByCursor.set("same-cursor", {
      nodes: [{ id: "gid://shopify/Product/2" }],
      hasNextPage: true,
      endCursor: "same-cursor",
    });
    const cursorLoop = await fetchPublishedShopifyProductIds({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
    });
    assert.equal(cursorLoop.ok, false);

    publishedPagesByCursor.set(null, {
      nodes: [{ id: "gid://shopify/Product/1" }],
      hasNextPage: true,
      endCursor: "more-pages",
    });
    const capped = await fetchPublishedShopifyProductIds({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      maxPages: 1,
    });
    assert.equal(capped.ok, false);
  });

  test("fails closed when the publication query itself fails", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      json: async () => ({ errors: [{ message: "simulated publication failure" }] }),
    }) as Response) as typeof globalThis.fetch;
    try {
      const result = await fetchPublishedShopifyProductIds({
        shopDomain: FAKE_SHOP_DOMAIN,
        brandId: FAKE_BRAND_ID,
      });
      assert.equal(result.ok, false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Cursor pagination
// ---------------------------------------------------------------------------

describe("fetchNormalizedShopifyProducts — single-call cursor pagination", () => {
  test("passing `after` forwards it as the GraphQL `after` variable and returns the next page's endCursor", async () => {
    pagesByCursor.set(null, {
      nodes: [rawProductNode({ id: "gid://shopify/Product/1", handle: "page-1" })],
      hasNextPage: true,
      endCursor: "cursor-1",
    });
    pagesByCursor.set("cursor-1", {
      nodes: [rawProductNode({ id: "gid://shopify/Product/2", handle: "page-2" })],
      hasNextPage: false,
      endCursor: null,
    });

    const firstPage = await fetchNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
    });
    assert.equal(firstPage.ok, true);
    if (!firstPage.ok) return;
    assert.equal(firstPage.hasNextPage, true);
    assert.equal(firstPage.endCursor, "cursor-1");
    assert.equal(firstPage.items[0]?.handle, "page-1");

    const secondPage = await fetchNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      after: firstPage.endCursor ?? undefined,
    });
    assert.equal(secondPage.ok, true);
    if (!secondPage.ok) return;
    assert.equal(secondPage.hasNextPage, false);
    assert.equal(secondPage.endCursor, null);
    assert.equal(secondPage.items[0]?.handle, "page-2");
  });

  test("omitting `after` preserves single-page, first-page behavior (sends after: null)", async () => {
    pagesByCursor.set(null, { nodes: [], hasNextPage: false, endCursor: null });

    await fetchNormalizedShopifyProducts({ shopDomain: FAKE_SHOP_DOMAIN, brandId: FAKE_BRAND_ID });

    assert.equal(lastFetchBody?.variables?.after, null);
  });
});

describe("fetchAllNormalizedShopifyProducts — multi-page loop", () => {
  test("follows endCursor across 3 pages and accumulates all items, stopping cleanly when hasNextPage is false", async () => {
    pagesByCursor.set(null, {
      nodes: [rawProductNode({ id: "1", handle: "p1" })],
      hasNextPage: true,
      endCursor: "cur-a",
    });
    pagesByCursor.set("cur-a", {
      nodes: [rawProductNode({ id: "2", handle: "p2" })],
      hasNextPage: true,
      endCursor: "cur-b",
    });
    pagesByCursor.set("cur-b", {
      nodes: [rawProductNode({ id: "3", handle: "p3" })],
      hasNextPage: false,
      endCursor: null,
    });

    const result = await fetchAllNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      pageSize: 1,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.items.map((item) => item.handle),
      ["p1", "p2", "p3"],
    );
    assert.equal(result.hasNextPage, false, "fully fetched catalog must report hasNextPage: false");
    assert.equal(result.pagesFetched, 3);
    assert.equal(fetchCallCount, 3);
  });

  test("respects the maxPages bound: stops after maxPages pages and reports hasNextPage: true when more pages remained", async () => {
    pagesByCursor.set(null, {
      nodes: [rawProductNode({ id: "1", handle: "p1" })],
      hasNextPage: true,
      endCursor: "cur-a",
    });
    pagesByCursor.set("cur-a", {
      nodes: [rawProductNode({ id: "2", handle: "p2" })],
      hasNextPage: true,
      endCursor: "cur-b",
    });
    // A 3rd page is deliberately NOT registered for "cur-b" — if the loop
    // ever requested it, the fake fetch would throw and fail the test,
    // proving maxPages actually stopped the loop before that request.

    const result = await fetchAllNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      pageSize: 1,
      maxPages: 2,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.items.map((item) => item.handle),
      ["p1", "p2"],
    );
    assert.equal(result.pagesFetched, 2);
    assert.equal(fetchCallCount, 2);
    assert.equal(
      result.hasNextPage,
      true,
      "must report hasNextPage: true when maxPages was hit while more pages were available",
    );
  });

  test("stops immediately (1 page) when the first page already reports hasNextPage: false", async () => {
    pagesByCursor.set(null, {
      nodes: [rawProductNode({ id: "1", handle: "only-page" })],
      hasNextPage: false,
      endCursor: null,
    });

    const result = await fetchAllNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.pagesFetched, 1);
    assert.equal(result.hasNextPage, false);
    assert.equal(fetchCallCount, 1);
  });

  test("M3: hasNextPage true with a null endCursor is NEVER reported as a complete fetch (must stay truncated, not claimed-complete)", async () => {
    // Anomalous provider response: Shopify says more pages exist but gives
    // no cursor to continue from. Regression test for the Phase 3 review's
    // M3 — a prior version of this loop treated `!page.endCursor` as
    // equivalent to `!page.hasNextPage` and reported the fetch as complete
    // (`hasNextPage: false`), which would silently truncate the catalog.
    pagesByCursor.set(null, {
      nodes: [rawProductNode({ id: "1", handle: "p1" })],
      hasNextPage: true,
      endCursor: null,
    });

    const result = await fetchAllNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      pageSize: 1,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(
      result.items.map((item) => item.handle),
      ["p1"],
    );
    assert.equal(result.pagesFetched, 1);
    assert.equal(fetchCallCount, 1);
    assert.equal(
      result.hasNextPage,
      true,
      "hasNextPage:true with a missing cursor must be reported as truncated, never claimed-complete",
    );
  });

  test("M3: hitting the maxPages bound exactly when the last fetched page also reports hasNextPage:true with a null endCursor still reports truncated", async () => {
    pagesByCursor.set(null, {
      nodes: [rawProductNode({ id: "1", handle: "p1" })],
      hasNextPage: true,
      endCursor: "cur-a",
    });
    pagesByCursor.set("cur-a", {
      nodes: [rawProductNode({ id: "2", handle: "p2" })],
      hasNextPage: true,
      endCursor: null,
    });

    const result = await fetchAllNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      pageSize: 1,
      maxPages: 5,
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.pagesFetched, 2);
    assert.equal(fetchCallCount, 2);
    assert.equal(result.hasNextPage, true, "must report truncated, not complete");
  });

  test("propagates a page failure immediately without retrying or returning partial items", async () => {
    pagesByCursor.set(null, {
      nodes: [rawProductNode({ id: "1", handle: "p1" })],
      hasNextPage: true,
      endCursor: "cur-fail",
    });

    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      fetchCallCount += 1;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const after: string | null = body?.variables?.after ?? null;

      if (after === null) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: {
              products: {
                nodes: [rawProductNode({ id: "1", handle: "p1" })],
                pageInfo: { hasNextPage: true, endCursor: "cur-fail" },
              },
            },
          }),
        } as Response;
      }

      // Second page: simulate a Shopify GraphQL error.
      return {
        ok: true,
        status: 200,
        json: async () => ({ errors: [{ message: "Simulated GraphQL failure" }] }),
      } as Response;
    }) as typeof globalThis.fetch;

    const result = await fetchAllNormalizedShopifyProducts({
      shopDomain: FAKE_SHOP_DOMAIN,
      brandId: FAKE_BRAND_ID,
      pageSize: 1,
    });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, "Simulated GraphQL failure");
    assert.equal(fetchCallCount, 2);
  });
});
