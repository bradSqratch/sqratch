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
 * PHASE 14C-A: `reconcileShopifyConnectionScopes` resolves its credential
 * SOLELY through `loadShopifyCredential` (canonical `CommerceConnection` +
 * `CommerceConnectionSecret`) — there is no `Brand.shopify*` fallback left.
 * The fake storage below models only those two canonical tables.
 *
 * TESTING APPROACH: real exported `reconcileShopifyConnectionScopes`, fake
 * `prisma.commerceConnection` / `prisma.commerceConnectionSecret` /
 * `prisma.$transaction`, and a fake global `fetch` injected via the
 * function's own `deps` parameter (never a real network call).
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

interface FakeConnection {
  id: string;
  brandId: string;
  provider: string;
  externalAccountId: string;
  status: string;
  grantedScopes: string[];
  providerClientId: string | null;
  /** Whether a `CommerceConnectionSecret` row exists for this connection. */
  hasSecret: boolean;
  authMode: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
}

let connections: FakeConnection[] = [];
let connectionEventCreateCalls: Array<{ brandId: string; eventType: string }> = [];

function findConnection(brandId: string): FakeConnection | undefined {
  return connections.find((c) => c.brandId === brandId);
}

function connectionFor(brandId: string): FakeConnection {
  const found = findConnection(brandId);
  assert.ok(found, `expected fixture connection for ${brandId}`);
  return found!;
}

interface ConnectionWhere {
  id?: string;
  brandId?: string;
  provider?: string;
  externalAccountId?: string;
  status?: string | { not?: string };
}

function matchesConnectionWhere(conn: FakeConnection, where: ConnectionWhere): boolean {
  if (where.id !== undefined && conn.id !== where.id) return false;
  if (where.brandId !== undefined && conn.brandId !== where.brandId) return false;
  if (where.provider !== undefined && conn.provider !== where.provider) return false;
  if (where.externalAccountId !== undefined && conn.externalAccountId !== where.externalAccountId) {
    return false;
  }
  if (where.status !== undefined) {
    if (typeof where.status === "string") {
      if (conn.status !== where.status) return false;
    } else if (where.status.not !== undefined && conn.status === where.status.not) {
      return false;
    }
  }
  return true;
}

/** Encodes a connection's token fields into a validly `encryptSecret`-encrypted payload. */
function encodeConnectionSecret(conn: FakeConnection): string {
  return encryptSecret(
    JSON.stringify({
      accessToken: conn.accessToken,
      accessTokenExpiresAt: conn.accessTokenExpiresAt?.toISOString() ?? null,
      refreshToken: conn.refreshToken,
      refreshTokenExpiresAt: conn.refreshTokenExpiresAt?.toISOString() ?? null,
      authMode: conn.authMode,
    }),
  );
}

const commerceConnectionDelegateStub = {
  // Used by `applyGrantedScopesUpdate`'s identity resolution.
  findUnique: async (args: {
    where: { provider_externalAccountId: { provider: string; externalAccountId: string } };
  }) => {
    const { provider, externalAccountId } = args.where.provider_externalAccountId;
    const match =
      connections.find(
        (c) => c.provider === provider && c.externalAccountId === externalAccountId,
      ) ?? null;
    return match ? { id: match.id, brandId: match.brandId, status: match.status } : null;
  },
  // Used by `healShopifyCredentialConnected` ({id}) and `loadShopifyCredential`
  // (full row + nested secret) — both keyed on brandId+provider. Returns the
  // full shape (a superset of either real `select`) so both callers see real
  // values rather than `undefined`.
  findFirst: async (args: { where: { brandId: string; provider: string } }) => {
    const match =
      connections.find(
        (c) => c.brandId === args.where.brandId && c.provider === args.where.provider,
      ) ?? null;
    if (!match) return null;
    return {
      id: match.id,
      brandId: match.brandId,
      status: match.status,
      externalAccountId: match.externalAccountId,
      providerClientId: match.providerClientId,
      grantedScopes: match.grantedScopes,
      secret: match.hasSecret ? { encryptedPayload: encodeConnectionSecret(match) } : null,
    };
  },
  // Backs BOTH the scope-cache CAS write (`applyGrantedScopesUpdate`) and the
  // status heal (`healShopifyCredentialConnected`).
  updateMany: async (args: { where: ConnectionWhere; data: Record<string, unknown> }) => {
    const matched = connections.filter((c) => matchesConnectionWhere(c, args.where));
    for (const c of matched) {
      if (args.data.grantedScopes !== undefined) c.grantedScopes = args.data.grantedScopes as string[];
      if (args.data.status !== undefined) c.status = args.data.status as string;
    }
    return { count: matched.length };
  },
};

