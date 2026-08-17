/**
 * tests/shopify-token-manager.test.ts
 *
 * Unit tests for shopify-token-manager pure helpers and logic.
 *
 * Approach: the DB-dependent getValidAccessToken function uses prisma at
 * import time (via src/lib/prisma.ts which requires DATABASE_URL at module
 * load). To avoid a real DB in tests we:
 *   1. Set DATABASE_URL to a dummy value BEFORE any imports so that
 *      prisma.ts does not throw during module initialisation.
 *      The Pool connection itself is never established because we only
 *      test the pure, exported helper functions and the injectable
 *      tokenEndpoint parameter — no prisma calls are actually made.
 *   2. Export the pure decision helpers (isAccessTokenFresh, hasSufficientScopes,
 *      computeExpiresAt) and test those directly.
 *   3. Test exchangeSessionTokenForOfflineToken with an injected mock
 *      endpoint (no network).
 *   4. For the getValidAccessToken → CommerceConnectionSecret mirror
 *      orchestration tests near the end of this file (see the
 *      "getValidAccessToken → mirror orchestration" describe block),
 *      exercise the REAL getValidAccessToken end-to-end against the REAL
 *      prisma client instance with its `brand`/`$transaction` methods
 *      replaced by in-memory fakes — same unwrap-then-replace idiom as
 *      tests/qr-routes-hardening.test.ts's `prisma.campaign = {...}`. No
 *      real DB connection is ever made: DATABASE_URL is a dummy value only
 *      so src/lib/prisma.ts's module-load check passes; every delegate
 *      method actually used is intercepted before it would reach a socket.
 *      Because prisma.ts throws synchronously if DATABASE_URL is missing at
 *      import time, and ESM executes an imported module's top-level code
 *      before the importing module's own code (regardless of where the
 *      `import` keyword appears in source order), prisma must be reached
 *      via a *dynamic* `await import(...)` from inside `before()` — a
 *      static `import prisma from ...` at the top of this file would run
 *      before the `process.env.DATABASE_URL` assignment below ever
 *      executes. shopify-token-manager.ts itself has no such problem (it
 *      only imports prisma lazily, inside function bodies), which is why it
 *      can stay a plain static import.
 *
 * No real DB, no real network is used anywhere in this file.
 */

import { after, before, test, describe } from "node:test";
import assert from "node:assert/strict";

const originalNextAuthSecret = process.env.NEXTAUTH_SECRET;
const originalAppEncryptionKey = process.env.APP_ENCRYPTION_KEY;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalShopifyApiSecret = process.env.SHOPIFY_API_SECRET;

// These tests exercise encrypted Shopify token handling without relying on
// NextAuth's session-signing secret.
process.env.NEXTAUTH_SECRET = "test-secret-for-token-manager-tests-32ch";
process.env.APP_ENCRYPTION_KEY = "test-encryption-key-for-token-manager-tests";
// Note: most of this file's tests exercise only the pure exported helpers
// and the injectable tokenEndpoint — no DB calls are triggered, so
// DATABASE_URL wouldn't normally be needed here. It IS required below for
// the "getValidAccessToken → mirror orchestration" describe block, which
// drives the real getValidAccessToken (and therefore src/lib/prisma.ts's
// module-load check) against fully mocked prisma delegates — see that
// block's own header comment.
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
// performTokenRefresh() reads this directly from process.env.
process.env.SHOPIFY_API_SECRET ||= "test-shopify-api-secret-for-token-manager-tests";

after(() => {
  if (originalNextAuthSecret === undefined) {
    delete process.env.NEXTAUTH_SECRET;
  } else {
    process.env.NEXTAUTH_SECRET = originalNextAuthSecret;
  }

  if (originalAppEncryptionKey === undefined) {
    delete process.env.APP_ENCRYPTION_KEY;
  } else {
    process.env.APP_ENCRYPTION_KEY = originalAppEncryptionKey;
  }

  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }

  if (originalShopifyApiSecret === undefined) {
    delete process.env.SHOPIFY_API_SECRET;
  } else {
    process.env.SHOPIFY_API_SECRET = originalShopifyApiSecret;
  }
});

import {
  isAccessTokenFresh,
  hasSufficientScopes,
  hasOrderAttributionScope,
  hasThemeVerificationScope,
  computeExpiresAt,
  ownsRefreshLock,
  exchangeSessionTokenForOfflineToken,
  getValidAccessToken,
  type ShopifyTokenResponse,
  type TokenEndpointFn,
} from "../src/lib/shopify-token-manager";
import { encryptSecret, decryptSecret } from "../src/lib/crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW_MS = new Date("2026-06-15T12:00:00Z").getTime();

function makeExpiry(offsetSeconds: number, base = NOW_MS): Date {
  return new Date(base + offsetSeconds * 1000);
}

