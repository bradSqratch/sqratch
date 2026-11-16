process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";
process.env.COMMERCE7_APP_ID = "test-app-id";
process.env.COMMERCE7_APP_SECRET = "test-app-secret";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CommerceProvider } from "@prisma/client";
import { ShopifyCommerceAdapter, type ShopifyCommerceAdapterDeps } from "../src/lib/commerce/providers/shopify-commerce-adapter";
import { Commerce7CommerceAdapter, type Commerce7CommerceConnectionRow } from "../src/lib/commerce/providers/commerce7-commerce-adapter";
import type { Commerce7Fetch } from "../src/lib/commerce/providers/commerce7-products";

const shopifyRow = {
  id: "s1", brandId: "b1", provider: CommerceProvider.SHOPIFY, status: "CONNECTED" as const, displayName: "Shop",
  externalAccountId: "shop.myshopify.com", storefrontUrl: null, isPrimary: true, grantedScopes: [], installedAt: new Date(), uninstalledAt: null,
  lastProductSyncAt: null, providerMetadata: null,
};

function shopifyAdapter(stamps: Date[]) {
  const deps = {
    loadConnection: async () => shopifyRow,
    fetchProducts: async () => ({ ok: true as const, items: [], hasNextPage: false, limit: 50, endCursor: null }),
    markProductSync: async (_id: string, at: Date) => { stamps.push(at); },
  } as unknown as ShopifyCommerceAdapterDeps;
  return new ShopifyCommerceAdapter(deps);
}

test("a Shopify product preview, however often it runs, never stamps the connection; the legacy sync still does", async () => {
  const stamps: Date[] = [];
  const adapter = shopifyAdapter(stamps);
  for (let i = 0; i < 10; i++) {
    const result = await adapter.previewProducts("s1");
    assert.equal(result.provider, CommerceProvider.SHOPIFY);
  }
  assert.equal(stamps.length, 0);
  await adapter.syncProducts("s1");
  assert.equal(stamps.length, 1);
});

test("a Commerce7 product preview never stamps the connection; the legacy sync still does", async () => {
  const stamps: Date[] = [];
  const row: Commerce7CommerceConnectionRow = {
    id: "c1", brandId: "b1", provider: CommerceProvider.COMMERCE7, status: "CONNECTED", displayName: "Tenant", externalAccountId: "tenant",
    storefrontUrl: null, isPrimary: true, grantedScopes: [], installedAt: new Date(), uninstalledAt: null, lastProductSyncAt: null, providerMetadata: null,
  } as unknown as Commerce7CommerceConnectionRow;
  const fetchImpl: Commerce7Fetch = async () => ({ ok: true, status: 200, json: async () => ({ products: [], cursor: null }) });
  const adapter = new Commerce7CommerceAdapter({
    loadConnection: async () => row,
    markProductSync: async (_id, at) => { stamps.push(at); },
    fetchImpl,
  });
  for (let i = 0; i < 10; i++) await adapter.previewProducts("c1");
  assert.equal(stamps.length, 0);
  await adapter.syncProducts("c1");
  assert.equal(stamps.length, 1);
});

test("the Shopify preview route reads through previewProducts, and nothing else in src reads the stamp for display", () => {
  const route = readFileSync("src/app/api/brand/shopify/products/route.ts", "utf8");
  assert.match(route, /adapter\.previewProducts\(summary\.id\)/);
  assert.doesNotMatch(route, /adapter\.syncProducts\(/);
  const store = readFileSync("src/app/(withSidebar)/dashboard/brand/commerce/BrandCommerceClient.tsx", "utf8");
  assert.doesNotMatch(store, /connection\??\.lastProductSyncAt/);
  assert.match(store, /lastCompletedSyncAt/);
  const products = readFileSync("src/app/(withSidebar)/dashboard/brand/products/BrandProductsClient.tsx", "utf8");
  assert.doesNotMatch(products, /will be added in\s+a later phase/);
  assert.match(products, /\/dashboard\/brand\/campaigns/);
});
