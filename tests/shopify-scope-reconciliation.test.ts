process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";
process.env.COMMERCE_CLICK_TOKEN_PEPPER = "dummy-pepper-at-least-32-characters-long";

/**
 * tests/shopify-scope-reconciliation.test.ts
 *
 * Covers `reconcileShopifyConnectionScopes` (`src/lib/shopify-token-manager.ts`)
 * — the PULL-based safety net that proves a stored credential still works
 * against Shopify via a real Admin API call, fetches Shopify's own
 * `currentAppInstallation.accessScopes`, persists them as canonical, and
 * heals a scope-drift `REQUIRES_RECONNECT` back to `CONNECTED`.
 *
 * This is deliberately a SEPARATE harness from
 * tests/shopify-scopes-update-webhook.test.ts (which covers the PUSH-based
 * `app/scopes_update` path): the two paths share `healScopeDriftReconnect`
 * but reach it through entirely different entry points (a live outbound
 * fetch vs. an inbound signed webhook), so they need independently
 * constructed evidence.
 *
 * TESTING APPROACH: real exported `reconcileShopifyConnectionScopes`, fake
 * `prisma.brand` / `prisma.commerceConnection` / `prisma.$transaction`, and a
 * fake global `fetch` injected via the function's own `deps` parameter (never
 * a real network call).
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

interface FakeBrand {
  id: string;
  shopifyShopDomain: string | null;
  shopifyConnectionStatus: string;
  shopifyGrantedScopes: string | null;
  shopifyAdminAccessTokenEncrypted: string | null;
  shopifyAccessTokenExpiresAt: Date | null;
  shopifyRefreshTokenEncrypted: string | null;
  shopifyRefreshTokenExpiresAt: Date | null;
  shopifyAuthMode: string;
  shopifyClientId: string | null;
  shopifyCurrencyCode: string | null;
  shopifyTokenRefreshLockedUntil: Date | null;
  shopifyTokenRefreshLockId: string | null;
}

let brands: FakeBrand[] = [];
let connectionEventCreateCalls: Array<{ brandId: string; eventType: string }> = [];

function findBrand(id: string): FakeBrand | undefined {
  return brands.find((b) => b.id === id);
}

const brandDelegateStub = {
  findUnique: async (args: { where: { id: string } }) => {
    const match = findBrand(args.where.id);
    return match ? { ...match } : null;
  },
  updateMany: async (args: {
    where: { id: string; shopifyTokenRefreshLockId?: string };
    data: Record<string, unknown>;
  }) => {
    const matched = brands.filter((b) => {
      if (b.id !== args.where.id) return false;
      if (
        args.where.shopifyTokenRefreshLockId !== undefined &&
        b.shopifyTokenRefreshLockId !== args.where.shopifyTokenRefreshLockId
      ) {
        return false;
      }
      return true;
    });
    for (const b of matched) Object.assign(b, args.data);
    return { count: matched.length };
  },
};

/** Mirrors the shape `applyGrantedScopesUpdate` needs, keyed by shop domain. */
const brandDelegateByDomain = {
  findUnique: async (args: { where: { shopifyShopDomain: string } }) => {
    const match = brands.find((b) => b.shopifyShopDomain === args.where.shopifyShopDomain);
    return match ? { ...match } : null;
  },
};

let canonicalConnection: { id: string; brandId: string; grantedScopes: string[] } | null = null;
const commerceConnectionDelegateStub = {
  findUnique: async () => canonicalConnection,
  updateMany: async (args: { data: { grantedScopes?: string[] } }) => {
    if (!canonicalConnection) return { count: 0 };
    canonicalConnection.grantedScopes = args.data.grantedScopes ?? [];
    return { count: 1 };
  },
};

async function fakeTransaction<T>(fn: (tx: Record<string, unknown>) => Promise<T>): Promise<T> {
  const tx = {
    brand: {
      findUnique: async (args: { where: { id: string } }) => {
        const match = findBrand(args.where.id);
        return match ? { ...match } : null;
      },
      updateMany: async (args: {
        where: { id: string; shopifyConnectionStatus?: string };
        data: Record<string, unknown>;
      }) => {
        const matched = brands.filter((b) => {
          if (b.id !== args.where.id) return false;
          if (
            args.where.shopifyConnectionStatus !== undefined &&
            b.shopifyConnectionStatus !== args.where.shopifyConnectionStatus
          ) {
            return false;
          }
          return true;
        });
        for (const b of matched) Object.assign(b, args.data);
        return { count: matched.length };
      },
    },
    brandRewardOffer: { updateMany: async () => ({ count: 0 }) },
    shopifyConnectionEvent: {
      create: async (args: { data: { brandId: string; eventType: string } }) => {
        connectionEventCreateCalls.push({ brandId: args.data.brandId, eventType: args.data.eventType });
        return {};
      },
    },
  };
  return fn(tx);
}