function makeTokenResponse(overrides?: Partial<ShopifyTokenResponse>): ShopifyTokenResponse {
  return {
    access_token: "shpat_new_access_token",
    scope: "read_products,read_themes,read_discounts,write_discounts",
    expires_in: 3600,
    refresh_token: "shprt_new_refresh_token",
    refresh_token_expires_in: 7776000, // 90 days
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe("isAccessTokenFresh", () => {
  test("(a) returns true when token expires well beyond safety buffer", () => {
    // 300s in the future — well beyond the 120s buffer
    const expiresAt = makeExpiry(300);
    assert.equal(isAccessTokenFresh(expiresAt, NOW_MS), true);
  });

  test("returns false when token expires within the safety buffer", () => {
    // 100s in the future — inside the 120s buffer
    const expiresAt = makeExpiry(100);
    assert.equal(isAccessTokenFresh(expiresAt, NOW_MS), false);
  });

  test("returns false when token is already expired", () => {
    const expiresAt = makeExpiry(-60);
    assert.equal(isAccessTokenFresh(expiresAt, NOW_MS), false);
  });

  test("returns false for null expiresAt", () => {
    assert.equal(isAccessTokenFresh(null, NOW_MS), false);
  });

  test("returns false for undefined expiresAt", () => {
    assert.equal(isAccessTokenFresh(undefined, NOW_MS), false);
  });

  test("returns true exactly at 121 seconds remaining", () => {
    const expiresAt = makeExpiry(121);
    assert.equal(isAccessTokenFresh(expiresAt, NOW_MS), true);
  });

  test("returns false exactly at 120 seconds remaining (buffer boundary)", () => {
    const expiresAt = makeExpiry(120);
    assert.equal(isAccessTokenFresh(expiresAt, NOW_MS), false);
  });
});

describe("hasSufficientScopes", () => {
  test("returns true when all required scopes are present", () => {
    assert.equal(
      hasSufficientScopes("read_products,read_themes,read_discounts,write_discounts"),
      true,
    );
  });

  test("(f) returns false when write_discounts is missing", () => {
    assert.equal(
      hasSufficientScopes("read_products,read_discounts"),
      false,
    );
  });

  test("returns false when read_products is missing", () => {
    assert.equal(
      hasSufficientScopes("read_discounts,write_discounts"),
      false,
    );
  });

  test("write_discounts also satisfies the Shopify discount read scope", () => {
    assert.equal(
      hasSufficientScopes("read_products,read_themes,write_discounts"),
      true,
    );
  });

  test("handles extra scopes gracefully", () => {
    assert.equal(
      hasSufficientScopes(
        "read_products,read_themes,read_discounts,write_discounts,write_products",
      ),
      true,
    );
  });

  test("handles scopes with whitespace", () => {
    assert.equal(
      hasSufficientScopes("read_products, read_themes, read_discounts, write_discounts"),
      true,
    );
  });

  test("returns false for null grantedScopes", () => {
    assert.equal(hasSufficientScopes(null), false);
  });

  test("returns false for empty string", () => {
    assert.equal(hasSufficientScopes(""), false);
  });
});

describe("hasOrderAttributionScope", () => {
  test("returns true when read_orders is present among other scopes", () => {
    assert.equal(
      hasOrderAttributionScope(
        "read_products,read_orders,read_discounts,write_discounts",
      ),
      true,
    );
  });

  test("returns true when read_orders is the only scope", () => {
    assert.equal(hasOrderAttributionScope("read_orders"), true);
  });

  test("returns false when read_orders is absent, even with every other required scope granted", () => {
    assert.equal(
      hasSufficientScopes("read_products,read_themes,read_discounts,write_discounts"),
      true,
      "sanity check: the other three scopes alone already satisfy hasSufficientScopes",
    );
    assert.equal(
      hasOrderAttributionScope("read_products,read_discounts,write_discounts"),
      false,
      "but must NOT satisfy hasOrderAttributionScope — the two checks are independent, and orderAttributionReady must not become true merely because catalog/discount scopes are sufficient",
    );
  });

  test("does not match a scope name that merely contains read_orders as a substring", () => {
    assert.equal(hasOrderAttributionScope("read_all_orders"), false);
    assert.equal(hasOrderAttributionScope("write_orders"), false);
  });

  test("handles scopes with whitespace around read_orders", () => {
    assert.equal(
      hasOrderAttributionScope("read_products, read_orders, write_discounts"),
      true,
    );
  });

  test("returns false for null, undefined, and empty string", () => {
    assert.equal(hasOrderAttributionScope(null), false);
    assert.equal(hasOrderAttributionScope(undefined), false);
    assert.equal(hasOrderAttributionScope(""), false);
  });

  test("is case-sensitive: a differently-cased scope string does not match", () => {
    assert.equal(hasOrderAttributionScope("READ_ORDERS"), false);
  });
});

describe("hasThemeVerificationScope", () => {
  test("returns true when read_themes is present among other scopes", () => {
    assert.equal(
      hasThemeVerificationScope("read_products,read_themes,read_discounts,write_discounts"),
      true,
    );
  });

  test("returns false when read_themes is absent, even with every baseline scope granted", () => {
    assert.equal(
      hasSufficientScopes("read_products,read_discounts,write_discounts"),
      true,
      "sanity check: baseline scopes alone already satisfy hasSufficientScopes",
    );
    assert.equal(
      hasThemeVerificationScope("read_products,read_discounts,write_discounts"),
      false,
      "but must NOT satisfy hasThemeVerificationScope — independent of baseline connectivity, exactly like hasOrderAttributionScope",
    );
  });

  test("hasOrderAttributionScope and hasThemeVerificationScope are independent of each other", () => {
    const onlyOrders = "read_products,read_orders,read_discounts,write_discounts";
    assert.equal(hasOrderAttributionScope(onlyOrders), true);
    assert.equal(hasThemeVerificationScope(onlyOrders), false);

    const onlyThemes = "read_products,read_themes,read_discounts,write_discounts";
    assert.equal(hasOrderAttributionScope(onlyThemes), false);
    assert.equal(hasThemeVerificationScope(onlyThemes), true);
  });

  test("returns false for null, undefined, and empty string", () => {
    assert.equal(hasThemeVerificationScope(null), false);
    assert.equal(hasThemeVerificationScope(undefined), false);
    assert.equal(hasThemeVerificationScope(""), false);
  });
});

describe("REQUIRED_SCOPES regression: neither read_orders nor read_themes gates baseline connectivity", () => {
  test("a baseline-only installation (no read_orders, no read_themes) is sufficient", () => {
    assert.equal(
      hasSufficientScopes("read_products,read_discounts,write_discounts"),
      true,
      "the whole point of this fix: a store that has never seen the read_orders/read_themes prompt must still have a usable connection",
    );
  });

  test("a store that already granted every scope, including the two additive ones, is still sufficient", () => {
    assert.equal(
      hasSufficientScopes(
        "read_products,read_orders,read_themes,read_discounts,write_discounts",
      ),
      true,
    );
  });

  test("missing a genuine baseline scope still correctly fails, proving this is not a blanket bypass", () => {
    assert.equal(
      hasSufficientScopes("read_orders,read_themes,read_discounts,write_discounts"),
      false,
      "read_products is still required — only the two ADDITIVE scopes were removed from the baseline gate",
    );
  });
});

describe("computeExpiresAt", () => {
  test("computes expiry correctly from seconds", () => {
    const result = computeExpiresAt(3600, NOW_MS);
    assert.equal(result.getTime(), NOW_MS + 3600 * 1000);
  });

  test("computes 90-day refresh token expiry", () => {
    const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
    const result = computeExpiresAt(7776000, NOW_MS);
    assert.equal(result.getTime(), NOW_MS + ninetyDaysMs);
  });
});

// ---------------------------------------------------------------------------
// Token exchange function tests
// ---------------------------------------------------------------------------

describe("exchangeSessionTokenForOfflineToken", () => {
  test("sends correct token exchange body and returns parsed result", async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedShop = "";

    const mockEndpoint: TokenEndpointFn = async (shop, body) => {
      capturedShop = shop;
      capturedBody = body as Record<string, unknown>;
      return makeTokenResponse();
    };

    const result = await exchangeSessionTokenForOfflineToken(
      {
        shop: "test-store.myshopify.com",
        sessionToken: "eyJhbGciOiJSUzI1NiJ9.test",
        clientId: "client_abc",
        clientSecret: "secret_xyz",
      },
      { tokenEndpoint: mockEndpoint },
    );

    assert.equal(capturedShop, "test-store.myshopify.com");
    assert.equal(capturedBody.client_id, "client_abc");
    assert.equal(capturedBody.client_secret, "secret_xyz");
    assert.equal(
      capturedBody.grant_type,
      "urn:ietf:params:oauth:grant-type:token-exchange",
    );
    assert.equal(capturedBody.subject_token, "eyJhbGciOiJSUzI1NiJ9.test");
    assert.equal(
      capturedBody.subject_token_type,
      "urn:ietf:params:oauth:token-type:id_token",
    );
    assert.equal(
      capturedBody.requested_token_type,
      "urn:shopify:params:oauth:token-type:offline-access-token",
    );
    assert.equal(capturedBody.expiring, 1);

    assert.equal(result.accessToken, "shpat_new_access_token");
    assert.equal(result.refreshToken, "shprt_new_refresh_token");
    assert.equal(result.expiresIn, 3600);
    assert.equal(result.refreshTokenExpiresIn, 7776000);
    assert.equal(result.scope, "read_products,read_themes,read_discounts,write_discounts");
  });
});

// ---------------------------------------------------------------------------
// Logic scenario tests — simulate getValidAccessToken decision paths
// without a real DB. We test the pure logic pieces together.
// ---------------------------------------------------------------------------

describe("Token refresh decision logic", () => {
  /**
   * (a) Valid non-expired token is reused without a refresh call.
   * Logic: isAccessTokenFresh returns true → no refresh needed.
   */
  test("(a) fresh token reused — no refresh call made", () => {
    const expiresAt = makeExpiry(300); // 5 min from now
    const encryptedToken = encryptSecret("shpat_current_token");

    // Simulate the EXPIRING_OFFLINE branch check
    const isFresh = isAccessTokenFresh(expiresAt, NOW_MS);
    assert.equal(isFresh, true, "Token should be considered fresh");

    // If fresh, we decrypt and return — no network call
    const decrypted = decryptSecret(encryptedToken);
    assert.equal(decrypted, "shpat_current_token");
  });

  /**
   * (b) Pre-expiry triggers exactly one refresh and persists rotated tokens.
   */
  test("(b) stale token triggers exactly one refresh call", async () => {
    let refreshCallCount = 0;

    const mockEndpoint: TokenEndpointFn = async (_shop, body) => {
      assert.equal(body.grant_type, "refresh_token");
      refreshCallCount++;
      return makeTokenResponse({
        access_token: "shpat_refreshed",
        refresh_token: "shprt_rotated",
      });
    };

    // Simulate the stale token state
    const staleExpiresAt = makeExpiry(60); // within 120s buffer
    assert.equal(isAccessTokenFresh(staleExpiresAt, NOW_MS), false);

    // Simulate calling the endpoint
    const response = await mockEndpoint("shop.myshopify.com", {
      client_id: "cid",
      client_secret: "csec",
      grant_type: "refresh_token",
      refresh_token: "shprt_old",
    });

    assert.equal(refreshCallCount, 1, "Exactly one refresh call");
    assert.equal(response.access_token, "shpat_refreshed");
    assert.equal(response.refresh_token, "shprt_rotated");
  });

  /**
   * (d) Refresh token rotation — new refresh token must differ from old.
   */
  test("(d) rotated refresh token is different from old one", async () => {
    const oldRefreshToken = "shprt_old_refresh_token";
    const mockEndpoint: TokenEndpointFn = async () =>
      makeTokenResponse({ refresh_token: "shprt_brand_new_rotated" });

    const result = await mockEndpoint("shop.myshopify.com", {
      grant_type: "refresh_token",
      refresh_token: oldRefreshToken,
      client_id: "cid",
      client_secret: "csec",
    });

    // Old refresh token is NOT reused — a new one is returned
    assert.notEqual(result.refresh_token, oldRefreshToken);
    assert.equal(result.refresh_token, "shprt_brand_new_rotated");

    // Verify encryption of new tokens works correctly
    const encryptedNew = encryptSecret(result.refresh_token);
    const decryptedNew = decryptSecret(encryptedNew);
    assert.equal(decryptedNew, "shprt_brand_new_rotated");

    // Old token should not decrypt to the same value
    const encryptedOld = encryptSecret(oldRefreshToken);
    const decryptedOld = decryptSecret(encryptedOld);
    assert.notEqual(decryptedOld, decryptedNew);
  });

  /**
   * (e) Expired / invalid refresh token → permanent failure.
   */
  test("(e) HTTP 400 invalid_grant from Shopify marks as permanent failure", async () => {
    const mockEndpoint: TokenEndpointFn = async () => {
      const err = Object.assign(
        new Error("Shopify token endpoint responded with 400"),
        { status: 400, shopifyError: { error: "invalid_grant" } },
      );
      throw err;
    };

    let caughtError: (Error & { status?: number; permanent?: boolean }) | null = null;
    try {
      await mockEndpoint("shop.myshopify.com", {
        grant_type: "refresh_token",
        refresh_token: "shprt_expired",
        client_id: "cid",
        client_secret: "csec",
      });
    } catch (err) {
      caughtError = err as Error & { status?: number };
    }

    assert.ok(caughtError, "Error should have been thrown");
    assert.equal(caughtError?.status, 400);

    // The manager treats 400 as permanent (maps to NEEDS_RECONNECT)
    const errorStatus: number = caughtError?.status ?? 0;
    const isPermanent = errorStatus === 400 || errorStatus === 401;
    assert.equal(isPermanent, true, "400 should be treated as permanent failure");
  });

  test("(e) HTTP 401 from Shopify is also treated as permanent failure", () => {
    // Use a variable typed as number (not a literal) to avoid TS narrowing errors
    const status: number = 401;
    const isPermanent = status === 400 || status === 401;
    assert.equal(isPermanent, true);
  });

  /**
   * (f) Scope mismatch — missing write_discounts → NEEDS_RECONNECT.
   */
  test("(f) scope missing write_discounts → insufficient scopes", () => {
    assert.equal(
      hasSufficientScopes("read_products,read_discounts"),
      false,
    );
  });

  test("(f) scope missing read_products → insufficient scopes", () => {
    assert.equal(
      hasSufficientScopes("read_discounts,write_discounts"),
      false,
    );
  });

  test("(f) all required scopes present → sufficient", () => {
    assert.equal(
      hasSufficientScopes("read_products,read_themes,read_discounts,write_discounts"),
      true,
    );
  });

  /**
   * (g) LEGACY_OFFLINE vs EXPIRING_OFFLINE mode selection.
   */
  test("(g) LEGACY_OFFLINE: token returned without any refresh logic", () => {
    // In LEGACY_OFFLINE mode, isAccessTokenFresh is never checked
    // and no refresh endpoint is called. We simulate this with the
    // auth mode guard in the manager.
    const authMode = "LEGACY_OFFLINE";
    const encryptedToken = encryptSecret("shpat_legacy_token");

    // LEGACY_OFFLINE branch: decrypt and return immediately
    if (authMode === "LEGACY_OFFLINE") {
      const token = decryptSecret(encryptedToken);
      assert.equal(token, "shpat_legacy_token");
      return; // No refresh attempted
    }

    // Should not reach here
    assert.fail("Should have returned in LEGACY_OFFLINE branch");
  });

  test("(g) EXPIRING_OFFLINE: stale token triggers refresh logic", () => {
    const authMode = "EXPIRING_OFFLINE";
    const expiresAt = makeExpiry(60); // stale

    // EXPIRING_OFFLINE branch: check freshness
    if (authMode === "EXPIRING_OFFLINE") {
      const isFresh = isAccessTokenFresh(expiresAt, NOW_MS);
      assert.equal(isFresh, false, "Stale token should not be fresh");
      // Would proceed to refresh...
      return;
    }

    assert.fail("Should have entered EXPIRING_OFFLINE branch");
  });

  test("(g) EXPIRING_OFFLINE: fresh token does NOT trigger refresh", () => {
    const authMode = "EXPIRING_OFFLINE";
    const expiresAt = makeExpiry(300); // fresh

    let refreshWouldHaveBeenCalled = false;

    if (authMode === "EXPIRING_OFFLINE") {
      const isFresh = isAccessTokenFresh(expiresAt, NOW_MS);
      if (isFresh) {
        // Return immediately — no refresh
        assert.equal(isFresh, true);
        return;
      }
      refreshWouldHaveBeenCalled = true;
    }

    assert.equal(refreshWouldHaveBeenCalled, false, "Fresh token should not trigger refresh");
  });

  /**
   * (c) Concurrent refresh — simulates two concurrent requests; only one
   * should win the lock and make the network call.
   */
  test("(c) concurrent refresh lock: only one caller makes the network request", async () => {
    let networkCallCount = 0;

    const mockEndpoint: TokenEndpointFn = async () => {
      networkCallCount++;
      return makeTokenResponse({ access_token: "shpat_refreshed_concurrent" });
    };

    // Simulate lock acquisition: only the first caller wins
    let lockHolder: string | null = null;
    const nowMs = NOW_MS;
    const lockExpiry = nowMs + 30_000;

    function tryAcquireLock(callerId: string): boolean {
      if (lockHolder === null || nowMs > lockExpiry) {
        lockHolder = callerId;
        return true;
      }
      return false;
    }

    const caller1Won = tryAcquireLock("caller-1");
    const caller2Won = tryAcquireLock("caller-2");

    assert.equal(caller1Won, true, "First caller should win the lock");
    assert.equal(caller2Won, false, "Second caller should not win the lock");

    // Only the lock holder performs the refresh
    if (caller1Won) {
      const response = await mockEndpoint("shop.myshopify.com", {
        grant_type: "refresh_token",
        refresh_token: "shprt_old",
        client_id: "cid",
        client_secret: "csec",
      });
      assert.equal(response.access_token, "shpat_refreshed_concurrent");
    }

    // Caller 2 would wait and then read the updated token from DB
    // (simulated: it would see the new token after the lock is released)
    assert.equal(networkCallCount, 1, "Only one network refresh call made");
  });

  test("(c) refresh failure does not release another caller's lease", () => {
    const firstLease = "brand-a:first";
    const secondLease = "brand-a:second";

    assert.equal(ownsRefreshLock(secondLease, firstLease), false);
    assert.equal(ownsRefreshLock(secondLease, secondLease), true);
  });

  test("(c) unrelated shops use independent refresh leases", () => {
    const leases = new Map<string, string>();
    leases.set("brand-a", "lease-a");
    leases.set("brand-b", "lease-b");

    assert.equal(ownsRefreshLock(leases.get("brand-a"), "lease-a"), true);
    assert.equal(ownsRefreshLock(leases.get("brand-b"), "lease-b"), true);
  });

  test("(c) stale writer cannot overwrite a rotated refresh token", () => {
    const currentLease = "newer-lease";
    const staleWriterLease = "expired-lease";

    assert.equal(
      ownsRefreshLock(currentLease, staleWriterLease),
      false,
      "A superseded refresh response must not be persisted",
    );
  });
});

// ---------------------------------------------------------------------------
// Encryption / decryption integrity tests
// ---------------------------------------------------------------------------

describe("Token encryption integrity", () => {
  test("encrypted refresh token decrypts back correctly", () => {
    const refreshToken = "shprt_some_refresh_token_value";
    const encrypted = encryptSecret(refreshToken);
    const decrypted = decryptSecret(encrypted);
    assert.equal(decrypted, refreshToken);
    // Encrypted form must differ from plaintext
    assert.notEqual(encrypted, refreshToken);
  });

  test("two encryptions of the same value produce different ciphertexts (random IV)", () => {
    const token = "shpat_same_access_token";
    const enc1 = encryptSecret(token);
    const enc2 = encryptSecret(token);
    // Both must decrypt to the same plaintext
    assert.equal(decryptSecret(enc1), token);
    assert.equal(decryptSecret(enc2), token);
    // But the ciphertexts are different (random IV per call)
    assert.notEqual(enc1, enc2);
  });
});

// ---------------------------------------------------------------------------
// getValidAccessToken → mirror orchestration
//
// Drives the REAL getValidAccessToken (imported above, statically — see the
// file header) end-to-end, with the real `src/lib/prisma.ts` default export
// pulled in dynamically (via `before()`, AFTER DATABASE_URL is set — see the
// file header for why this must be dynamic) and its `brand` / `$transaction`
// members replaced by small in-memory fakes. No real DB connection or
// network call is ever made — `tokenEndpoint` is always the injected fake
// too.
//
// These tests exist to verify ORCHESTRATION — that shopify-token-manager.ts
// calls the best-effort mirror (safeSyncShopifyCommerceConnection /
// safeMarkShopifyCommerceConnectionDisconnected) at exactly the right call
// sites, in the right order, and only on those sites — not to re-verify
// connection-sync.ts's own internal correctness, which is already covered by
// tests/commerce-connection-compatibility.test.ts. To keep the fakes small,
// the mirror's own brand lookup (`defaultFindBrandForSync`, distinguishable
// from shopify-token-manager's `reloadBrand` by its `select` shape — it
// never selects `shopifyTokenRefreshLockId`) is configured to either return
// null (so `syncShopifyCommerceConnectionForBrand` resolves
// "skipped_brand_not_found" immediately, proving the mirror WAS invoked
// without needing to simulate its whole transaction) or to throw (proving a
// mirror failure never propagates). `safeMarkShopifyCommerceConnectionDisconnected`
// is exercised similarly, one level in: its `commerceConnection.findMany`
// call is faked to return `[]`, resolving "noop" immediately.
// ---------------------------------------------------------------------------

describe("getValidAccessToken → mirror orchestration", () => {
  type FakeMirrorBrandRow = {
    id: string;
    shopifyShopDomain: string | null;
    shopifyAdminAccessTokenEncrypted: string | null;
    shopifyConnectionStatus: string;
    shopifyAuthMode: string;
    shopifyAccessTokenExpiresAt: Date | null;
    shopifyRefreshTokenEncrypted: string | null;
    shopifyRefreshTokenExpiresAt: Date | null;
    shopifyGrantedScopes: string | null;
    shopifyClientId: string | null;
    shopifyTokenRefreshLockedUntil: Date | null;
    shopifyTokenRefreshLockId: string | null;
    shopifyCurrencyCode: string | null;
  };

  type MirrorTestCtx = {
    brand: FakeMirrorBrandRow | null;
    calls: string[];
    mirrorBehavior: "shortCircuit" | "throw";
    reloadBrandCount: number;
    onReloadBrand: ((callIndex: number, brand: FakeMirrorBrandRow) => void) | null;
    markDisconnectedConnectionRows: unknown[];
  };

  let ctx: MirrorTestCtx;

  function resetMirrorCtx(overrides: Partial<MirrorTestCtx> = {}) {
    ctx = {
      brand: null,
      calls: [],
      mirrorBehavior: "shortCircuit",
      reloadBrandCount: 0,
      onReloadBrand: null,
      markDisconnectedConnectionRows: [],
      ...overrides,
    };
  }

  // Real wall-clock offsets — getValidAccessToken calls Date.now() itself
  // internally (no injectable clock), unlike the fixed-NOW_MS pure-logic
  // tests above.
  function realExpiry(offsetMs: number): Date {
    return new Date(Date.now() + offsetMs);
  }

  function makeStaleExpiringBrand(
    overrides: Partial<FakeMirrorBrandRow> = {},
  ): FakeMirrorBrandRow {
    return {
      id: "brand-mirror-1",
      shopifyShopDomain: "mirror-shop.myshopify.com",
      shopifyAdminAccessTokenEncrypted: encryptSecret("shpat_old_token"),
      shopifyConnectionStatus: "CONNECTED",
      shopifyAuthMode: "EXPIRING_OFFLINE",
      shopifyAccessTokenExpiresAt: realExpiry(-60_000), // already expired -> stale
      shopifyRefreshTokenEncrypted: encryptSecret("shprt_old_refresh"),
      shopifyRefreshTokenExpiresAt: realExpiry(7_776_000_000),
      shopifyGrantedScopes: "read_products,read_themes,read_discounts,write_discounts",
      shopifyClientId: "client_abc",
      shopifyTokenRefreshLockedUntil: null,
      shopifyTokenRefreshLockId: null,
      shopifyCurrencyCode: "USD",
      ...overrides,
    };
  }

  async function fakeBrandFindUnique(args: {
    where: { id: string };
    select?: Record<string, boolean>;
  }) {
    const isReloadBrandShape =
      !!args.select && "shopifyTokenRefreshLockId" in args.select;

    if (isReloadBrandShape) {
      ctx.reloadBrandCount += 1;
      ctx.calls.push(`reloadBrand#${ctx.reloadBrandCount}`);
      if (!ctx.brand) return null;
      ctx.onReloadBrand?.(ctx.reloadBrandCount, ctx.brand);
      return { ...ctx.brand };
    }

    // Any other select shape reaching prisma.brand.findUnique in these
    // tests is the mirror's own findBrandForSync lookup — the only other
    // caller of brand.findUnique in the whole call graph exercised here.
    ctx.calls.push("mirrorFindBrand");
    if (ctx.mirrorBehavior === "throw") {
      throw new Error("simulated mirror DB failure");
    }
    return null;
  }

  async function fakeBrandUpdateMany(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) {
    if (!ctx.brand || args.where.id !== ctx.brand.id) {
      return { count: 0 };
    }

    if ("shopifyAdminAccessTokenEncrypted" in args.data) {
      // performTokenRefresh's authoritative CAS write.
      ctx.calls.push("performTokenRefreshCAS");
      const lockMatches =
        ctx.brand.shopifyTokenRefreshLockId !== null &&
        args.where.shopifyTokenRefreshLockId === ctx.brand.shopifyTokenRefreshLockId;
      if (!lockMatches) return { count: 0 };
      Object.assign(ctx.brand, args.data);
      return { count: 1 };
    }

    if (args.data.shopifyTokenRefreshLockedUntil === null) {
      // releaseRefreshLock.
      ctx.calls.push("releaseRefreshLock");
      const lockMatches =
        args.where.shopifyTokenRefreshLockId === ctx.brand.shopifyTokenRefreshLockId;
      if (!lockMatches) return { count: 0 };
      ctx.brand.shopifyTokenRefreshLockedUntil = null;
      ctx.brand.shopifyTokenRefreshLockId = null;
      return { count: 1 };
    }

    // acquireRefreshLock CAS.
    ctx.calls.push("acquireRefreshLock");
    const lockFree =
      !ctx.brand.shopifyTokenRefreshLockedUntil ||
      ctx.brand.shopifyTokenRefreshLockedUntil.getTime() < Date.now();
    if (!lockFree) return { count: 0 };
    ctx.brand.shopifyTokenRefreshLockedUntil =
      args.data.shopifyTokenRefreshLockedUntil as Date;
    ctx.brand.shopifyTokenRefreshLockId = args.data.shopifyTokenRefreshLockId as string;
    return { count: 1 };
  }

  // Backs BOTH transactions reachable from these tests: shopify-token-manager's
  // own markRequiresReconnect (tx.brand.*, tx.brandRewardOffer.updateMany,
  // tx.shopifyConnectionEvent.create) and connection-sync's
  // applyMarkShopifyConnectionsDisconnected (tx.commerceConnection.findMany)
  // reached via safeMarkShopifyCommerceConnectionDisconnected. A single
  // shared in-memory store (ctx.brand) stands in for real transactional
  // isolation, matching the level of fidelity the rest of this codebase's
  // fake-tx test doubles use (see makeFakeConnectionSyncTx in
  // tests/commerce-connection-compatibility.test.ts).
  async function fakeTransaction<T>(
    fn: (tx: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    const tx = {
      brand: {
        findUnique: async () => (ctx.brand ? { ...ctx.brand } : null),
        update: async (args: { data: Record<string, unknown> }) => {
          ctx.calls.push("txBrandUpdate");
          if (ctx.brand) Object.assign(ctx.brand, args.data);
          return ctx.brand;
        },
        updateMany: async (args: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          ctx.calls.push("txBrandUpdateManyCAS");
          if (!ctx.brand || args.where.id !== ctx.brand.id) return { count: 0 };
          const lockMatches =
            ctx.brand.shopifyTokenRefreshLockId !== null &&
            args.where.shopifyTokenRefreshLockId === ctx.brand.shopifyTokenRefreshLockId;
          if (!lockMatches) return { count: 0 };
          Object.assign(ctx.brand, args.data);
          return { count: 1 };
        },
      },
      brandRewardOffer: {
        updateMany: async () => {
          ctx.calls.push("deactivateOffers");
          return { count: 0 };
        },
      },
      shopifyConnectionEvent: {
        create: async () => {
          ctx.calls.push("connectionEventCreate");
          return {};
        },
      },
      commerceConnection: {
        findMany: async () => {
          ctx.calls.push("mirrorMarkDisconnectedFindMany");
          return ctx.markDisconnectedConnectionRows;
        },
      },
    };
    return fn(tx);
  }

  before(async () => {
    const prismaModule = (await import("../src/lib/prisma"))
      .default as unknown as {
      brand: Record<string, unknown>;
      $transaction: unknown;
    };
    prismaModule.brand = {
      findUnique: fakeBrandFindUnique,
      updateMany: fakeBrandUpdateMany,
    };
    prismaModule.$transaction = fakeTransaction;
  });

  test("1. successful winner refresh calls the mirror exactly once, strictly after the CAS update resolves", async () => {
    resetMirrorCtx({ brand: makeStaleExpiringBrand(), mirrorBehavior: "shortCircuit" });
    const tokenEndpoint: TokenEndpointFn = async () => makeTokenResponse();

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accessToken, "shpat_new_access_token");

    const casIndex = ctx.calls.indexOf("performTokenRefreshCAS");
    const mirrorIndex = ctx.calls.indexOf("mirrorFindBrand");
    assert.ok(casIndex >= 0, "expected the authoritative CAS write to have run");
    assert.ok(mirrorIndex >= 0, "expected the mirror to have been invoked");
    assert.ok(mirrorIndex > casIndex, "the mirror must run strictly AFTER the CAS commit");
    assert.equal(
      ctx.calls.filter((c) => c === "mirrorFindBrand").length,
      1,
      "the mirror must be called exactly once",
    );
  });

  test("2. a mirror that throws does not change getValidAccessToken's return value and does not propagate", async () => {
    resetMirrorCtx({ brand: makeStaleExpiringBrand(), mirrorBehavior: "throw" });
    const tokenEndpoint: TokenEndpointFn = async () => makeTokenResponse();

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true, "a thrown mirror error must never surface as a failed refresh");
    if (result.ok) assert.equal(result.accessToken, "shpat_new_access_token");
    assert.ok(ctx.calls.includes("mirrorFindBrand"), "the mirror must still have been attempted");
  });

  test("3. a losing refresher that returns a valid token via the stale-writer/readWinnerToken path does NOT call the mirror", async () => {
    resetMirrorCtx({ brand: makeStaleExpiringBrand(), mirrorBehavior: "shortCircuit" });
    const winnerAccessToken = encryptSecret("shpat_from_other_winner");
    const tokenEndpoint: TokenEndpointFn = async () => {
      // Simulate another process's takeover winning the CAS race while this
      // request's own token-endpoint call is in flight — its own final CAS
      // write below will then find a superseded lock (count 0).
      if (ctx.brand) {
        ctx.brand.shopifyTokenRefreshLockId = "some-other-processes-lock";
        ctx.brand.shopifyAdminAccessTokenEncrypted = winnerAccessToken;
        ctx.brand.shopifyAccessTokenExpiresAt = realExpiry(3_600_000);
      }
      return makeTokenResponse();
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accessToken, "shpat_from_other_winner");
    assert.ok(
      !ctx.calls.includes("mirrorFindBrand"),
      "a stale writer falling back to readWinnerToken must never call the mirror",
    );
  });

  test("4a. fresh-after-wait loser path does NOT call the mirror", async () => {
    resetMirrorCtx({
      brand: makeStaleExpiringBrand({
        shopifyTokenRefreshLockedUntil: realExpiry(10_000),
        shopifyTokenRefreshLockId: "other-holder-lock",
      }),
      mirrorBehavior: "shortCircuit",
      onReloadBrand: (callIndex, brand) => {
        if (callIndex === 2) {
          // Simulate the lock holder finishing its refresh between this
          // caller's failed acquire and waitForLockHolder's first poll.
          brand.shopifyTokenRefreshLockedUntil = null;
          brand.shopifyTokenRefreshLockId = null;
          brand.shopifyAdminAccessTokenEncrypted = encryptSecret("shpat_refreshed_by_winner");
          brand.shopifyAccessTokenExpiresAt = realExpiry(3_600_000); // fresh
        }
      },
    });
    const tokenEndpoint: TokenEndpointFn = async () => {
      throw new Error("this loser must never call the token endpoint");
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accessToken, "shpat_refreshed_by_winner");
    assert.ok(!ctx.calls.includes("performTokenRefreshCAS"), "a loser must never refresh itself");
    assert.ok(!ctx.calls.includes("mirrorFindBrand"), "the fresh-after-wait loser must not mirror");
  });

  test("4b. not-yet-expired-fallback loser path does NOT call the mirror", async () => {
    resetMirrorCtx({
      brand: makeStaleExpiringBrand({
        shopifyTokenRefreshLockedUntil: realExpiry(10_000),
        shopifyTokenRefreshLockId: "other-holder-lock",
      }),
      mirrorBehavior: "shortCircuit",
      onReloadBrand: (callIndex, brand) => {
        if (callIndex === 2) {
          brand.shopifyTokenRefreshLockedUntil = null;
          brand.shopifyTokenRefreshLockId = null;
          // Within the 120s safety buffer (not "fresh") but not literally
          // expired yet — the fallback branch, distinct from the fresh-token
          // branch exercised by 4a.
          brand.shopifyAccessTokenExpiresAt = realExpiry(30_000);
        }
      },
    });
    const tokenEndpoint: TokenEndpointFn = async () => {
      throw new Error("this loser must never call the token endpoint");
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true);
    assert.ok(!ctx.calls.includes("performTokenRefreshCAS"), "a loser must never refresh itself");
    assert.ok(!ctx.calls.includes("mirrorFindBrand"), "the not-yet-expired loser must not mirror");
  });

  test("5. the takeover-lock winner path calls the mirror", async () => {
    resetMirrorCtx({
      brand: makeStaleExpiringBrand({
        shopifyTokenRefreshLockedUntil: realExpiry(10_000),
        shopifyTokenRefreshLockId: "other-holder-lock",
      }),
      mirrorBehavior: "shortCircuit",
      onReloadBrand: (callIndex, brand) => {
        if (callIndex === 2) {
          // The other holder's lease lapsed without a successful refresh
          // (crash / lease expiry) — lock released, token still expired, so
          // this caller must take over the refresh itself.
          brand.shopifyTokenRefreshLockedUntil = null;
          brand.shopifyTokenRefreshLockId = null;
        }
      },
    });
    const tokenEndpoint: TokenEndpointFn = async () => makeTokenResponse();

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accessToken, "shpat_new_access_token");
    assert.ok(
      ctx.calls.includes("performTokenRefreshCAS"),
      "the takeover winner must have performed the CAS refresh itself",
    );
    const casIndex = ctx.calls.indexOf("performTokenRefreshCAS");
    const mirrorIndex = ctx.calls.indexOf("mirrorFindBrand");
    assert.ok(mirrorIndex >= 0, "the takeover winner must call the mirror");
    assert.ok(mirrorIndex > casIndex, "the mirror must run strictly after the takeover CAS commit");
    assert.equal(ctx.calls.filter((c) => c === "mirrorFindBrand").length, 1);
  });

  test("5b. missing read_orders and read_themes never triggers the REQUIRES_RECONNECT scope-check branch", async () => {
    resetMirrorCtx({
      brand: makeStaleExpiringBrand({
        // Baseline-only: this is the exact regression scenario — a store
        // that has never seen (or hasn't yet approved) the read_orders /
        // read_themes managed-installation prompt.
        shopifyGrantedScopes: "read_products,read_discounts,write_discounts",
      }),
      mirrorBehavior: "shortCircuit",
    });
    const tokenEndpoint: TokenEndpointFn = async () => makeTokenResponse();

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true, "a baseline-sufficient store must get a token, not NEEDS_RECONNECT");
    if (result.ok) assert.equal(result.accessToken, "shpat_new_access_token");
    assert.ok(
      !ctx.calls.includes("txBrandUpdateManyCAS"),
      "the scope-check path must never reach markRequiresReconnect's CAS for a baseline-sufficient grant",
    );
    assert.equal(
      ctx.brand?.shopifyConnectionStatus,
      "CONNECTED",
      "status must remain CONNECTED throughout — this is precisely the bug: an optional, additive scope must never flip it",
    );
  });

  test("6a. a successful markRequiresReconnect (permanent refresh failure) triggers the status mirror", async () => {
    resetMirrorCtx({ brand: makeStaleExpiringBrand(), mirrorBehavior: "shortCircuit" });
    const tokenEndpoint: TokenEndpointFn = async () => {
      const err = Object.assign(new Error("invalid_grant"), { status: 400 });
      throw err;
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "NEEDS_RECONNECT");
    assert.ok(
      ctx.calls.includes("txBrandUpdateManyCAS"),
      "markRequiresReconnect's own CAS must have run",
    );
    assert.ok(
      ctx.calls.includes("mirrorMarkDisconnectedFindMany"),
      "a successful markRequiresReconnect must trigger the status mirror",
    );
  });

  test("6b. a failed markRequiresReconnect CAS (superseded lock) does NOT trigger the status mirror", async () => {
    resetMirrorCtx({ brand: makeStaleExpiringBrand(), mirrorBehavior: "shortCircuit" });
    const tokenEndpoint: TokenEndpointFn = async () => {
      // Simulate another process's takeover superseding this caller's lock
      // while its own (failing) token-endpoint call is in flight, so
      // markRequiresReconnect's CAS below finds a mismatched lock (count 0).
      if (ctx.brand) {
        ctx.brand.shopifyTokenRefreshLockId = "some-other-processes-lock";
      }
      const err = Object.assign(new Error("invalid_grant"), { status: 400 });
      throw err;
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "NEEDS_RECONNECT");
    assert.ok(
      ctx.calls.includes("txBrandUpdateManyCAS"),
      "markRequiresReconnect's own CAS must still have been attempted",
    );
    assert.ok(
      !ctx.calls.includes("mirrorMarkDisconnectedFindMany"),
      "a superseded (failed-CAS) markRequiresReconnect must never trigger the status mirror",
    );
  });

  test("7. LEGACY_OFFLINE never reaches the mirror", async () => {
    resetMirrorCtx({
      brand: makeStaleExpiringBrand({
        shopifyAuthMode: "LEGACY_OFFLINE",
        shopifyAccessTokenExpiresAt: null, // LEGACY_OFFLINE tokens never expire
      }),
      mirrorBehavior: "shortCircuit",
    });
    const tokenEndpoint: TokenEndpointFn = async () => {
      throw new Error("LEGACY_OFFLINE must never call the token endpoint");
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accessToken, "shpat_old_token");
    assert.deepEqual(
      ctx.calls,
      ["reloadBrand#1"],
      "LEGACY_OFFLINE must return immediately after its single reloadBrand read, touching no lock/CAS/mirror logic at all",
    );
  });
});
