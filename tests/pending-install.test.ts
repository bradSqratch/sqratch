/**
 * tests/pending-install.test.ts
 *
 * Unit tests for src/lib/pending-install.ts
 *
 * Uses node:test + node:assert/strict.  No network.  No DB.  No IO.
 * Confirms that the module never logs token values (it has no logging).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  parsePendingInstall,
  buildExpiringPendingInstall,
  serializeExpiringPendingInstall,
} from "../src/lib/pending-install";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOP = "mystore.myshopify.com";
const ENCRYPTED_ACCESS_TOKEN = "enc_access_abc123";
const ENCRYPTED_REFRESH_TOKEN = "enc_refresh_xyz789";
const ACCESS_EXPIRES_AT = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const REFRESH_EXPIRES_AT = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
const CLIENT_ID = "shopify-client-id-42";
const SCOPES = "read_products,write_discounts";

// ---------------------------------------------------------------------------
// EXPIRING round-trip tests
// ---------------------------------------------------------------------------

describe("parsePendingInstall — EXPIRING shape", () => {
  test("round-trip: build → serialize → parse preserves all fields", () => {
    const built = buildExpiringPendingInstall({
      shop: SHOP,
      clientId: CLIENT_ID,
      encryptedAccessToken: ENCRYPTED_ACCESS_TOKEN,
      accessTokenExpiresAt: ACCESS_EXPIRES_AT,
      encryptedRefreshToken: ENCRYPTED_REFRESH_TOKEN,
      refreshTokenExpiresAt: REFRESH_EXPIRES_AT,
      grantedScopes: SCOPES,
    });

    const json = serializeExpiringPendingInstall(built);
    const parsed = parsePendingInstall(json);

    assert.ok(parsed !== null, "parsed result should not be null");
    assert.equal(parsed.shape, "EXPIRING");
    assert.equal(parsed.shop, SHOP);

    if (parsed.shape !== "EXPIRING") {
      throw new Error("shape assertion failed");
    }

    assert.equal(parsed.authMode, "EXPIRING_OFFLINE");
    assert.equal(parsed.clientId, CLIENT_ID);
    assert.equal(parsed.encryptedAccessToken, ENCRYPTED_ACCESS_TOKEN);
    assert.equal(parsed.accessTokenExpiresAt, ACCESS_EXPIRES_AT);
    assert.equal(parsed.encryptedRefreshToken, ENCRYPTED_REFRESH_TOKEN);
    assert.equal(parsed.refreshTokenExpiresAt, REFRESH_EXPIRES_AT);
    assert.equal(parsed.grantedScopes, SCOPES);
  });

  test("serialize does NOT include `shape` key in wire JSON (byte-identical to original format)", () => {
    const built = buildExpiringPendingInstall({
      shop: SHOP,
      clientId: CLIENT_ID,
      encryptedAccessToken: ENCRYPTED_ACCESS_TOKEN,
      accessTokenExpiresAt: ACCESS_EXPIRES_AT,
      encryptedRefreshToken: ENCRYPTED_REFRESH_TOKEN,
      refreshTokenExpiresAt: REFRESH_EXPIRES_AT,
      grantedScopes: SCOPES,
    });

    const json = serializeExpiringPendingInstall(built);
    const raw = JSON.parse(json) as Record<string, unknown>;

    assert.ok(!("shape" in raw), "wire JSON must NOT contain `shape` key");
    assert.equal(raw["shop"], SHOP);
    assert.equal(raw["authMode"], "EXPIRING_OFFLINE");
    assert.equal(raw["clientId"], CLIENT_ID);
    assert.equal(raw["encryptedAccessToken"], ENCRYPTED_ACCESS_TOKEN);
    assert.equal(raw["accessTokenExpiresAt"], ACCESS_EXPIRES_AT);
    assert.equal(raw["encryptedRefreshToken"], ENCRYPTED_REFRESH_TOKEN);
    assert.equal(raw["refreshTokenExpiresAt"], REFRESH_EXPIRES_AT);
    assert.equal(raw["grantedScopes"], SCOPES);

    // Exactly 8 keys — no extra leakage.
    assert.equal(Object.keys(raw).length, 8);
  });

  test("buildExpiringPendingInstall sets shape: EXPIRING on the in-memory object", () => {
    const built = buildExpiringPendingInstall({
      shop: SHOP,
      clientId: CLIENT_ID,
      encryptedAccessToken: ENCRYPTED_ACCESS_TOKEN,
      accessTokenExpiresAt: ACCESS_EXPIRES_AT,
      encryptedRefreshToken: ENCRYPTED_REFRESH_TOKEN,
      refreshTokenExpiresAt: REFRESH_EXPIRES_AT,
      grantedScopes: SCOPES,
    });

    assert.equal(built.shape, "EXPIRING");
    assert.equal(built.authMode, "EXPIRING_OFFLINE");
  });
});

// ---------------------------------------------------------------------------
// LEGACY shape tests
// ---------------------------------------------------------------------------

describe("parsePendingInstall — LEGACY shape", () => {
  test("parses {shop, encryptedToken} as shape LEGACY", () => {
    const json = JSON.stringify({ shop: SHOP, encryptedToken: "legacy_enc_token" });
    const parsed = parsePendingInstall(json);

    assert.ok(parsed !== null);
    assert.equal(parsed.shape, "LEGACY");
    assert.equal(parsed.shop, SHOP);

    if (parsed.shape !== "LEGACY") {
      throw new Error("shape assertion failed");
    }

    assert.equal(parsed.encryptedToken, "legacy_enc_token");
  });

  test("LEGACY: ignores extra unknown keys", () => {
    const json = JSON.stringify({
      shop: SHOP,
      encryptedToken: "legacy_enc_token",
      extra: "ignored",
    });
    const parsed = parsePendingInstall(json);

    assert.ok(parsed !== null);
    assert.equal(parsed.shape, "LEGACY");
  });
});

// ---------------------------------------------------------------------------
// Invalid / null cases
// ---------------------------------------------------------------------------

describe("parsePendingInstall — returns null for invalid inputs", () => {
  test("missing shop → null", () => {
    const json = JSON.stringify({ encryptedToken: "some_token" });
    assert.equal(parsePendingInstall(json), null);
  });

  test("empty string shop → null", () => {
    const json = JSON.stringify({ shop: "", encryptedToken: "some_token" });
    assert.equal(parsePendingInstall(json), null);
  });

  test("non-string shop → null", () => {
    const json = JSON.stringify({ shop: 42, encryptedToken: "some_token" });
    assert.equal(parsePendingInstall(json), null);
  });

  test("EXPIRING shape missing refreshTokenExpiresAt → null", () => {
    const json = JSON.stringify({
      shop: SHOP,
      authMode: "EXPIRING_OFFLINE",
      clientId: CLIENT_ID,
      encryptedAccessToken: ENCRYPTED_ACCESS_TOKEN,
      accessTokenExpiresAt: ACCESS_EXPIRES_AT,
      encryptedRefreshToken: ENCRYPTED_REFRESH_TOKEN,
      // refreshTokenExpiresAt intentionally omitted
      grantedScopes: SCOPES,
    });
    assert.equal(parsePendingInstall(json), null);
  });

  test("EXPIRING shape missing clientId → null", () => {
    const json = JSON.stringify({
      shop: SHOP,
      authMode: "EXPIRING_OFFLINE",
      // clientId intentionally omitted
      encryptedAccessToken: ENCRYPTED_ACCESS_TOKEN,
      accessTokenExpiresAt: ACCESS_EXPIRES_AT,
      encryptedRefreshToken: ENCRYPTED_REFRESH_TOKEN,
      refreshTokenExpiresAt: REFRESH_EXPIRES_AT,
      grantedScopes: SCOPES,
    });
    assert.equal(parsePendingInstall(json), null);
  });

  test("EXPIRING shape with empty encryptedAccessToken falls through to LEGACY check", () => {
    // An empty string for encryptedAccessToken means it doesn't trigger the EXPIRING branch.
    // With no encryptedToken either, result should be null.
    const json = JSON.stringify({
      shop: SHOP,
      authMode: "EXPIRING_OFFLINE",
      clientId: CLIENT_ID,
      encryptedAccessToken: "",
      accessTokenExpiresAt: ACCESS_EXPIRES_AT,
      encryptedRefreshToken: ENCRYPTED_REFRESH_TOKEN,
      refreshTokenExpiresAt: REFRESH_EXPIRES_AT,
      grantedScopes: SCOPES,
    });
    assert.equal(parsePendingInstall(json), null);
  });

  test("neither encryptedAccessToken nor encryptedToken present → null", () => {
    const json = JSON.stringify({ shop: SHOP });
    assert.equal(parsePendingInstall(json), null);
  });

  test("empty encryptedToken → null (falsy check)", () => {
    const json = JSON.stringify({ shop: SHOP, encryptedToken: "" });
    assert.equal(parsePendingInstall(json), null);
  });

  test("malformed JSON → null", () => {
    assert.equal(parsePendingInstall("{not valid json"), null);
  });

  test("empty string → null", () => {
    assert.equal(parsePendingInstall(""), null);
  });

  test("JSON null → null", () => {
    assert.equal(parsePendingInstall("null"), null);
  });

  test("JSON array → null", () => {
    assert.equal(parsePendingInstall("[]"), null);
  });

  test("JSON string literal → null", () => {
    assert.equal(parsePendingInstall('"just a string"'), null);
  });
});

// ---------------------------------------------------------------------------
// Module logging safety
// ---------------------------------------------------------------------------

describe("Module logging safety", () => {
  test("the module has no logging — no console calls are triggered by parse/build/serialize", () => {
    // We intercept console methods to confirm nothing is logged when calling
    // the pure functions.  The module itself contains no console statements,
    // so this test verifies that invariant at runtime.
    const logged: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;

    try {
      console.log = (...args: unknown[]) => { logged.push(["log", ...args].join(" ")); };
      console.warn = (...args: unknown[]) => { logged.push(["warn", ...args].join(" ")); };
      console.error = (...args: unknown[]) => { logged.push(["error", ...args].join(" ")); };

      // Exercise all exported functions.
      parsePendingInstall("malformed");
      parsePendingInstall(JSON.stringify({ shop: SHOP, encryptedToken: "tok" }));
      const built = buildExpiringPendingInstall({
        shop: SHOP,
        clientId: CLIENT_ID,
        encryptedAccessToken: ENCRYPTED_ACCESS_TOKEN,
        accessTokenExpiresAt: ACCESS_EXPIRES_AT,
        encryptedRefreshToken: ENCRYPTED_REFRESH_TOKEN,
        refreshTokenExpiresAt: REFRESH_EXPIRES_AT,
        grantedScopes: SCOPES,
      });
      serializeExpiringPendingInstall(built);
      parsePendingInstall(serializeExpiringPendingInstall(built));
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }

    assert.equal(logged.length, 0, `Expected no console output, got: ${logged.join(", ")}`);
  });
});
