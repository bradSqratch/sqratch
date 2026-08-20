process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.APP_ENCRYPTION_KEY = "test-encryption-key-for-scopes-update-tests";

/**
 * tests/shopify-scopes-update-webhook.test.ts
 *
 * Covers the `app/scopes_update` webhook route
 * (`src/app/api/shopify/webhooks/app/scopes_update/route.ts`) and the
 * compare-and-swap scope write it delegates to
 * (`applyGrantedScopesUpdate` in `src/lib/shopify-token-manager.ts`), plus the
 * scope-drift healing path (`healScopeDriftReconnect`).
 *
 * TESTING APPROACH — REAL CODE PATH, FAKE STORAGE.
 * Every case below drives the REAL exported `POST` through the REAL
 * `verifyShopifyWebhookRequest` and the REAL `applyGrantedScopesUpdate`.
 * Nothing about verification or the CAS write is stubbed.
 *
 * PHASE 14C-A: this route resolves identity SOLELY through canonical
 * `CommerceConnection` (`provider` + `externalAccountId`) — there is no
 * `Brand.shopify*` read or write anywhere in this path any more, so the fake
 * storage below models only the canonical `CommerceConnection` /
 * `CommerceConnectionSecret` tables, not `Brand`. The in-memory `updateMany`
 * faithfully evaluates the SAME `where` predicates Prisma would (AND across
 * `id`, `brandId`, `provider`, `externalAccountId`, and the `{ not: ... }`
 * status filter). That is what makes the tenant-isolation and CAS-scoping
 * assertions meaningful rather than tautological: a route that widened its
 * `where` would actually write more rows in this harness.
 *
 * Every "valid signature" case computes a GENUINE HMAC with node:crypto over
 * the exact raw body bytes — never a stubbed verifier. The healing tests use a
 * genuinely `encryptSecret`-encrypted payload so `loadShopifyCredential`
 * exercises real decryption, not a stub.
 *
 * DATABASE_URL above is a deliberately unroutable address (port 1). No test
 * here reaches a socket: the `commerceConnection` / `commerceConnectionSecret`
 * delegates are replaced before the route is imported, and `$transaction` is
 * replaced with an in-memory equivalent for the healing path's event record.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";

import { encryptSecret } from "../src/lib/crypto";

// ---------------------------------------------------------------------------
// In-memory CommerceConnection table + Prisma delegate stub
// ---------------------------------------------------------------------------

interface FakeConnection {
  id: string;
  brandId: string;
  provider: string;
  externalAccountId: string;
  status: string;
  grantedScopes: string[];
  providerClientId: string | null;
  /**
   * Whether a `CommerceConnectionSecret` row exists for this connection.
   * Present (`true`) alongside `REQUIRES_RECONNECT` only for a scope-drift
   * false alarm (a genuine credential failure always clears the secret in
   * the same write that sets `REQUIRES_RECONNECT` — see
   * `markRequiresReconnectCanonical` in `src/lib/shopify-token-manager.ts`).
   * `applyGrantedScopesUpdate` reads this presence directly (never decrypts)
   * to compute `wasScopeDriftReconnect`; `healScopeDriftReconnect`'s
   * `loadShopifyCredential` call decrypts it for real.
   */
  hasSecret: boolean;
}

interface FindUniqueArgs {
  where: { provider_externalAccountId: { provider: string; externalAccountId: string } };
}

interface UpdateManyArgs {
  where: {
    id?: string;
    brandId?: string;
    provider?: string;
    externalAccountId?: string;
    status?: string | { not?: string };
  };
  data: { grantedScopes?: string[]; status?: string };
}

let connections: FakeConnection[] = [];
let findUniqueCalls: FindUniqueArgs[] = [];
let updateManyCalls: UpdateManyArgs[] = [];
/** Per-test hooks so a race or a transient failure can be simulated. */
let onFindUnique: ((args: FindUniqueArgs) => void) | null = null;
let updateManyThrows: Error | null = null;

/**
 * Faithful (for the predicates this route uses) evaluation of a Prisma
 * `updateMany` where clause: every stated predicate must hold, AND-wise. A
 * `where` that omitted `id` would therefore genuinely match on domain alone
 * here — which is exactly the widening the CAS tests below are designed to
 * catch rather than assume away.
 */