/**
 * The canonical secret delegate. `findUnique` backs `applyGrantedScopesUpdate`'s
 * mere-presence check (never decrypts). Every fixture in this file uses
 * `LEGACY_OFFLINE` auth mode, so the lease/rotation calls must never be
 * reached — each throws loudly rather than silently returning a benign
 * value, so a regression that started refreshing a LEGACY_OFFLINE credential
 * would fail the suite instead of passing quietly.
 */
const commerceConnectionSecretDelegateStub = {
  findUnique: async (args: { where: { connectionId: string } }) => {
    const match = connections.find((c) => c.id === args.where.connectionId);
    return match && match.hasSecret ? { connectionId: match.id } : null;
  },
  updateMany: async () => {
    throw new Error("canonical lease must not be used for a LEGACY_OFFLINE connection");
  },
  deleteMany: async () => {
    throw new Error("canonical secret must not be cleared by reconciliation");
  },
  upsert: async () => {
    throw new Error("canonical secret must not be written by reconciliation");
  },
};

/**
 * Backs `healScopeDriftReconnect`'s transaction (`recordShopifyConnectionInstall`).
 * Shares the SAME `connections` in-memory table as the non-transactional
 * stubs above, so a heal triggered through this mock is genuinely observable
 * via `connectionFor("brand-recon-1")` afterward. `recordShopifyConnectionInstall`
 * never touches `Brand` — only reward offers and the connection-history event.
 */
async function fakeTransaction<T>(fn: (tx: Record<string, unknown>) => Promise<T>): Promise<T> {
  const tx = {
    brandRewardOffer: { updateMany: async () => ({ count: 0 }) },
    commerceConnectionEvent: {
      create: async (args: { data: { brandId: string; eventType: string } }) => {
        connectionEventCreateCalls.push({ brandId: args.data.brandId, eventType: args.data.eventType });
        return {};
      },
    },
  };
  return fn(tx);
}

function makeConnection(overrides: Partial<FakeConnection> = {}): FakeConnection {
  return {
    id: "connection-recon-1",
    brandId: "brand-recon-1",
    provider: "SHOPIFY",
    externalAccountId: "recon-shop.myshopify.com",
    status: "CONNECTED",
    grantedScopes: ["read_products", "read_discounts", "write_discounts"],
    providerClientId: "0123456789abcdef0123456789abcdef",
    hasSecret: false,
    authMode: "LEGACY_OFFLINE",
    accessToken: null,
    accessTokenExpiresAt: null,
    refreshToken: null,
    refreshTokenExpiresAt: null,
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
  prismaModule.commerceConnection = commerceConnectionDelegateStub;
  prismaModule.commerceConnectionSecret = commerceConnectionSecretDelegateStub;
  prismaModule.$transaction = fakeTransaction;

  const crypto = await import("../src/lib/crypto");
  encryptSecret = crypto.encryptSecret;

  const tokenManager = await import("../src/lib/shopify-token-manager");
  reconcileShopifyConnectionScopes = tokenManager.reconcileShopifyConnectionScopes;
});

beforeEach(() => {
  connections = [];
  connectionEventCreateCalls = [];
});