function makeBrand(overrides: Partial<FakeBrand> = {}): FakeBrand {
  return {
    id: "brand-recon-1",
    shopifyShopDomain: "recon-shop.myshopify.com",
    shopifyConnectionStatus: "CONNECTED",
    shopifyGrantedScopes: "read_products,read_discounts,write_discounts",
    shopifyAdminAccessTokenEncrypted: null,
    shopifyAccessTokenExpiresAt: null,
    shopifyRefreshTokenEncrypted: null,
    shopifyRefreshTokenExpiresAt: null,
    shopifyAuthMode: "LEGACY_OFFLINE",
    shopifyClientId: "0123456789abcdef0123456789abcdef",
    shopifyCurrencyCode: "USD",
    shopifyTokenRefreshLockedUntil: null,
    shopifyTokenRefreshLockId: null,
    ...overrides,
  };
}

function graphQLScopesResponse(scopes: string[]): Response {
  return new Response(
    JSON.stringify({ data: { currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

let reconcileShopifyConnectionScopes: typeof import("../src/lib/shopify-token-manager").reconcileShopifyConnectionScopes;
let encryptSecret: typeof import("../src/lib/crypto").encryptSecret;

before(async () => {
  const prismaModule = (await import("../src/lib/prisma")).default as unknown as Record<string, unknown>;
  // A single brand delegate must serve BOTH lookup shapes this function's
  // call graph needs (by id via reloadBrand, by shopifyShopDomain via
  // applyGrantedScopesUpdate) — dispatch on which `where` key is present.
  prismaModule.brand = {
    findUnique: async (args: { where: { id?: string; shopifyShopDomain?: string } }) =>
      "id" in args.where && args.where.id !== undefined
        ? brandDelegateStub.findUnique(args as { where: { id: string } })
        : brandDelegateByDomain.findUnique(args as { where: { shopifyShopDomain: string } }),
    updateMany: brandDelegateStub.updateMany,
  };
  prismaModule.commerceConnection = commerceConnectionDelegateStub;
  prismaModule.$transaction = fakeTransaction;

  const tokenManager = await import("../src/lib/shopify-token-manager");
  reconcileShopifyConnectionScopes = tokenManager.reconcileShopifyConnectionScopes;
  const crypto = await import("../src/lib/crypto");
  encryptSecret = crypto.encryptSecret;
});

beforeEach(() => {
  brands = [];
  canonicalConnection = null;
  connectionEventCreateCalls = [];
});

describe("reconcileShopifyConnectionScopes", () => {
  test("NOT_ELIGIBLE: no such brand", async () => {
    const result = await reconcileShopifyConnectionScopes("does-not-exist");
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "NO_BRAND" });
  });

  test("NOT_ELIGIBLE: brand has no shop domain on record", async () => {
    brands.push(makeBrand({ shopifyShopDomain: null }));
    const result = await reconcileShopifyConnectionScopes("brand-recon-1");
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "NO_SHOP_DOMAIN" });
  });

  test("NOT_ELIGIBLE: REQUIRES_RECONNECT with NO credential on file is a genuine failure, never reconciled", async () => {
    brands.push(
      makeBrand({
        shopifyConnectionStatus: "REQUIRES_RECONNECT",
        shopifyAdminAccessTokenEncrypted: null,
      }),
    );
    const result = await reconcileShopifyConnectionScopes("brand-recon-1");
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "NOT_SCOPE_DRIFT" });
    assert.equal(connectionEventCreateCalls.length, 0);
  });

  test("CREDENTIAL_INVALID: Shopify rejects the token (e.g. revoked) — never healed, never scope-updated", async () => {
    brands.push(
      makeBrand({
        shopifyConnectionStatus: "REQUIRES_RECONNECT",
        shopifyAdminAccessTokenEncrypted: encryptSecret("shpat_revoked"),
      }),
    );
    const fetchImpl = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;

    const result = await reconcileShopifyConnectionScopes("brand-recon-1", { fetchImpl });

    assert.deepEqual(result, { outcome: "CREDENTIAL_INVALID" });
    assert.equal(
      findBrand("brand-recon-1")!.shopifyConnectionStatus,
      "REQUIRES_RECONNECT",
      "a genuinely rejected credential must never be healed",
    );
    assert.equal(connectionEventCreateCalls.length, 0);
  });

  test("CREDENTIAL_INVALID: network failure talking to Shopify — fails closed, no partial write", async () => {
    brands.push(
      makeBrand({
        shopifyConnectionStatus: "REQUIRES_RECONNECT",
        shopifyAdminAccessTokenEncrypted: encryptSecret("shpat_x"),
      }),
    );
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await reconcileShopifyConnectionScopes("brand-recon-1", { fetchImpl });

    assert.deepEqual(result, { outcome: "CREDENTIAL_INVALID" });
    assert.equal(findBrand("brand-recon-1")!.shopifyConnectionStatus, "REQUIRES_RECONNECT");
  });

  test("RECONCILED + healed: LEGACY_OFFLINE scope-drift REQUIRES_RECONNECT is healed and scopes are updated to Shopify's authoritative set", async () => {
    brands.push(
      makeBrand({
        shopifyConnectionStatus: "REQUIRES_RECONNECT",
        shopifyGrantedScopes: "read_products,write_discounts",
        shopifyAdminAccessTokenEncrypted: encryptSecret("shpat_still_good"),
        shopifyAuthMode: "LEGACY_OFFLINE",
      }),
    );
    const fetchImpl = (async () =>
      graphQLScopesResponse([
        "read_products",
        "read_orders",
        "read_themes",
        "read_discounts",
        "write_discounts",
      ])) as unknown as typeof fetch;

    const result = await reconcileShopifyConnectionScopes("brand-recon-1", { fetchImpl });

    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") {
      assert.equal(result.healedConnection, true);
      assert.deepEqual(
        result.grantedScopes.sort(),
        ["read_discounts", "read_orders", "read_products", "read_themes", "write_discounts"].sort(),
      );
    }
    assert.equal(findBrand("brand-recon-1")!.shopifyConnectionStatus, "CONNECTED");
    assert.equal(
      findBrand("brand-recon-1")!.shopifyGrantedScopes,
      "read_products,read_orders,read_themes,read_discounts,write_discounts",
    );
    assert.equal(connectionEventCreateCalls.length, 1);
    assert.equal(connectionEventCreateCalls[0]!.eventType, "RECONNECTED");
  });

  test("RECONCILED, not healed: an already-CONNECTED brand just gets its scopes refreshed, no event", async () => {
    brands.push(
      makeBrand({
        shopifyConnectionStatus: "CONNECTED",
        shopifyGrantedScopes: "read_products,read_discounts,write_discounts",
        shopifyAdminAccessTokenEncrypted: encryptSecret("shpat_good"),
        shopifyAuthMode: "LEGACY_OFFLINE",
      }),
    );
    const fetchImpl = (async () =>
      graphQLScopesResponse(["read_products", "read_orders", "read_discounts", "write_discounts"])) as unknown as typeof fetch;

    const result = await reconcileShopifyConnectionScopes("brand-recon-1", { fetchImpl });

    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") assert.equal(result.healedConnection, false);
    assert.equal(findBrand("brand-recon-1")!.shopifyConnectionStatus, "CONNECTED");
    assert.equal(connectionEventCreateCalls.length, 0, "healing must never fire for a connection that was never REQUIRES_RECONNECT");
  });

  test("malformed GraphQL response shape (missing accessScopes) is treated as CREDENTIAL_INVALID, not a crash", async () => {
    brands.push(
      makeBrand({
        shopifyConnectionStatus: "REQUIRES_RECONNECT",
        shopifyAdminAccessTokenEncrypted: encryptSecret("shpat_x"),
      }),
    );
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { currentAppInstallation: {} } }), { status: 200 })) as unknown as typeof fetch;

    const result = await reconcileShopifyConnectionScopes("brand-recon-1", { fetchImpl });
    assert.deepEqual(result, { outcome: "CREDENTIAL_INVALID" });
  });

  test("a GraphQL `errors` payload (200 status, but a real GraphQL error) is treated as CREDENTIAL_INVALID", async () => {
    brands.push(
      makeBrand({
        shopifyConnectionStatus: "REQUIRES_RECONNECT",
        shopifyAdminAccessTokenEncrypted: encryptSecret("shpat_x"),
      }),
    );
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ errors: [{ message: "Invalid API key or access token" }] }), {
        status: 200,
      })) as unknown as typeof fetch;

    const result = await reconcileShopifyConnectionScopes("brand-recon-1", { fetchImpl });
    assert.deepEqual(result, { outcome: "CREDENTIAL_INVALID" });
  });
});
