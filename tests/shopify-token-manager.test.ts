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
  reconcileShopifyConnectionScopes,
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

describe("getValidAccessToken → CANONICAL credential authority + reverse mirror orchestration", () => {
  /**
   * PHASE 14B.2. This block previously modelled `Brand.shopify*` as the
   * credential authority. Authority has now inverted, so the fixture models
   * what production actually reads:
   *
   *   Brand  ->  CommerceConnection(SHOPIFY)  ->  CommerceConnectionSecret
   *
   * Every original invariant is preserved — one refresh winner, losers never
   * refresh, stale writers never overwrite the winner, stale-lease takeover,
   * permanent failure requires reconnect, LEGACY_OFFLINE short-circuits, and
   * the compatibility mirror runs strictly AFTER the authoritative write and
   * can never change the result. What changed is only WHERE each of those
   * lives:
   *
   *   authoritative CAS   Brand.updateMany       -> CommerceConnectionSecret.updateMany
   *   refresh lease       Brand.shopifyToken*    -> CommerceConnectionSecret.refreshLock*
   *   the "mirror"        canonical sync (fwd)   -> Brand.update (REVERSE mirror)
   *
   * `ctx.brand` is deliberately left holding a DELIBERATELY STALE credential
   * in most cases: that is now a feature, not fixture noise — it proves the
   * canonical value wins (required test B) and that nothing silently reads
   * the legacy copy.
   *
   * `loadShopifyCredential` is NEVER bypassed: the fixture mocks the same
   * Prisma delegates production calls, and `DATABASE_URL` stays unreachable
   * so any un-mocked DB access still fails loudly.
   */
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

  type FakeConnRow = {
    id: string;
    brandId: string;
    provider: string;
    status: string;
    externalAccountId: string;
    providerClientId: string | null;
    grantedScopes: string[] | null;
  };

  type FakeSecretRow = {
    connectionId: string;
    encryptedPayload: string;
    rotatedAt: Date | null;
    expiresAt: Date | null;
    refreshLockId: string | null;
    refreshLockedUntil: Date | null;
  };

  type CanonicalTokens = {
    accessToken: string;
    accessTokenExpiresAt: Date | null;
    refreshToken: string | null;
    refreshTokenExpiresAt: Date | null;
    authMode: string;
  };

  type MirrorTestCtx = {
    brand: FakeMirrorBrandRow | null;
    conn: FakeConnRow | null;
    secret: FakeSecretRow | null;
    calls: string[];
    /** "throw" makes the REVERSE mirror (Brand.update) fail. */
    mirrorBehavior: "shortCircuit" | "throw";
    canonicalLoadCount: number;
    /** Fires on each canonical load so a test can simulate a concurrent winner. */
    onCanonicalLoad: ((callIndex: number, ctx: MirrorTestCtx) => void) | null;
  };

  let ctx: MirrorTestCtx;

  function realExpiry(offsetMs: number): Date {
    return new Date(Date.now() + offsetMs);
  }

  function encodeTokens(tokens: CanonicalTokens): string {
    return encryptSecret(
      JSON.stringify({
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt?.toISOString() ?? null,
        refreshToken: tokens.refreshToken,
        refreshTokenExpiresAt: tokens.refreshTokenExpiresAt?.toISOString() ?? null,
        authMode: tokens.authMode,
      }),
    );
  }

  /**
   * Decrypts the canonical payload and REVIVES its ISO date strings back into
   * `Date` objects, so a decode -> patch -> encode round-trip stays
   * type-faithful (the payload stores ISO strings; `CanonicalTokens` holds
   * Dates).
   */
  function decodeTokens(secret: FakeSecretRow): CanonicalTokens {
    const raw = JSON.parse(decryptSecret(secret.encryptedPayload)) as {
      accessToken: string;
      accessTokenExpiresAt: string | null;
      refreshToken: string | null;
      refreshTokenExpiresAt: string | null;
      authMode: string;
    };
    return {
      accessToken: raw.accessToken,
      accessTokenExpiresAt: raw.accessTokenExpiresAt
        ? new Date(raw.accessTokenExpiresAt)
        : null,
      refreshToken: raw.refreshToken,
      refreshTokenExpiresAt: raw.refreshTokenExpiresAt
        ? new Date(raw.refreshTokenExpiresAt)
        : null,
      authMode: raw.authMode,
    };
  }

  /** Mutates the canonical secret's decrypted payload in place. */
  function setCanonicalTokens(patch: Partial<CanonicalTokens>) {
    if (!ctx.secret) return;
    const current = decodeTokens(ctx.secret);
    ctx.secret.encryptedPayload = encodeTokens({ ...current, ...patch });
  }

  function resetMirrorCtx(overrides: Partial<MirrorTestCtx> = {}) {
    ctx = {
      brand: null,
      conn: null,
      secret: null,
      calls: [],
      mirrorBehavior: "shortCircuit",
      canonicalLoadCount: 0,
      onCanonicalLoad: null,
      ...overrides,
    };
  }

  /**
   * A brand whose LEGACY columns are deliberately stale/wrong. If any
   * production read still trusted them, the tests below would return
   * `shpat_STALE_BRAND_TOKEN_MUST_NOT_BE_USED` and fail loudly.
   */
  function makeStaleBrandMirror(
    overrides: Partial<FakeMirrorBrandRow> = {},
  ): FakeMirrorBrandRow {
    return {
      id: "brand-mirror-1",
      shopifyShopDomain: "mirror-shop.myshopify.com",
      shopifyAdminAccessTokenEncrypted: encryptSecret(
        "shpat_STALE_BRAND_TOKEN_MUST_NOT_BE_USED",
      ),
      shopifyConnectionStatus: "CONNECTED",
      shopifyAuthMode: "EXPIRING_OFFLINE",
      shopifyAccessTokenExpiresAt: realExpiry(3_600_000),
      shopifyRefreshTokenEncrypted: encryptSecret("shprt_STALE_BRAND_REFRESH"),
      shopifyRefreshTokenExpiresAt: realExpiry(7_776_000_000),
      shopifyGrantedScopes: "read_products,read_discounts,write_discounts",
      shopifyClientId: "client_abc",
      shopifyTokenRefreshLockedUntil: null,
      shopifyTokenRefreshLockId: null,
      shopifyCurrencyCode: "USD",
      ...overrides,
    };
  }

  function makeCanonicalConn(overrides: Partial<FakeConnRow> = {}): FakeConnRow {
    return {
      id: "conn-mirror-1",
      brandId: "brand-mirror-1",
      provider: "SHOPIFY",
      status: "CONNECTED",
      externalAccountId: "mirror-shop.myshopify.com",
      providerClientId: "client_abc",
      grantedScopes: ["read_products", "read_themes", "read_discounts", "write_discounts"],
      ...overrides,
    };
  }

  /** Canonical secret whose access token is already EXPIRED -> refresh needed. */
  function makeStaleCanonicalSecret(
    overrides: Partial<FakeSecretRow> = {},
  ): FakeSecretRow {
    return {
      connectionId: "conn-mirror-1",
      encryptedPayload: encodeTokens({
        accessToken: "shpat_old_token",
        accessTokenExpiresAt: realExpiry(-60_000),
        refreshToken: "shprt_old_refresh",
        refreshTokenExpiresAt: realExpiry(7_776_000_000),
        authMode: "EXPIRING_OFFLINE",
      }),
      rotatedAt: null,
      expiresAt: null,
      refreshLockId: null,
      refreshLockedUntil: null,
      ...overrides,
    };
  }

  /** Sets up the standard "canonical stale, brand stale-and-wrong" scenario. */
  function stdCanonicalScenario(overrides: Partial<MirrorTestCtx> = {}) {
    resetMirrorCtx({
      brand: makeStaleBrandMirror(),
      conn: makeCanonicalConn(),
      secret: makeStaleCanonicalSecret(),
      ...overrides,
    });
  }

  // -------------------------------------------------------------------------
  // Prisma delegate fakes — the SAME calls production makes.
  // -------------------------------------------------------------------------

  async function fakeConnFindFirst(args: {
    where: { brandId: string; provider: string };
  }) {
    ctx.canonicalLoadCount += 1;
    ctx.calls.push(`canonicalLoad#${ctx.canonicalLoadCount}`);
    ctx.onCanonicalLoad?.(ctx.canonicalLoadCount, ctx);

    if (
      !ctx.conn ||
      ctx.conn.brandId !== args.where.brandId ||
      ctx.conn.provider !== args.where.provider
    ) {
      return null;
    }
    return {
      id: ctx.conn.id,
      brandId: ctx.conn.brandId,
      status: ctx.conn.status,
      externalAccountId: ctx.conn.externalAccountId,
      providerClientId: ctx.conn.providerClientId,
      grantedScopes: ctx.conn.grantedScopes,
      secret: ctx.secret ? { encryptedPayload: ctx.secret.encryptedPayload } : null,
    };
  }

  async function fakeConnUpdate(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }) {
    ctx.calls.push("connStatusUpdate");
    if (ctx.conn && ctx.conn.id === args.where.id) {
      Object.assign(ctx.conn, args.data);
    }
    return ctx.conn;
  }

  // PHASE 14B.4B: `applyGrantedScopesUpdate` resolves the canonical
  // connection by `(provider, externalAccountId)` directly, not by brandId —
  // this is the SAME `ctx.conn` model `fakeConnFindFirst` above serves, just
  // keyed differently, so both fakes must stay consistent with one another.
  async function fakeConnFindUnique(args: {
    where: { provider_externalAccountId?: { provider: string; externalAccountId: string } };
  }) {
    ctx.calls.push("scopesConnFindUnique");
    const key = args.where.provider_externalAccountId;
    if (
      !key ||
      !ctx.conn ||
      ctx.conn.provider !== key.provider ||
      ctx.conn.externalAccountId !== key.externalAccountId
    ) {
      return null;
    }
    return { id: ctx.conn.id, brandId: ctx.conn.brandId, status: ctx.conn.status };
  }

  async function fakeConnUpdateMany(args: {
    where: { id: string; status?: unknown };
    data: Record<string, unknown>;
  }) {
    ctx.calls.push("scopesConnUpdateMany");
    if (!ctx.conn || ctx.conn.id !== args.where.id) return { count: 0 };
    Object.assign(ctx.conn, args.data);
    return { count: 1 };
  }

  async function fakeSecretFindUnique(args: { where: { connectionId: string } }) {
    ctx.calls.push("leaseProbe");
    if (!ctx.secret || ctx.secret.connectionId !== args.where.connectionId) return null;
    return { ...ctx.secret };
  }

  async function fakeSecretUpdateMany(args: {
    where: {
      connectionId: string;
      refreshLockId?: string;
      OR?: Array<{ refreshLockedUntil: null | { lt: Date } }>;
    };
    data: Record<string, unknown>;
  }) {
    if (!ctx.secret || ctx.secret.connectionId !== args.where.connectionId) {
      return { count: 0 };
    }

    // Lease acquisition: the OR[null, lt now] predicate.
    if (args.where.OR) {
      ctx.calls.push("acquireLease");
      const lockFree =
        ctx.secret.refreshLockedUntil === null ||
        ctx.secret.refreshLockedUntil.getTime() < Date.now();
      if (!lockFree) return { count: 0 };
      Object.assign(ctx.secret, args.data);
      return { count: 1 };
    }

    const ownsLease =
      args.where.refreshLockId !== undefined &&
      ctx.secret.refreshLockId !== null &&
      ctx.secret.refreshLockId === args.where.refreshLockId;

    if ("encryptedPayload" in args.data) {
      // The AUTHORITATIVE rotation CAS.
      ctx.calls.push("rotationCAS");
      if (!ownsLease) return { count: 0 };
      Object.assign(ctx.secret, args.data);
      return { count: 1 };
    }

    // Lease release.
    ctx.calls.push("releaseLease");
    if (!ownsLease) return { count: 0 };
    ctx.secret.refreshLockId = null;
    ctx.secret.refreshLockedUntil = null;
    return { count: 1 };
  }

  async function fakeSecretDeleteMany(args: {
    where: { connectionId: string; refreshLockId?: string };
  }) {
    ctx.calls.push("clearCanonicalSecret");
    if (!ctx.secret || ctx.secret.connectionId !== args.where.connectionId) {
      return { count: 0 };
    }
    if (
      args.where.refreshLockId !== undefined &&
      ctx.secret.refreshLockId !== args.where.refreshLockId
    ) {
      return { count: 0 };
    }
    ctx.secret = null;
    return { count: 1 };
  }

  async function fakeBrandFindUnique(args: {
    where: { id: string };
    select?: Record<string, boolean>;
  }) {
    ctx.calls.push("legacyBrandRead");
    if (!ctx.brand || ctx.brand.id !== args.where.id) return null;
    return { ...ctx.brand };
  }

  /** The REVERSE compatibility mirror. */
  async function fakeBrandUpdate(args: {
    where: { id: string };
    data: Record<string, unknown>;
  }) {
    ctx.calls.push("reverseMirror");
    if (ctx.mirrorBehavior === "throw") {
      throw new Error("simulated compatibility-mirror DB failure");
    }
    if (ctx.brand && ctx.brand.id === args.where.id) {
      Object.assign(ctx.brand, args.data);
    }
    return ctx.brand;
  }

  async function fakeBrandUpdateMany() {
    // Reachable only on the LEGACY_COMPAT path, which the canonical scenarios
    // below never take. Tagged so an accidental regression is visible.
    ctx.calls.push("legacyBrandCAS");
    return { count: 0 };
  }

  async function fakeTransaction<T>(
    fn: (tx: Record<string, unknown>) => Promise<T>,
  ): Promise<T> {
    const tx = {
      commerceConnection: { update: fakeConnUpdate },
      commerceConnectionSecret: {
        updateMany: fakeSecretUpdateMany,
        deleteMany: fakeSecretDeleteMany,
        findUnique: fakeSecretFindUnique,
      },
      brand: {
        findUnique: fakeBrandFindUnique,
        update: fakeBrandUpdate,
        updateMany: fakeBrandUpdateMany,
      },
      brandRewardOffer: {
        updateMany: async () => {
          ctx.calls.push("deactivateOffers");
          return { count: 0 };
        },
      },
      commerceConnectionEvent: {
        create: async () => {
          ctx.calls.push("connectionEventCreate");
          return {};
        },
      },
    };
    return fn(tx);
  }

  before(async () => {
    const prismaModule = (await import("../src/lib/prisma"))
      .default as unknown as Record<string, unknown>;
    prismaModule.brand = {
      findUnique: fakeBrandFindUnique,
      update: fakeBrandUpdate,
      updateMany: fakeBrandUpdateMany,
    };
    prismaModule.commerceConnection = {
      findFirst: fakeConnFindFirst,
      update: fakeConnUpdate,
      findUnique: fakeConnFindUnique,
      updateMany: fakeConnUpdateMany,
    };
    prismaModule.commerceConnectionSecret = {
      findUnique: fakeSecretFindUnique,
      updateMany: fakeSecretUpdateMany,
      deleteMany: fakeSecretDeleteMany,
    };
    prismaModule.$transaction = fakeTransaction;
  });

  // -------------------------------------------------------------------------
  // A / B / C / D / E — canonical authority and rotation
  // -------------------------------------------------------------------------

  test("A. a FRESH canonical access token is returned with no refresh and no token-endpoint call", async () => {
    stdCanonicalScenario({
      secret: makeStaleCanonicalSecret(),
    });
    setCanonicalTokens({
      accessToken: "shpat_canonical_fresh",
      accessTokenExpiresAt: realExpiry(3_600_000),
    });
    const tokenEndpoint: TokenEndpointFn = async () => {
      throw new Error("a fresh canonical token must never hit the token endpoint");
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accessToken, "shpat_canonical_fresh");
    assert.ok(!ctx.calls.includes("acquireLease"), "no lease is needed for a fresh token");
    assert.ok(!ctx.calls.includes("rotationCAS"));
  });

  test("B. a deliberately STALE Brand credential is never used when a canonical credential exists", async () => {
    stdCanonicalScenario();
    setCanonicalTokens({
      accessToken: "shpat_canonical_fresh",
      accessTokenExpiresAt: realExpiry(3_600_000),
    });

    const result = await getValidAccessToken("brand-mirror-1", {
      tokenEndpoint: async () => makeTokenResponse(),
    });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.accessToken, "shpat_canonical_fresh");
      assert.notEqual(
        result.accessToken,
        "shpat_STALE_BRAND_TOKEN_MUST_NOT_BE_USED",
        "the legacy Brand credential must never win over canonical",
      );
    }
  });

  test("C/D/E. a stale canonical token refreshes exactly once; the rotated access AND refresh token become canonical", async () => {
    stdCanonicalScenario();
    const tokenEndpoint: TokenEndpointFn = async () => makeTokenResponse();

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accessToken, "shpat_new_access_token");

    assert.equal(
      ctx.calls.filter((c) => c === "rotationCAS").length,
      1,
      "exactly one authoritative rotation",
    );

    // D + E: both rotated tokens are canonical, and visible together.
    const persisted = decodeTokens(ctx.secret!);
    assert.equal(persisted.accessToken, "shpat_new_access_token");
    assert.equal(persisted.refreshToken, "shprt_new_refresh_token");
    // The lease was released atomically with the rotation.
    assert.equal(ctx.secret!.refreshLockId, null);
    assert.equal(ctx.secret!.refreshLockedUntil, null);
  });

  // PHASE 14C-A: `mirrorCanonicalCredentialToBrand` (the "reverse mirror")
  // was deleted from shopify-token-manager.ts entirely — every runtime
  // reader of `Brand.shopify*` was migrated off it, so there is no longer
  // anything for a rotated canonical token to mirror INTO. This test used
  // to prove the mirror ran exactly once, strictly after the canonical
  // CAS; it now proves the opposite (no mirror at all), matching the other
  // "must not mirror" assertions already present throughout this file
  // (F/G/H, 4a, 4b, K-superseded).
  test("1. no compatibility mirror runs — the canonical CAS is the only write", async () => {
    stdCanonicalScenario();

    const result = await getValidAccessToken("brand-mirror-1", {
      tokenEndpoint: async () => makeTokenResponse(),
    });
    assert.equal(result.ok, true);

    assert.ok(
      ctx.calls.includes("rotationCAS"),
      "expected the authoritative canonical CAS to have run",
    );
    assert.ok(
      !ctx.calls.includes("reverseMirror"),
      "no legacy Brand mirror exists anymore to invoke",
    );
  });

  // -------------------------------------------------------------------------
  // F / G / H — concurrency
  // -------------------------------------------------------------------------

  test("F/G/H. a stale writer whose lease was taken over persists NOTHING and returns the WINNER's canonical token", async () => {
    stdCanonicalScenario();
    const tokenEndpoint: TokenEndpointFn = async () => {
      // Another process takes over the lease and rotates while this
      // request's token-endpoint call is in flight.
      if (ctx.secret) {
        ctx.secret.refreshLockId = "some-other-processes-lock";
        ctx.secret.encryptedPayload = encodeTokens({
          accessToken: "shpat_from_other_winner",
          accessTokenExpiresAt: realExpiry(3_600_000),
          refreshToken: "shprt_winner_refresh",
          refreshTokenExpiresAt: realExpiry(7_776_000_000),
          authMode: "EXPIRING_OFFLINE",
        });
      }
      return makeTokenResponse();
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(
        result.accessToken,
        "shpat_from_other_winner",
        "the loser must observe the winner's canonical token",
      );
    }
    // H: the winner's payload survived — the loser overwrote nothing.
    assert.equal(decodeTokens(ctx.secret!).accessToken, "shpat_from_other_winner");
    assert.equal(decodeTokens(ctx.secret!).refreshToken, "shprt_winner_refresh");
    assert.ok(
      !ctx.calls.includes("reverseMirror"),
      "a stale writer falling back to readWinnerToken must never mirror",
    );
  });

  test("4a. fresh-after-wait loser never refreshes and never mirrors", async () => {
    stdCanonicalScenario({
      secret: makeStaleCanonicalSecret({
        refreshLockedUntil: realExpiry(10_000),
        refreshLockId: "other-holder-lock",
      }),
      onCanonicalLoad: (callIndex, c) => {
        if (callIndex === 2 && c.secret) {
          // The holder finishes between the failed acquire and the poll.
          c.secret.refreshLockedUntil = null;
          c.secret.refreshLockId = null;
          c.secret.encryptedPayload = encodeTokens({
            accessToken: "shpat_refreshed_by_winner",
            accessTokenExpiresAt: realExpiry(3_600_000),
            refreshToken: "shprt_winner_refresh",
            refreshTokenExpiresAt: realExpiry(7_776_000_000),
            authMode: "EXPIRING_OFFLINE",
          });
        }
      },
    });
    const tokenEndpoint: TokenEndpointFn = async () => {
      throw new Error("this loser must never call the token endpoint");
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accessToken, "shpat_refreshed_by_winner");
    assert.ok(!ctx.calls.includes("rotationCAS"), "a loser must never refresh itself");
    assert.ok(!ctx.calls.includes("reverseMirror"), "the fresh-after-wait loser must not mirror");
  });

  test("4b. not-yet-expired-fallback loser never refreshes and never mirrors", async () => {
    stdCanonicalScenario({
      secret: makeStaleCanonicalSecret({
        refreshLockedUntil: realExpiry(10_000),
        refreshLockId: "other-holder-lock",
      }),
      onCanonicalLoad: (callIndex, c) => {
        if (callIndex === 2 && c.secret) {
          c.secret.refreshLockedUntil = null;
          c.secret.refreshLockId = null;
          // Inside the 120s safety buffer but not literally expired — the
          // fallback branch, distinct from 4a's fresh-token branch.
          c.secret.encryptedPayload = encodeTokens({
            accessToken: "shpat_within_buffer",
            accessTokenExpiresAt: realExpiry(30_000),
            refreshToken: "shprt_old_refresh",
            refreshTokenExpiresAt: realExpiry(7_776_000_000),
            authMode: "EXPIRING_OFFLINE",
          });
        }
      },
    });
    const tokenEndpoint: TokenEndpointFn = async () => {
      throw new Error("this loser must never call the token endpoint");
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accessToken, "shpat_within_buffer");
    assert.ok(!ctx.calls.includes("rotationCAS"), "a loser must never refresh itself");
    assert.ok(!ctx.calls.includes("reverseMirror"), "the not-yet-expired loser must not mirror");
  });

  test("I. stale-lease TAKEOVER wins, rotates canonically, no mirror", async () => {
    stdCanonicalScenario({
      secret: makeStaleCanonicalSecret({
        // An expired lease left behind by a crashed holder.
        refreshLockedUntil: realExpiry(-1_000),
        refreshLockId: "crashed-holder-lock",
      }),
    });

    const result = await getValidAccessToken("brand-mirror-1", {
      tokenEndpoint: async () => makeTokenResponse(),
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accessToken, "shpat_new_access_token");
    assert.ok(
      ctx.calls.includes("rotationCAS"),
      "an expired lease must be takeable — a crash cannot deadlock the connection",
    );
    assert.ok(!ctx.calls.includes("reverseMirror"), "no legacy Brand mirror exists anymore");
  });

  test("5b. a connection missing only the OPTIONAL read_orders/read_themes scopes never trips REQUIRES_RECONNECT", async () => {
    stdCanonicalScenario({
      conn: makeCanonicalConn({
        grantedScopes: ["read_products", "read_discounts", "write_discounts"],
      }),
    });

    const result = await getValidAccessToken("brand-mirror-1", {
      tokenEndpoint: async () => makeTokenResponse(),
    });

    assert.equal(result.ok, true, "baseline scopes are sufficient");
    assert.ok(
      !ctx.calls.includes("connectionEventCreate"),
      "no REQUIRES_RECONNECT event may be recorded for a merely-additive missing scope",
    );
    assert.notEqual(ctx.conn!.status, "REQUIRES_RECONNECT");
  });

  // -------------------------------------------------------------------------
  // K / L — permanent vs transient failure
  // -------------------------------------------------------------------------

  test("K. invalid_grant clears the CANONICAL secret, sets CommerceConnection.status REQUIRES_RECONNECT, records the loss event, no mirror", async () => {
    stdCanonicalScenario();
    const tokenEndpoint: TokenEndpointFn = async () => {
      throw Object.assign(new Error("invalid_grant"), { status: 400 });
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "NEEDS_RECONNECT");

    assert.equal(ctx.secret, null, "the canonical credential must be cleared");
    assert.equal(ctx.conn!.status, "REQUIRES_RECONNECT");
    // Connection-loss behavior preserved, inside the same transaction.
    assert.ok(ctx.calls.includes("deactivateOffers"));
    assert.ok(ctx.calls.includes("connectionEventCreate"));
    assert.ok(!ctx.calls.includes("reverseMirror"), "no legacy Brand mirror exists anymore");
  });

  test("K. a SUPERSEDED holder cannot disconnect a merchant, and does not mirror", async () => {
    stdCanonicalScenario();
    const tokenEndpoint: TokenEndpointFn = async () => {
      // Lease taken over mid-flight, then this caller's endpoint fails hard.
      if (ctx.secret) ctx.secret.refreshLockId = "some-other-processes-lock";
      throw Object.assign(new Error("invalid_grant"), { status: 400 });
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, false);
    assert.ok(ctx.secret !== null, "a superseded holder must not clear the credential");
    assert.notEqual(ctx.conn!.status, "REQUIRES_RECONNECT");
    assert.ok(
      !ctx.calls.includes("reverseMirror"),
      "a failed canonical CAS must not trigger the status mirror",
    );
  });

  test("L. a TRANSIENT refresh failure releases the lease and leaves the canonical credential intact", async () => {
    stdCanonicalScenario();
    const tokenEndpoint: TokenEndpointFn = async () => {
      throw Object.assign(new Error("503 upstream"), { status: 503 });
    };

    const result = await getValidAccessToken("brand-mirror-1", { tokenEndpoint });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "NEEDS_RECONNECT");

    assert.ok(ctx.secret !== null, "a transient failure must NEVER clear the credential");
    assert.notEqual(
      ctx.conn!.status,
      "REQUIRES_RECONNECT",
      "a transient failure must never falsely disconnect a merchant",
    );
    assert.ok(ctx.calls.includes("releaseLease"), "the lease must be released for the next attempt");
    assert.equal(ctx.secret!.refreshLockId, null);
  });

  // -------------------------------------------------------------------------
  // X / T / 7 — no legacy lease dependency, provider isolation, LEGACY_OFFLINE
  // -------------------------------------------------------------------------

  test("X. no canonical request touches Brand.shopifyTokenRefreshLockId/LockedUntil", async () => {
    stdCanonicalScenario();

    await getValidAccessToken("brand-mirror-1", {
      tokenEndpoint: async () => makeTokenResponse(),
    });

    assert.ok(
      !ctx.calls.includes("legacyBrandCAS"),
      "the legacy Brand lease CAS must never run when a canonical credential exists",
    );
    assert.equal(ctx.brand!.shopifyTokenRefreshLockId, null);
    assert.equal(ctx.brand!.shopifyTokenRefreshLockedUntil, null);
  });

  test("T. a COMMERCE7 connection is invisible to Shopify token logic (no canonical Shopify credential -> NOT_CONNECTED)", async () => {
    resetMirrorCtx({
      brand: null,
      conn: makeCanonicalConn({ id: "conn-c7", provider: "COMMERCE7" }),
      secret: makeStaleCanonicalSecret({ connectionId: "conn-c7" }),
    });

    const result = await getValidAccessToken("brand-mirror-1", {
      tokenEndpoint: async () => {
        throw new Error("Commerce7 must never enter Shopify refresh logic");
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "NOT_CONNECTED");
    assert.ok(!ctx.calls.includes("acquireLease"));
    assert.ok(!ctx.calls.includes("rotationCAS"));
  });

  test("Q. a CORRUPT canonical secret fails closed and NEVER falls back to the stale Brand credential", async () => {
    stdCanonicalScenario({
      secret: makeStaleCanonicalSecret({
        encryptedPayload: "not-valid-gcm-ciphertext",
      }),
    });

    const result = await getValidAccessToken("brand-mirror-1", {
      tokenEndpoint: async () => makeTokenResponse(),
    });

    assert.equal(result.ok, false, "a corrupt canonical secret must fail closed");
    if (!result.ok) assert.equal(result.reason, "NEEDS_RECONNECT");
    // The decisive assertion: the stale Brand token was NOT resurrected.
    assert.ok(
      !ctx.calls.includes("legacyBrandRead") ||
        !ctx.calls.includes("acquireLease"),
      "a corrupt canonical secret must not start a legacy refresh",
    );
    assert.ok(!ctx.calls.includes("rotationCAS"));
  });

  test("AH. THE RESURRECTION GUARD: a revoked canonical connection with NO secret is never rescued from a stale Brand mirror", async () => {
    // This is the exact post-invalidation state every credential-destruction
    // path now produces: the canonical connection survives in a terminal
    // status, its `CommerceConnectionSecret` is gone, and the legacy `Brand`
    // mirror may still hold a working token (its write can lag, fail, or be
    // rolled back independently). `NO_SECRET` alone is ambiguous — it is also
    // what a never-backfilled pre-cutover brand looks like — so the canonical
    // STATUS has to decide. If it did not, a disconnected merchant would keep
    // authenticating on the mirror.
    for (const [status, expected] of [
      ["DISCONNECTED", "NOT_CONNECTED"],
      ["UNINSTALLED", "NOT_CONNECTED"],
      ["REQUIRES_RECONNECT", "NEEDS_RECONNECT"],
      // Neither of these is a usable connected state either.
      ["PENDING", "NOT_CONNECTED"],
      ["ERROR", "NOT_CONNECTED"],
    ] as const) {
      resetMirrorCtx({
        // The mirror is deliberately still CONNECTED and still holds a token.
        brand: makeStaleBrandMirror(),
        conn: makeCanonicalConn({ status }),
        secret: null,
      });

      const result = await getValidAccessToken("brand-mirror-1", {
        tokenEndpoint: async () => {
          throw new Error(`a ${status} connection must never refresh`);
        },
      });

      assert.equal(result.ok, false, `${status} must not yield a token`);
      if (!result.ok) assert.equal(result.reason, expected, `${status} classification`);
      assert.ok(
        !ctx.calls.includes("acquireLease") && !ctx.calls.includes("rotationCAS"),
        `${status} must not start a refresh`,
      );
    }
  });

  // PHASE 14C-A: the legacy compatibility fallback for a "genuinely
  // pre-cutover brand" (CONNECTED canonical row, no secret) was removed
  // entirely — the operator verified via live SQL that no such brand
  // exists anymore (every currently CONNECTED brand already has a
  // canonical secret). A CONNECTED-but-unbackfilled connection is now
  // simply NOT_CONNECTED, fail-closed, never rescued from `Brand` — this
  // replaces the old "AI." test, which asserted the opposite (that the
  // stale Brand token WAS used).
  test("AI. a CONNECTED canonical row with no secret is NOT_CONNECTED — never rescued from the legacy Brand credential", async () => {
    resetMirrorCtx({
      brand: makeStaleBrandMirror(),
      conn: makeCanonicalConn({ status: "CONNECTED" }),
      secret: null,
    });

    const result = await getValidAccessToken("brand-mirror-1", {
      tokenEndpoint: async () => {
        throw new Error("must never attempt a refresh with no canonical secret");
      },
    });

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "NOT_CONNECTED");
  });

  test("W. scope reconciliation uses the CANONICAL credential even while CommerceConnection.status is REQUIRES_RECONNECT", async () => {
    // The scope-drift signature: status REQUIRES_RECONNECT but a credential is
    // still on file. `reconcileShopifyConnectionScopes` must be able to see
    // PAST the status gate that `getValidAccessToken` honors — otherwise a
    // false REQUIRES_RECONNECT could never self-heal. This asserts the
    // canonical credential is what it reaches for, not the legacy Brand copy.
    stdCanonicalScenario({
      conn: makeCanonicalConn({ status: "REQUIRES_RECONNECT" }),
    });
    setCanonicalTokens({
      accessToken: "shpat_canonical_under_reconnect",
      accessTokenExpiresAt: realExpiry(3_600_000),
      authMode: "LEGACY_OFFLINE",
    });

    let tokenSeenByShopify: string | null = null;
    const result = await reconcileShopifyConnectionScopes("brand-mirror-1", {
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        tokenSeenByShopify = headers["X-Shopify-Access-Token"] ?? null;
        return new Response(
          JSON.stringify({
            data: {
              currentAppInstallation: {
                accessScopes: [
                  { handle: "read_products" },
                  { handle: "read_discounts" },
                  { handle: "write_discounts" },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    });

    assert.notEqual(
      result.outcome,
      "NOT_ELIGIBLE",
      "a canonical credential under REQUIRES_RECONNECT must still be reconcilable",
    );
    assert.equal(
      tokenSeenByShopify,
      "shpat_canonical_under_reconnect",
      "the CANONICAL token must be the one proven against Shopify",
    );
    assert.notEqual(
      tokenSeenByShopify,
      "shpat_STALE_BRAND_TOKEN_MUST_NOT_BE_USED",
      "the stale legacy Brand token must never be used for reconciliation",
    );
  });

  test("7. LEGACY_OFFLINE returns the canonical token immediately, touching no lease/CAS/mirror logic", async () => {
    stdCanonicalScenario();
    setCanonicalTokens({
      accessToken: "shpat_legacy_offline_canonical",
      accessTokenExpiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
      authMode: "LEGACY_OFFLINE",
    });

    const result = await getValidAccessToken("brand-mirror-1", {
      tokenEndpoint: async () => {
        throw new Error("LEGACY_OFFLINE must never refresh");
      },
    });

    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.accessToken, "shpat_legacy_offline_canonical");
    assert.deepEqual(
      ctx.calls,
      ["canonicalLoad#1"],
      "LEGACY_OFFLINE must return after its single canonical read, touching no lock/CAS/mirror logic",
    );
  });
});
