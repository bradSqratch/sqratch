import assert from "node:assert/strict";
import { after, test } from "node:test";

import type { SessionTokenPayload } from "../src/lib/shopify-session-token";

const originalApiKey = process.env.SHOPIFY_API_KEY;
const originalApiSecret = process.env.SHOPIFY_API_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;
process.env.SHOPIFY_API_KEY = "embedded-status-test-api-key";
process.env.SHOPIFY_API_SECRET = "embedded-status-test-api-secret";
process.env.DATABASE_URL ||= "postgresql://test:test@localhost:5432/test";

after(() => {
  if (originalApiKey === undefined) delete process.env.SHOPIFY_API_KEY;
  else process.env.SHOPIFY_API_KEY = originalApiKey;

  if (originalApiSecret === undefined) delete process.env.SHOPIFY_API_SECRET;
  else process.env.SHOPIFY_API_SECRET = originalApiSecret;

  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

function verifiedShop(shop: string) {
  return {
    ok: true as const,
    shop,
    payload: {} as SessionTokenPayload,
  };
}

function connectedBrand() {
  return {
    id: "brand-internal-id",
    name: "Envinate",
    shopifyConnectionStatus: "CONNECTED" as const,
  };
}

test("embedded status uses the verified session-token shop instead of request input", async () => {
  const { embeddedStatusPostImpl } = await import(
    "../src/app/api/shopify/embedded/status/route"
  );
  let capturedShop = "";
  let capturedClientId = "";

  const response = await embeddedStatusPostImpl(
    new Request("https://sqratch.test/api/shopify/embedded/status?shop=attacker.myshopify.com", {
      method: "POST",
      body: JSON.stringify({ shop: "attacker.myshopify.com" }),
    }),
    {
      verifySessionTokenFromRequest: () => verifiedShop("verified.myshopify.com"),
      findEmbeddedConnectedBrand: async (shop, clientId) => {
        capturedShop = shop;
        capturedClientId = clientId;
        return connectedBrand();
      },
    },
  );

  assert.equal(capturedShop, "verified.myshopify.com");
  assert.equal(capturedClientId, "embedded-status-test-api-key");
  assert.deepEqual(await response.json(), {
    data: {
      linked: true,
      brandName: "Envinate",
      connectionStatus: "CONNECTED",
    },
  });
});

test("embedded status reports unlinked for non-current-app or incomplete connection states", async () => {
  const { embeddedStatusPostImpl } = await import(
    "../src/app/api/shopify/embedded/status/route"
  );

  for (const state of [
    "DISCONNECTED",
    "UNINSTALLED",
    "wrong-client",
    "missing-credentials",
  ]) {
    const response = await embeddedStatusPostImpl(
      new Request("https://sqratch.test/api/shopify/embedded/status", {
        method: "POST",
      }),
      {
        verifySessionTokenFromRequest: () => verifiedShop("verified.myshopify.com"),
        findEmbeddedConnectedBrand: async () => null,
      },
    );

    assert.deepEqual(await response.json(), {
      data: { linked: false, brandName: null, connectionStatus: null },
    }, state);
  }
});

test("embedded status lookup requires the current public-app credential state", async () => {
  const { buildEmbeddedConnectedBrandWhere } = await import(
    "../src/lib/shopify-embedded-connection"
  );

  assert.deepEqual(buildEmbeddedConnectedBrandWhere(
    "verified.myshopify.com",
    "embedded-status-test-api-key",
  ), {
    shopifyShopDomain: "verified.myshopify.com",
    shopifyConnectionStatus: "CONNECTED",
    shopifyClientId: "embedded-status-test-api-key",
    shopifyAuthMode: "EXPIRING_OFFLINE",
    shopifyAdminAccessTokenEncrypted: { not: null },
    shopifyRefreshTokenEncrypted: { not: null },
    shopifyAccessTokenExpiresAt: { not: null },
    shopifyRefreshTokenExpiresAt: { not: null },
    shopifyGrantedScopes: { not: null },
  });
});

test("embedded disconnect requires a valid App Bridge token", async () => {
  const { POST } = await import(
    "../src/app/api/shopify/embedded/disconnect/route"
  );

  const response = await POST(
    new Request("https://sqratch.test/api/shopify/embedded/disconnect", {
      method: "POST",
    }),
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Unauthorized." });
});

test("embedded disconnect clears only the local matching connection and returns no credentials", async () => {
  const { embeddedDisconnectPostImpl } = await import(
    "../src/app/api/shopify/embedded/disconnect/route"
  );
  let disconnectInput: {
    brandId: string;
    shopDomain: string;
    clientId: string;
  } | null = null;

  const response = await embeddedDisconnectPostImpl(
    new Request("https://sqratch.test/api/shopify/embedded/disconnect?shop=attacker.myshopify.com", {
      method: "POST",
      body: JSON.stringify({ shop: "attacker.myshopify.com" }),
    }),
    {
      verifySessionTokenFromRequest: () => verifiedShop("verified.myshopify.com"),
      findEmbeddedConnectedBrand: async () => connectedBrand(),
      disconnectEmbeddedConnectedBrand: async (input) => {
        disconnectInput = input;
        return { count: 1 };
      },
    },
  );

  assert.deepEqual(disconnectInput, {
    brandId: "brand-internal-id",
    shopDomain: "verified.myshopify.com",
    clientId: "embedded-status-test-api-key",
  });
  assert.deepEqual(await response.json(), {
    data: { linked: false, brandName: null, connectionStatus: null },
  });
});

test("embedded disconnect is idempotent when the store is already disconnected", async () => {
  const { embeddedDisconnectPostImpl } = await import(
    "../src/app/api/shopify/embedded/disconnect/route"
  );
  let disconnectCalled = false;

  const response = await embeddedDisconnectPostImpl(
    new Request("https://sqratch.test/api/shopify/embedded/disconnect", {
      method: "POST",
    }),
    {
      verifySessionTokenFromRequest: () => verifiedShop("verified.myshopify.com"),
      findEmbeddedConnectedBrand: async () => null,
      disconnectEmbeddedConnectedBrand: async () => {
        disconnectCalled = true;
        return { count: 0 };
      },
    },
  );

  assert.equal(disconnectCalled, false);
  assert.deepEqual(await response.json(), {
    data: { linked: false, brandName: null, connectionStatus: null },
  });
});

test("local disconnect data clears credentials without deleting business records", async () => {
  const { buildLocalShopifyDisconnectData } = await import(
    "../src/lib/shopify-embedded-connection"
  );
  const data = buildLocalShopifyDisconnectData(new Date("2026-07-17T00:00:00Z"));

  assert.deepEqual(Object.keys(data).sort(), [
    "shopifyAccessTokenExpiresAt",
    "shopifyAdminAccessTokenEncrypted",
    "shopifyClientId",
    "shopifyConnectionStatus",
    "shopifyDisconnectedAt",
    "shopifyGrantedScopes",
    "shopifyRefreshTokenEncrypted",
    "shopifyRefreshTokenExpiresAt",
    "shopifyShopDomain",
    "shopifyTokenRefreshLockId",
    "shopifyTokenRefreshLockedUntil",
    "shopifyUninstalledAt",
  ]);
  assert.equal(data.shopifyConnectionStatus, "DISCONNECTED");
  assert.equal(data.shopifyShopDomain, null);
  assert.equal(data.shopifyAdminAccessTokenEncrypted, null);
  assert.equal(data.shopifyRefreshTokenEncrypted, null);
  assert.equal("campaigns" in data, false);
  assert.equal("experiences" in data, false);
  assert.equal("rewardOffers" in data, false);
  assert.equal("delete" in data, false);
});

test("embedded endpoint responses and sanitized logs exclude credentials", async () => {
  const { embeddedStatusPostImpl } = await import(
    "../src/app/api/shopify/embedded/status/route"
  );
  const originalInfo = console.info;
  const entries: unknown[][] = [];
  console.info = (...args: unknown[]) => entries.push(args);

  try {
    const response = await embeddedStatusPostImpl(
      new Request("https://sqratch.test/api/shopify/embedded/status", {
        method: "POST",
      }),
      {
        verifySessionTokenFromRequest: () => verifiedShop("verified.myshopify.com"),
        findEmbeddedConnectedBrand: async () => connectedBrand(),
      },
    );
    const serialized = JSON.stringify({
      response: await response.json(),
      logs: entries,
    });

    assert.doesNotMatch(serialized, /brand-internal-id|access-token|refresh-token|encrypted|@/i);
  } finally {
    console.info = originalInfo;
  }
});