describe("reconcileShopifyConnectionScopes", () => {
  test("NOT_ELIGIBLE: no such brand", async () => {
    const result = await reconcileShopifyConnectionScopes("does-not-exist");
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "NO_BRAND" });
  });

  test("NOT_ELIGIBLE: a connection exists but has no canonical secret on file", async () => {
    connections.push(makeConnection({ hasSecret: false }));
    const result = await reconcileShopifyConnectionScopes("brand-recon-1");
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "NO_BRAND" });
  });

  test("NOT_ELIGIBLE: a REQUIRES_RECONNECT secret that decrypts but carries no access token is not scope drift", async () => {
    connections.push(
      makeConnection({
        status: "REQUIRES_RECONNECT",
        hasSecret: true,
        accessToken: null,
      }),
    );
    const result = await reconcileShopifyConnectionScopes("brand-recon-1");
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "NOT_SCOPE_DRIFT" });
    assert.equal(connectionEventCreateCalls.length, 0);
  });

  test("CREDENTIAL_INVALID: Shopify rejects the token (e.g. revoked) — never healed, never scope-updated", async () => {
    connections.push(
      makeConnection({
        status: "REQUIRES_RECONNECT",
        hasSecret: true,
        accessToken: "shpat_revoked",
      }),
    );
    const fetchImpl = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;

    const result = await reconcileShopifyConnectionScopes("brand-recon-1", { fetchImpl });

    assert.deepEqual(result, { outcome: "CREDENTIAL_INVALID" });
    assert.equal(
      connectionFor("brand-recon-1").status,
      "REQUIRES_RECONNECT",
      "a genuinely rejected credential must never be healed",
    );
    assert.equal(connectionEventCreateCalls.length, 0);
  });

  test("CREDENTIAL_INVALID: network failure talking to Shopify — fails closed, no partial write", async () => {
    connections.push(
      makeConnection({
        status: "REQUIRES_RECONNECT",
        hasSecret: true,
        accessToken: "shpat_x",
      }),
    );
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const result = await reconcileShopifyConnectionScopes("brand-recon-1", { fetchImpl });

    assert.deepEqual(result, { outcome: "CREDENTIAL_INVALID" });
    assert.equal(connectionFor("brand-recon-1").status, "REQUIRES_RECONNECT");
  });

  test("RECONCILED + healed: LEGACY_OFFLINE scope-drift REQUIRES_RECONNECT is healed and scopes are updated to Shopify's authoritative set", async () => {
    connections.push(
      makeConnection({
        status: "REQUIRES_RECONNECT",
        grantedScopes: ["read_products", "write_discounts"],
        hasSecret: true,
        accessToken: "shpat_still_good",
        authMode: "LEGACY_OFFLINE",
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
    assert.equal(connectionFor("brand-recon-1").status, "CONNECTED");
    assert.deepEqual(connectionFor("brand-recon-1").grantedScopes, [
      "read_products",
      "read_orders",
      "read_themes",
      "read_discounts",
      "write_discounts",
    ]);
    assert.equal(connectionEventCreateCalls.length, 1);
    assert.equal(connectionEventCreateCalls[0]!.eventType, "RECONNECTED");
  });

  test("RECONCILED, not healed: an already-CONNECTED brand just gets its scopes refreshed, no event", async () => {
    connections.push(
      makeConnection({
        status: "CONNECTED",
        grantedScopes: ["read_products", "read_discounts", "write_discounts"],
        hasSecret: true,
        accessToken: "shpat_good",
        authMode: "LEGACY_OFFLINE",
      }),
    );
    const fetchImpl = (async () =>
      graphQLScopesResponse(["read_products", "read_orders", "read_discounts", "write_discounts"])) as unknown as typeof fetch;

    const result = await reconcileShopifyConnectionScopes("brand-recon-1", { fetchImpl });

    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") assert.equal(result.healedConnection, false);
    assert.equal(connectionFor("brand-recon-1").status, "CONNECTED");
    assert.equal(connectionEventCreateCalls.length, 0, "healing must never fire for a connection that was never REQUIRES_RECONNECT");
  });

  test("malformed GraphQL response shape (missing accessScopes) is treated as CREDENTIAL_INVALID, not a crash", async () => {
    connections.push(
      makeConnection({
        status: "REQUIRES_RECONNECT",
        hasSecret: true,
        accessToken: "shpat_x",
      }),
    );
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: { currentAppInstallation: {} } }), { status: 200 })) as unknown as typeof fetch;

    const result = await reconcileShopifyConnectionScopes("brand-recon-1", { fetchImpl });
    assert.deepEqual(result, { outcome: "CREDENTIAL_INVALID" });
  });

  test("a GraphQL `errors` payload (200 status, but a real GraphQL error) is treated as CREDENTIAL_INVALID", async () => {
    connections.push(
      makeConnection({
        status: "REQUIRES_RECONNECT",
        hasSecret: true,
        accessToken: "shpat_x",
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