function matchesConnectionWhere(conn: FakeConnection, where: UpdateManyArgs["where"]): boolean {
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

/** A validly `encryptSecret`-encrypted payload, decryptable by `loadShopifyCredential`. */
function validEncryptedSecretPayload(): string {
  return encryptSecret(
    JSON.stringify({
      accessToken: "shpat_scope_drift_test_token",
      accessTokenExpiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
      authMode: "LEGACY_OFFLINE",
    }),
  );
}

const commerceConnectionDelegateStub = {
  // Used by `applyGrantedScopesUpdate`'s identity resolution:
  // `(provider, externalAccountId)` -> `{id, brandId, status}`.
  findUnique: async (args: FindUniqueArgs) => {
    findUniqueCalls.push(args);
    const { provider, externalAccountId } = args.where.provider_externalAccountId;
    const match =
      connections.find(
        (conn) => conn.provider === provider && conn.externalAccountId === externalAccountId,
      ) ?? null;
    const result = match ? { id: match.id, brandId: match.brandId, status: match.status } : null;
    // Fires AFTER the row is resolved but BEFORE the caller can write, so a
    // test can mutate the table exactly in the window a real concurrent
    // transaction would.
    onFindUnique?.(args);
    return result;
  },
  // Used by `healShopifyCredentialConnected` (brandId+provider -> {id}) and
  // by `loadShopifyCredential` (brandId+provider -> full row + nested
  // secret). Returns the full shape (a superset of either real `select`) so
  // both callers see real values rather than `undefined`.
  findFirst: async (args: { where: { brandId: string; provider: string } }) => {
    const match =
      connections.find(
        (conn) => conn.brandId === args.where.brandId && conn.provider === args.where.provider,
      ) ?? null;
    if (!match) return null;
    return {
      id: match.id,
      brandId: match.brandId,
      status: match.status,
      externalAccountId: match.externalAccountId,
      providerClientId: match.providerClientId,
      grantedScopes: match.grantedScopes,
      secret: match.hasSecret ? { encryptedPayload: validEncryptedSecretPayload() } : null,
    };
  },
  // Backs BOTH the scope-cache CAS write (`applyGrantedScopesUpdate`) and the
  // status heal (`healShopifyCredentialConnected`) — the two real callers of
  // `commerceConnection.updateMany` on this path.
  updateMany: async (args: UpdateManyArgs) => {
    updateManyCalls.push(args);
    if (updateManyThrows) {
      throw updateManyThrows;
    }
    const matched = connections.filter((conn) => matchesConnectionWhere(conn, args.where));
    for (const conn of matched) {
      if (args.data.grantedScopes !== undefined) conn.grantedScopes = args.data.grantedScopes;
      if (args.data.status !== undefined) conn.status = args.data.status;
    }
    return { count: matched.length };
  },
};

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

const HEADER_HMAC = "x-shopify-hmac-sha256";
const HEADER_SHOP = "x-shopify-shop-domain";
const HEADER_TOPIC = "x-shopify-topic";

const SECRET = "test-scopes-update-webhook-secret-4f19";
const ROUTE_URL = "http://localhost/api/shopify/webhooks/app/scopes_update";

const SHOP_A = "brand-a-shop.myshopify.com";
const SHOP_B = "brand-b-shop.myshopify.com";

function computeHmac(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

async function withShopifyApiSecret<T>(
  secret: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const original = process.env.SHOPIFY_API_SECRET;
  if (secret === undefined) {
    delete process.env.SHOPIFY_API_SECRET;
  } else {
    process.env.SHOPIFY_API_SECRET = secret;
  }
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

interface RequestOptions {
  rawBody: string;
  hmac?: string;
  shopDomain?: string;
  topic?: string;
}

function buildRequest(options: RequestOptions): NextRequest {
  const headers = new Headers();
  if (options.hmac !== undefined) headers.set(HEADER_HMAC, options.hmac);
  if (options.shopDomain !== undefined) headers.set(HEADER_SHOP, options.shopDomain);
  if (options.topic !== undefined) headers.set(HEADER_TOPIC, options.topic);
  return new NextRequest(ROUTE_URL, { method: "POST", headers, body: options.rawBody });
}

/** Signs the body for real and posts it. */
function signedRequest(body: unknown, shopDomain: string | undefined): NextRequest {
  const rawBody = JSON.stringify(body);
  return buildRequest({ rawBody, hmac: computeHmac(rawBody, SECRET), shopDomain });
}

async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    const result = await fn();
    return { result, logged };
  } finally {
    console.log = originalLog;
  }
}

const REPO_ROOT = process.cwd();
function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

function connectionFor(brandId: string): FakeConnection {
  const found = connections.find((c) => c.brandId === brandId);
  assert.ok(found, `expected fixture connection for ${brandId}`);
  return found!;
}

// ---------------------------------------------------------------------------
// Module wiring: replace the commerceConnection delegate BEFORE importing
// the route.
// ---------------------------------------------------------------------------

let POST: (request: NextRequest) => Promise<Response>;
let extractCurrentScopes: (payload: unknown) => string | null;

before(async () => {
  const prismaModule = (await import("../src/lib/prisma"))
    .default as unknown as Record<string, unknown>;
  prismaModule.commerceConnection = commerceConnectionDelegateStub;
  prismaModule.commerceConnectionSecret = {
    findUnique: async (args: { where: { connectionId: string } }) => {
      const match = connections.find((conn) => conn.id === args.where.connectionId);
      return match && match.hasSecret ? { connectionId: match.id } : null;
    },
  };
  prismaModule.$transaction = fakeTransaction;

  const route = await import("../src/app/api/shopify/webhooks/app/scopes_update/route");
  POST = route.POST as unknown as (request: NextRequest) => Promise<Response>;
  extractCurrentScopes = route.extractCurrentScopes;
});

let connectionEventCreateCalls: Array<{ brandId: string; eventType: string }> = [];

beforeEach(() => {
  connections = [
    {
      id: "connection-a",
      brandId: "brand-a",
      provider: "SHOPIFY",
      externalAccountId: SHOP_A,
      status: "CONNECTED",
      grantedScopes: ["read_products", "read_discounts", "write_discounts"],
      providerClientId: "abcdef0123456789abcdef0123456789",
      hasSecret: true,
    },
    {
      id: "connection-b",
      brandId: "brand-b",
      provider: "SHOPIFY",
      externalAccountId: SHOP_B,
      status: "CONNECTED",
      grantedScopes: ["read_products"],
      providerClientId: "abcdef0123456789abcdef0123456789",
      hasSecret: true,
    },
  ];
  findUniqueCalls = [];
  updateManyCalls = [];
  onFindUnique = null;
  updateManyThrows = null;
  connectionEventCreateCalls = [];
});

/**
 * Backs `healScopeDriftReconnect`'s transaction (`recordShopifyConnectionInstall`).
 * Shares the SAME `connections` in-memory table as the non-transactional
 * stubs above (a real Postgres transaction would see the same committed rows
 * either way), so a heal triggered through this mock is genuinely observable
 * via `connectionFor("brand-a")` afterward, not merely asserted against a
 * separate, disconnected fixture. `recordShopifyConnectionInstall` never
 * touches `Brand` — only reward offers and the connection-history event.
 */
async function fakeTransaction<T>(
  fn: (tx: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const tx = {
    // recordShopifyConnectionInstall deactivates reward offers before
    // recording the event (existing, deliberate behavior for every
    // install/reconnect/relink — see shopify-connection-transitions.ts).
    // Present here purely so that call does not throw; this suite has no
    // reward-offer fixtures to assert against.
    brandRewardOffer: {
      updateMany: async () => ({ count: 0 }),
    },
    shopifyConnectionEvent: {
      create: async (args: { data: { brandId: string; eventType: string } }) => {
        connectionEventCreateCalls.push({
          brandId: args.data.brandId,
          eventType: args.data.eventType,
        });
        return {};
      },
    },
  };
  return fn(tx);
}

// ---------------------------------------------------------------------------
// 1. Valid HMAC + known shop -> 200 and the canonical scopes match `current`.
// ---------------------------------------------------------------------------

describe("1. valid signature + known shop domain synchronizes the canonical scopes", () => {
  test("200 and CommerceConnection.grantedScopes becomes the `current` list", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const payload = {
        id: 9001,
        shop_id: "gid://shopify/Shop/1",
        previous: ["read_products", "read_discounts", "write_discounts"],
  current: ["read_products", "read_orders", "read_themes", "read_discounts", "write_discounts"],
        updated_at: "2026-08-16T10:00:00Z",
      };

      const { result: response } = await captureConsole(() =>
        POST(signedRequest(payload, SHOP_A)),
      );

      assert.equal(response.status, 200);
      assert.equal(await response.text(), "");
      assert.deepEqual(connectionFor("brand-a").grantedScopes, [
        "read_products",
        "read_orders",
        "read_themes",
        "read_discounts",
        "write_discounts",
      ]);
    });
  });

  test("the shop domain header is matched case-insensitively, exactly as the sibling routes normalize it", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const { result: response, logged } = await captureConsole(() =>
        POST(signedRequest({ current: ["read_orders"] }, "BRAND-A-Shop.MyShopify.com")),
      );

      assert.equal(response.status, 200);
      assert.deepEqual(connectionFor("brand-a").grantedScopes, ["read_orders"]);
      // The lookup key handed to Prisma is the normalized form, never the raw header.
      assert.equal(
        findUniqueCalls[0].where.provider_externalAccountId.externalAccountId,
        SHOP_A,
      );
      const line = logged.find((l) => l.includes("app/scopes_update"));
      assert.ok(line, "expected a sanitized audit log line");
      assert.equal((JSON.parse(line!) as { shopDomain?: string }).shopDomain, SHOP_A);
    });
  });

  test("an empty `current` array is honored as a real revocation, stored as an empty scope list", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const response = (await captureConsole(() => POST(signedRequest({ current: [] }, SHOP_A))))
        .result;

      assert.equal(response.status, 200);
      assert.deepEqual(connectionFor("brand-a").grantedScopes, []);
    });
  });

  test("repeating the identical delivery is idempotent — the second write lands the same value", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const payload = { current: ["read_products", "read_orders"] };
      await captureConsole(() => POST(signedRequest(payload, SHOP_A)));
      await captureConsole(() => POST(signedRequest(payload, SHOP_A)));

      assert.deepEqual(connectionFor("brand-a").grantedScopes, ["read_products", "read_orders"]);
      assert.equal(updateManyCalls.length, 2);
    });
  });

  // -------------------------------------------------------------------------
  // C. PHASE 14C-A tripwire — this route (and, transitively, the writers it
  // calls) must never reintroduce a runtime read/write of any Brand.shopify*
  // field. Canonical `CommerceConnection` is the sole authority; there is no
  // legacy fallback left to bypass.
  // -------------------------------------------------------------------------
  test("C. PHASE 14C-A tripwire: the route never references a Brand.shopify* field", () => {
    const source = readSource("src/app/api/shopify/webhooks/app/scopes_update/route.ts");
    assert.doesNotMatch(
      source,
      /\bshopify(ShopDomain|AdminAccessTokenEncrypted|InstalledAt|LastProductSyncAt|DisconnectedAt|UninstalledAt|ConnectionStatus|CurrencyCode|AccessTokenExpiresAt|AuthMode|ClientId|GrantedScopes|RefreshTokenEncrypted|RefreshTokenExpiresAt|TokenRefreshLockId|TokenRefreshLockedUntil)\b/,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Invalid / missing HMAC -> 401 and NO write.
// ---------------------------------------------------------------------------

describe("2. signature failure rejects with 401 before any storage access", () => {
  test("an invalid signature returns 401 and never reads or writes a connection row", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const rawBody = JSON.stringify({ current: ["read_orders"] });
      const response = await POST(
        buildRequest({
          rawBody,
          hmac: computeHmac(rawBody, "a-completely-different-secret"),
          shopDomain: SHOP_A,
        }),
      );

      assert.equal(response.status, 401);
      assert.equal(findUniqueCalls.length, 0);
      assert.equal(updateManyCalls.length, 0);
      assert.deepEqual(connectionFor("brand-a").grantedScopes, [
        "read_products",
        "read_discounts",
        "write_discounts",
      ]);
    });
  });

  test("a missing signature header returns 401 and never reads or writes a connection row", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const response = await POST(
        buildRequest({
          rawBody: JSON.stringify({ current: ["read_orders"] }),
          shopDomain: SHOP_A,
        }),
      );

      assert.equal(response.status, 401);
      assert.equal(findUniqueCalls.length, 0);
      assert.equal(updateManyCalls.length, 0);
    });
  });

  test("a signature valid for a DIFFERENT body cannot authorize this body (no byte substitution)", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const signedBody = JSON.stringify({ current: ["read_products"] });
      const swappedBody = JSON.stringify({ current: ["read_orders", "write_discounts"] });
      const response = await POST(
        buildRequest({
          rawBody: swappedBody,
          hmac: computeHmac(signedBody, SECRET),
          shopDomain: SHOP_A,
        }),
      );

      assert.equal(response.status, 401);
      assert.equal(updateManyCalls.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Valid HMAC + unknown shop -> 200, deterministic no-op.
// ---------------------------------------------------------------------------

describe("3. an unknown shop is a deterministic no-op, acknowledged with 200", () => {
  test("unknown shop domain: 200, lookup attempted, no write, no other row disturbed", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const { result: response, logged } = await captureConsole(() =>
        POST(signedRequest({ current: ["read_orders"] }, "never-installed.myshopify.com")),
      );

      assert.equal(response.status, 200);
      assert.equal(findUniqueCalls.length, 1);
      assert.equal(updateManyCalls.length, 0);
      assert.deepEqual(connectionFor("brand-a").grantedScopes, [
        "read_products",
        "read_discounts",
        "write_discounts",
      ]);
      assert.deepEqual(connectionFor("brand-b").grantedScopes, ["read_products"]);
      const line = logged.find((l) => l.includes("app/scopes_update"));
      assert.equal((JSON.parse(line!) as { outcome?: string }).outcome, "UNKNOWN_SHOP");
    });
  });

  test("no shop domain header at all: 200, and no storage access whatsoever", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const rawBody = JSON.stringify({ current: ["read_orders"] });
      const { result: response } = await captureConsole(() =>
        POST(buildRequest({ rawBody, hmac: computeHmac(rawBody, SECRET) })),
      );

      assert.equal(response.status, 200);
      assert.equal(findUniqueCalls.length, 0);
      assert.equal(updateManyCalls.length, 0);
    });
  });

  test("malformed JSON with a genuinely valid signature: 200, never 500, and no write", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const rawBody = "{not valid json at all";
      const { result: response } = await captureConsole(() =>
        POST(buildRequest({ rawBody, hmac: computeHmac(rawBody, SECRET), shopDomain: SHOP_A })),
      );

      assert.equal(response.status, 200);
      assert.equal(updateManyCalls.length, 0);
      assert.deepEqual(connectionFor("brand-a").grantedScopes, [
        "read_products",
        "read_discounts",
        "write_discounts",
      ]);
    });
  });

  test("a verified payload with no usable `current` list writes nothing", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      for (const payload of [
        { previous: ["read_products"] },
        { current: "read_products,read_orders" },
        { current: ["read_products", 42] },
        { current: null },
      ]) {
        updateManyCalls = [];
        const { result: response } = await captureConsole(() =>
          POST(signedRequest(payload, SHOP_A)),
        );
        assert.equal(response.status, 200, `expected 200 for ${JSON.stringify(payload)}`);
        assert.equal(
          updateManyCalls.length,
          0,
          `expected no write for ${JSON.stringify(payload)}`,
        );
      }
      assert.deepEqual(connectionFor("brand-a").grantedScopes, [
        "read_products",
        "read_discounts",
        "write_discounts",
      ]);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. TENANT ISOLATION.
// ---------------------------------------------------------------------------

describe("4. tenant isolation: a signed payload for shop A can never reach brand B", () => {
  /**
   * The payload is genuinely, correctly signed for Brand A's shop domain, and
   * every field an attacker (or a confused integration) might hope is used for
   * row selection is set to point at Brand B: `shop_id`, `id`, `brand_id`,
   * `shop_domain`, `myshopify_domain`, even a nested `brand` object. The route
   * reads NONE of them — the only identity input is the verified
   * `X-Shopify-Shop-Domain` header — so Brand B must come out byte-identical.
   */
  test("adversarial body fields naming brand B are ignored; only brand A is written", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const payload = {
        id: "brand-b",
        shop_id: "brand-b",
        brand_id: "brand-b",
        brandId: "brand-b",
        shop_domain: SHOP_B,
        myshopify_domain: SHOP_B,
        shop: SHOP_B,
        brand: { id: "brand-b", shopifyShopDomain: SHOP_B },
        previous: ["read_products"],
        current: ["read_products", "read_orders"],
      };

      const { result: response } = await captureConsole(() =>
        POST(signedRequest(payload, SHOP_A)),
      );

      assert.equal(response.status, 200);
      // A got the new list...
      assert.deepEqual(connectionFor("brand-a").grantedScopes, ["read_products", "read_orders"]);
      // ...and B is untouched, exactly as seeded.
      assert.deepEqual(connectionFor("brand-b").grantedScopes, ["read_products"]);
      assert.equal(connectionFor("brand-b").status, "CONNECTED");
      assert.equal(connectionFor("brand-b").externalAccountId, SHOP_B);
    });
  });

  test("the header, not the body, decides the tenant — signing for B writes B and leaves A alone", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const payload = { shop_domain: SHOP_A, id: "brand-a", current: ["read_orders"] };

      const { result: response } = await captureConsole(() =>
        POST(signedRequest(payload, SHOP_B)),
      );

      assert.equal(response.status, 200);
      assert.deepEqual(connectionFor("brand-b").grantedScopes, ["read_orders"]);
      assert.deepEqual(connectionFor("brand-a").grantedScopes, [
        "read_products",
        "read_discounts",
        "write_discounts",
      ]);
    });
  });

  test("exactly one row is ever matched by the write", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      await captureConsole(() => POST(signedRequest({ current: ["read_orders"] }, SHOP_A)));

      assert.equal(updateManyCalls.length, 1);
      const matched = connections.filter((c) => matchesConnectionWhere(c, updateManyCalls[0].where));
      assert.deepEqual(
        matched.map((c) => c.brandId),
        ["brand-a"],
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 5. The CAS write is scoped by the RESOLVED ROW'S OWN ID.
// ---------------------------------------------------------------------------

describe("5. the scope write is a compare-and-swap pinned to the resolved row's id", () => {
  test("the updateMany where clause carries the resolved connection's own id plus the CAS guards, and nothing else", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      await captureConsole(() => POST(signedRequest({ current: ["read_orders"] }, SHOP_A)));

      assert.equal(updateManyCalls.length, 1);
      const { where, data } = updateManyCalls[0];

      // Pinned to the CONNECTION resolved from the VERIFIED shop domain — not
      // to the domain string alone, and not to anything the payload supplied.
      assert.equal(where.id, "connection-a");
      assert.equal(where.brandId, "brand-a");
      assert.equal(where.provider, "SHOPIFY");
      assert.equal(where.externalAccountId, SHOP_A);
      assert.deepEqual(where.status, { not: "UNINSTALLED" });
      assert.deepEqual(Object.keys(where).sort(), [
        "brandId",
        "externalAccountId",
        "id",
        "provider",
        "status",
      ]);

      // And the write itself touches ONLY the cached scope column — no status
      // transition, no token field, no other column.
      assert.deepEqual(Object.keys(data), ["grantedScopes"]);
    });
  });

  test("a relink race between the lookup and the write matches nothing: SUPERSEDED, 200, no cross-write", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      // Simulate a concurrent relink/redact: the row's domain moves out from
      // under us AFTER it was resolved. The CAS guard must make the write a
      // no-op rather than landing on a shop it was not authenticated for.
      onFindUnique = () => {
        connectionFor("brand-a").externalAccountId = "relinked-elsewhere.myshopify.com";
      };

      const { result: response, logged } = await captureConsole(() =>
        POST(signedRequest({ current: ["read_orders"] }, SHOP_A)),
      );

      assert.equal(response.status, 200);
      assert.equal(updateManyCalls.length, 1);
      assert.deepEqual(connectionFor("brand-a").grantedScopes, [
        "read_products",
        "read_discounts",
        "write_discounts",
      ]);
      assert.deepEqual(connectionFor("brand-b").grantedScopes, ["read_products"]);
      const line = logged.find((l) => l.includes("app/scopes_update"));
      assert.equal((JSON.parse(line!) as { outcome?: string }).outcome, "SUPERSEDED");
    });
  });

  test("a late delivery cannot resurrect scopes on an already-uninstalled row", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      // app/uninstalled ran first: it clears scopes but PRESERVES the domain.
      connectionFor("brand-a").status = "UNINSTALLED";
      connectionFor("brand-a").grantedScopes = [];

      const { result: response } = await captureConsole(() =>
        POST(signedRequest({ current: ["read_products", "read_orders"] }, SHOP_A)),
      );

      assert.equal(response.status, 200);
      assert.deepEqual(connectionFor("brand-a").grantedScopes, []);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Retry semantics: transient storage failure -> 500.
// ---------------------------------------------------------------------------

describe("6. only a transient storage failure asks Shopify to retry", () => {
  test("a thrown DB error returns 500 so the delivery is retried", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      updateManyThrows = new Error("connection terminated unexpectedly");

      const { result: response, logged } = await captureConsole(() =>
        POST(signedRequest({ current: ["read_orders"] }, SHOP_A)),
      );

      assert.equal(response.status, 500);
      const line = logged.find((l) => l.includes("app/scopes_update"));
      assert.equal((JSON.parse(line!) as { outcome?: string }).outcome, "WRITE_FAILED");
      // The failure text must not leak into the log line.
      assert.ok(!logged.join("\n").includes("connection terminated"));
    });
  });

  test("the same delivery succeeds on retry once storage recovers", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const payload = { current: ["read_products", "read_orders"] };

      updateManyThrows = new Error("transient");
      const first = (await captureConsole(() => POST(signedRequest(payload, SHOP_A)))).result;
      assert.equal(first.status, 500);

      updateManyThrows = null;
      const second = (await captureConsole(() => POST(signedRequest(payload, SHOP_A)))).result;
      assert.equal(second.status, 200);
      assert.deepEqual(connectionFor("brand-a").grantedScopes, ["read_products", "read_orders"]);
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Payload extraction (pure).
// ---------------------------------------------------------------------------

describe("7. extractCurrentScopes reads only the post-change `current` list", () => {
  test("reads `current`, ignores `previous`, and joins in storage form", () => {
    assert.equal(
      extractCurrentScopes({
        previous: ["read_products"],
        current: ["read_products", "read_orders"],
      }),
      "read_products,read_orders",
    );
  });

  test("trims handles and drops empty entries", () => {
    assert.equal(
      extractCurrentScopes({ current: ["  read_products ", "", "read_orders"] }),
      "read_products,read_orders",
    );
  });

  test("returns null for every shape that is not a `current` string array", () => {
    for (const payload of [
      null,
      undefined,
      "read_products",
      42,
      [],
      ["read_products"],
      {},
      { current: null },
      { current: "read_products" },
      { current: { 0: "read_products" } },
      { current: ["read_products", null] },
      { current: ["read_products", { scope: "read_orders" }] },
    ]) {
      assert.equal(
        extractCurrentScopes(payload),
        null,
        `expected null for ${JSON.stringify(payload)}`,
      );
    }
  });

  test("an empty array is a valid empty grant, not a malformed payload", () => {
    assert.equal(extractCurrentScopes({ current: [] }), "");
  });

  test("the produced string is exactly what the scope readers consume", async () => {
    const { hasSufficientScopes, hasOrderAttributionScope } = await import(
      "../src/lib/shopify-token-manager"
    );
    const full = extractCurrentScopes({
      current: ["read_products", "read_orders", "read_themes", "read_discounts", "write_discounts"],
    });
    assert.equal(hasSufficientScopes(full), true);
    assert.equal(hasOrderAttributionScope(full), true);

    const withoutOrders = extractCurrentScopes({
      current: ["read_products", "read_themes", "read_discounts", "write_discounts"],
    });
    assert.equal(hasSufficientScopes(withoutOrders), true);
    assert.equal(hasOrderAttributionScope(withoutOrders), false);

    assert.equal(hasSufficientScopes(extractCurrentScopes({ current: [] })), false);
  });
});

// ---------------------------------------------------------------------------
// 8. Configuration + design locks.
// ---------------------------------------------------------------------------

describe("8. the topic is declared in both configs and bound to this route by PATH", () => {
  test("both Shopify configs subscribe app/scopes_update to this route's dedicated URI", () => {
    for (const file of ["shopify.app.toml", "shopify.app.custom.toml"]) {
      const source = readSource(file);
      const uris = [...source.matchAll(/uri = "([^"]+)"/g)].map((m) => m[1]);
      const scopesUpdateUris = uris.filter((uri) =>
        uri.endsWith("/api/shopify/webhooks/app/scopes_update"),
      );
      assert.equal(scopesUpdateUris.length, 1, `expected exactly one app/scopes_update URI in ${file}`);
      assert.match(source, /topics = \[ "app\/scopes_update" \]/);
      // It is an app-lifecycle topic, not a GDPR compliance topic.
      assert.doesNotMatch(source, /compliance_topics = \[ "app\/scopes_update" \]/);
    }
  });

  test("the route never dispatches on the spoofable x-shopify-topic header", () => {
    const source = readSource("src/app/api/shopify/webhooks/app/scopes_update/route.ts");
    assert.doesNotMatch(source, /request\.headers\.get\(\s*["']x-shopify-topic/i);
  });

  test("a forged x-shopify-topic header changes nothing about what this route does", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const rawBody = JSON.stringify({ current: ["read_orders"] });
      const { result: response, logged } = await captureConsole(() =>
        POST(
          buildRequest({
            rawBody,
            hmac: computeHmac(rawBody, SECRET),
            shopDomain: SHOP_A,
            topic: "app/uninstalled", // forged
          }),
        ),
      );

      assert.equal(response.status, 200);
      assert.deepEqual(connectionFor("brand-a").grantedScopes, ["read_orders"]);
      const line = logged.find((l) => l.includes('"topic"'));
      assert.equal((JSON.parse(line!) as { topic?: string }).topic, "app/scopes_update");
    });
  });

  test("this webhook performs no authorization decision — it is a passive cache sync, plus one narrowly-scoped healing exception", () => {
    const source = readSource("src/app/api/shopify/webhooks/app/scopes_update/route.ts");
    // No connection-LOSS side effects, no reward/points side effects, and no
    // token decryption/mutation of any kind — the scope-drift eligibility
    // check (token PRESENCE, not value) and the healing CAS write both live
    // in shopify-token-manager.ts (`applyGrantedScopesUpdate`'s
    // `wasScopeDriftReconnect` + `healScopeDriftReconnect`), never inline
    // here. This route only ever branches on the ALREADY-COMPUTED boolean.
    assert.doesNotMatch(source, /shopifyConnectionStatus:\s*"/);
    assert.doesNotMatch(source, /recordShopifyConnectionLoss/);
    assert.doesNotMatch(source, /brandRewardOffer/);
    assert.doesNotMatch(source, /decryptSecret|encryptSecret/);
    // The one sanctioned exception, and only that one:
    assert.match(source, /healScopeDriftReconnect/);
  });
});

// ---------------------------------------------------------------------------
// 9. Healing: a scope-drift REQUIRES_RECONNECT is healed back to CONNECTED.
// ---------------------------------------------------------------------------

describe("9. healing a scope-drift false REQUIRES_RECONNECT", () => {
  test("a REQUIRES_RECONNECT connection with a secret still on file is healed to CONNECTED, with a RECONNECTED event", async () => {
    connectionFor("brand-a").status = "REQUIRES_RECONNECT";
    // hasSecret deliberately stays true (see the FakeConnection doc comment)
    // — this is the scope-drift signature, never a genuine credential failure.

    const rawBody = JSON.stringify({ current: ["read_products", "read_orders", "read_discounts", "write_discounts"] });
    const response = await withShopifyApiSecret(SECRET, () =>
      POST(signedRequest(JSON.parse(rawBody), SHOP_A)),
    );

    assert.equal(response.status, 200);
    assert.equal(
      connectionFor("brand-a").status,
      "CONNECTED",
      "a scope-drift REQUIRES_RECONNECT must heal once new scopes are applied",
    );
    assert.deepEqual(connectionFor("brand-a").grantedScopes, [
      "read_products",
      "read_orders",
      "read_discounts",
      "write_discounts",
    ]);
    assert.equal(connectionEventCreateCalls.length, 1);
    assert.equal(connectionEventCreateCalls[0]!.brandId, "brand-a");
    assert.equal(connectionEventCreateCalls[0]!.eventType, "RECONNECTED");
  });

  test("a REQUIRES_RECONNECT connection with NO secret on file (a genuine failure) is never healed", async () => {
    connectionFor("brand-a").status = "REQUIRES_RECONNECT";
    connectionFor("brand-a").hasSecret = false;

    const response = await withShopifyApiSecret(SECRET, () =>
      POST(signedRequest({ current: ["read_products", "read_orders"] }, SHOP_A)),
    );

    assert.equal(response.status, 200);
    assert.equal(
      connectionFor("brand-a").status,
      "REQUIRES_RECONNECT",
      "a genuine credential failure (secret already cleared) must never be healed by this webhook",
    );
    assert.equal(connectionEventCreateCalls.length, 0);
    // The scope cache is still updated — this webhook's cache-sync job is
    // unconditional; only the STATUS heal is gated on the scope-drift proof.
    assert.deepEqual(connectionFor("brand-a").grantedScopes, ["read_products", "read_orders"]);
  });

  test("an already-CONNECTED connection is never touched by the healing path (no spurious event)", async () => {
    // brand-a starts CONNECTED (see beforeEach).
    const response = await withShopifyApiSecret(SECRET, () =>
      POST(signedRequest({ current: ["read_products", "read_discounts", "write_discounts"] }, SHOP_A)),
    );

    assert.equal(response.status, 200);
    assert.equal(connectionFor("brand-a").status, "CONNECTED");
    assert.equal(
      connectionEventCreateCalls.length,
      0,
      "healing must never fire, and no event must be recorded, for a connection that was never REQUIRES_RECONNECT",
    );
  });

  test("healing tenant isolation: a signed payload for shop A's scope-drift row never heals or events brand B", async () => {
    connectionFor("brand-a").status = "REQUIRES_RECONNECT";
    connectionFor("brand-b").status = "REQUIRES_RECONNECT";
    connectionFor("brand-b").grantedScopes = ["read_products"];

    const response = await withShopifyApiSecret(SECRET, () =>
      POST(signedRequest({ current: ["read_products", "read_orders"] }, SHOP_A)),
    );

    assert.equal(response.status, 200);
    assert.equal(connectionFor("brand-a").status, "CONNECTED");
    assert.equal(
      connectionFor("brand-b").status,
      "REQUIRES_RECONNECT",
      "a delivery naming shop A must never heal, event, or otherwise touch brand B's row",
    );
    assert.deepEqual(connectionFor("brand-b").grantedScopes, ["read_products"]);
    assert.equal(connectionEventCreateCalls.length, 1);
    assert.equal(connectionEventCreateCalls[0]!.brandId, "brand-a");
  });
});
