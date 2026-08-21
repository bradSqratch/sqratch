import assert from "node:assert/strict";
import { after, test } from "node:test";

import { encryptSecret } from "../src/lib/crypto";
import type { SessionTokenPayload } from "../src/lib/shopify-session-token";

const originalApiKey = process.env.SHOPIFY_API_KEY;
const originalApiSecret = process.env.SHOPIFY_API_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalEncryptionKey = process.env.APP_ENCRYPTION_KEY;
process.env.SHOPIFY_API_KEY = "embedded-status-test-api-key";
process.env.SHOPIFY_API_SECRET = "embedded-status-test-api-secret";
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.APP_ENCRYPTION_KEY = "phase-15-embedded-connection-test-key";

after(() => {
  if (originalApiKey === undefined) delete process.env.SHOPIFY_API_KEY;
  else process.env.SHOPIFY_API_KEY = originalApiKey;

  if (originalApiSecret === undefined) delete process.env.SHOPIFY_API_SECRET;
  else process.env.SHOPIFY_API_SECRET = originalApiSecret;

  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;

  if (originalEncryptionKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
  else process.env.APP_ENCRYPTION_KEY = originalEncryptionKey;
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
    currencyCode: null,
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

// PHASE 14C-A: `buildLocalShopifyDisconnectData` was deleted along with the
// legacy `Brand` write in `disconnectEmbeddedConnectedBrand` — canonical
// invalidation (`invalidateShopifyCredential`) is now the sole disconnect
// mechanism, covered by the "clears only the local matching connection"
// test above and the canonical-invalidation coverage in
// tests/shopify-credential-store.test.ts.

// ---------------------------------------------------------------------------
// F. PHASE 14B.4B — findEmbeddedConnectedBrand itself (not an injected fake)
// resolves canonical-first: a CommerceConnection row wins whenever one
// exists, and a stale/disagreeing Brand mirror can never resurrect or
// override a link the canonical connection has already disowned.
// ---------------------------------------------------------------------------

test("F. findEmbeddedConnectedBrand resolves through CommerceConnection directly, never touching Brand when canonical matches", async () => {
  const { default: prisma } = (await import("../src/lib/prisma")) as unknown as {
    default: Record<string, Record<string, (...args: unknown[]) => unknown>>;
  };
  let brandFindUniqueCalled = false;
  prisma.commerceConnection = {
    findUnique: async (args: unknown) => {
      const typed = args as {
        where: { provider_externalAccountId: { provider: string; externalAccountId: string } };
      };
      assert.equal(typed.where.provider_externalAccountId.provider, "SHOPIFY");
      assert.equal(typed.where.provider_externalAccountId.externalAccountId, "verified.myshopify.com");
      return {
        id: "conn-canonical",
        brandId: "brand-canonical",
        status: "CONNECTED",
        providerClientId: "embedded-status-test-api-key",
        // Deliberately stale: embedded eligibility must use the encrypted
        // credential projection below, never this retired metadata key.
        providerMetadata: { authMode: "LEGACY_OFFLINE" },
      };
    },
    findFirst: async () => ({
      secret: {
        encryptedPayload: encryptSecret(JSON.stringify({ authMode: "EXPIRING_OFFLINE" })),
      },
    }),
  };
  prisma.brand = {
    findUnique: async () => {
      return { id: "brand-canonical", name: "Canonical Brand" };
    },
    findFirst: async () => {
      brandFindUniqueCalled = true;
      throw new Error("must not use the legacy Brand predicate when canonical matches");
    },
  };

  const { findEmbeddedConnectedBrand } = await import("../src/lib/shopify-embedded-connection");
  const result = await findEmbeddedConnectedBrand(
    "verified.myshopify.com",
    "embedded-status-test-api-key",
  );

  assert.deepEqual(result, {
    id: "brand-canonical",
    name: "Canonical Brand",
    shopifyConnectionStatus: "CONNECTED",
    currencyCode: null,
  });
  assert.equal(brandFindUniqueCalled, false);
});

test("F. stale providerMetadata authMode cannot make an embedded legacy credential look expiring", async () => {
  const { default: prisma } = (await import("../src/lib/prisma")) as unknown as {
    default: Record<string, Record<string, (...args: unknown[]) => unknown>>;
  };
  prisma.commerceConnection = {
    findUnique: async () => ({
      id: "conn-stale-metadata",
      brandId: "brand-canonical",
      status: "CONNECTED",
      providerClientId: "embedded-status-test-api-key",
      providerMetadata: { authMode: "EXPIRING_OFFLINE" },
    }),
    findFirst: async () => ({
      secret: {
        encryptedPayload: encryptSecret(JSON.stringify({ authMode: "LEGACY_OFFLINE" })),
      },
    }),
  };
  prisma.brand = {
    findUnique: async () => {
      assert.fail("a credential-auth-mode mismatch must fail closed before Brand lookup");
      return null;
    },
  };

  const { findEmbeddedConnectedBrand } = await import("../src/lib/shopify-embedded-connection");
  assert.equal(
    await findEmbeddedConnectedBrand("verified.myshopify.com", "embedded-status-test-api-key"),
    null,
  );
});

test("F. a canonical connection that DISAGREES (wrong client id) reports unlinked, never falls back to a stale Brand mirror", async () => {
  const { default: prisma } = (await import("../src/lib/prisma")) as unknown as {
    default: Record<string, Record<string, (...args: unknown[]) => unknown>>;
  };
  prisma.commerceConnection = {
    findUnique: async () => ({
      id: "conn-canonical",
      brandId: "brand-canonical",
      status: "CONNECTED",
      providerClientId: "some-other-app-client-id",
      providerMetadata: { authMode: "EXPIRING_OFFLINE" },
    }),
  };
  let legacyFallbackAttempted = false;
  prisma.brand = {
    findFirst: async () => {
      // The canonical row WAS found — it just disagreed. Legacy must never
      // be consulted as a rescue in that case (only for NO row at all).
      legacyFallbackAttempted = true;
      return { id: "brand-legacy", name: "Stale Legacy Brand", shopifyConnectionStatus: "CONNECTED" };
    },
  };

  const { findEmbeddedConnectedBrand } = await import("../src/lib/shopify-embedded-connection");
  const result = await findEmbeddedConnectedBrand(
    "verified.myshopify.com",
    "embedded-status-test-api-key",
  );

  assert.equal(result, null);
  assert.equal(legacyFallbackAttempted, false);
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
