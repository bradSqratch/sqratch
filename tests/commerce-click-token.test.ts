process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.COMMERCE_CLICK_TOKEN_PEPPER = "test-pepper-for-commerce-click-token-tests-only";

/**
 * tests/commerce-click-token.test.ts
 *
 * Unit coverage for src/lib/commerce/click-token.ts: the peppered HMAC-SHA-256
 * crypto module Phase 6's click-attribution hop uses to mint and hash opaque
 * click tokens. No DB, no network — pure functions over crypto.randomBytes and
 * node:crypto's HMAC, exercised directly.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  CLICK_TOKEN_CART_ATTRIBUTE,
  CLICK_TOKEN_CHAR_LENGTH,
  CLICK_TOKEN_QUERY_PARAM,
  clickTokenPrefix,
  generateClickToken,
  hashClickIp,
  hashClickToken,
  isValidClickToken,
} from "../src/lib/commerce/click-token";

describe("generateClickToken: entropy and format", () => {
  test("produces a 43-character base64url string matching the documented pattern", () => {
    const token = generateClickToken();
    assert.equal(token.length, 43);
    assert.equal(CLICK_TOKEN_CHAR_LENGTH, 43);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  });

  test("is unique across many generations (no observable pattern / collision)", () => {
    const seen = new Set<string>();
    const count = 1000;
    for (let i = 0; i < count; i += 1) {
      seen.add(generateClickToken());
    }
    assert.equal(seen.size, count);
  });

  test("isValidClickToken accepts only well-formed tokens", () => {
    assert.equal(isValidClickToken(generateClickToken()), true);
    assert.equal(isValidClickToken("too-short"), false);
    assert.equal(isValidClickToken("!".repeat(43)), false);
    assert.equal(isValidClickToken(12345), false);
    assert.equal(isValidClickToken(null), false);
    assert.equal(isValidClickToken(undefined), false);
  });
});

describe("hashClickToken: opacity and determinism", () => {
  test("is deterministic for the same input", () => {
    const token = generateClickToken();
    assert.equal(hashClickToken(token), hashClickToken(token));
  });

  test("produces different output for different tokens", () => {
    const a = generateClickToken();
    const b = generateClickToken();
    assert.notEqual(hashClickToken(a), hashClickToken(b));
  });

  test("differs from hashClickIp given the same underlying string (domain separation)", () => {
    // hashClickToken requires a well-formed 43-char token; use one as the
    // shared underlying string for both hash functions to compare prefixes.
    const token = generateClickToken();
    const tokenHash = hashClickToken(token);
    const ipHash = hashClickIp(token);
    assert.notEqual(tokenHash, ipHash);
  });

  test("throws rather than hashing a malformed token", () => {
    assert.throws(() => hashClickToken("not-a-valid-token"));
  });

  test("the hash has no substring relationship to any internal SQRATCH id used as fixture data", () => {
    const fixtureIds = [
      "brand-1234567890",
      "campaign-abcdefghij",
      "experienceProductLink-zzz",
      "lessonProductLink-yyy",
      "user-clxyz00000000000000000000",
    ];
    const token = generateClickToken();
    const hash = hashClickToken(token);

    for (const id of fixtureIds) {
      assert.equal(hash.includes(id), false);
      assert.equal(id.includes(hash), false);
    }
    // The hash is pure hex output of an HMAC over a random token; it can never
    // be derived from, or reversed to, any entity id by construction.
    assert.match(hash, /^[0-9a-f]{64}$/);
  });
});

describe("clickTokenPrefix", () => {
  test("returns exactly the first 8 characters of the token", () => {
    const token = generateClickToken();
    assert.equal(clickTokenPrefix(token), token.slice(0, 8));
    assert.equal(clickTokenPrefix(token).length, 8);
  });

  test("throws on a malformed token, matching hashClickToken's contract", () => {
    assert.throws(() => clickTokenPrefix("bad"));
  });
});

describe("hashClickIp", () => {
  test("is deterministic for the same IP and differs across distinct IPs", () => {
    assert.equal(hashClickIp("1.2.3.4"), hashClickIp("1.2.3.4"));
    assert.notEqual(hashClickIp("1.2.3.4"), hashClickIp("5.6.7.8"));
  });

  test("returns null for an absent or 'unknown' IP rather than hashing a placeholder", () => {
    assert.equal(hashClickIp(null), null);
    assert.equal(hashClickIp(undefined), null);
    assert.equal(hashClickIp(""), null);
    assert.equal(hashClickIp("   "), null);
    assert.equal(hashClickIp("unknown"), null);
  });
});

describe("module constants", () => {
  test("the outbound query param is SQRATCH-namespaced and unchanged", () => {
    // This is SQRATCH's own URL parameter on the merchant landing page, not a
    // Shopify cart attribute, so it stays a bare namespaced key.
    assert.equal(CLICK_TOKEN_QUERY_PARAM, "sqratch_ref");
  });

  test("the cart attribute is underscore-prefixed so Shopify keeps it out of the merchant-facing presentation", () => {
    assert.equal(CLICK_TOKEN_CART_ATTRIBUTE, "_sqratch_ref");
    // A single leading underscore only; the double-underscore namespace is
    // reserved for Shopify's own internal attributes.
    assert.doesNotMatch(CLICK_TOKEN_CART_ATTRIBUTE, /^__/);
    assert.match(CLICK_TOKEN_CART_ATTRIBUTE, /^_[a-z0-9_]+$/);
  });

  test("the query param and the cart attribute are decoupled, not accidentally the same key", () => {
    assert.notEqual(CLICK_TOKEN_QUERY_PARAM, CLICK_TOKEN_CART_ATTRIBUTE);
    assert.equal(CLICK_TOKEN_CART_ATTRIBUTE, `_${CLICK_TOKEN_QUERY_PARAM}`);
  });
});

describe("fail-closed pepper handling", () => {
  test("hashClickToken and hashClickIp throw when the pepper is unset", async () => {
    // Exercised in a fresh module instance (via dynamic re-import after
    // deleting the module from the require cache is not reliable under ESM
    // loaders in this repo's test runner), so instead this asserts the
    // documented contract indirectly: the pepper getter throws synchronously
    // when the env var is empty. We simulate that by temporarily clearing the
    // var, which the already-imported functions still read per-call (getPepper
    // is called inside hashClickToken/hashClickIp on every invocation, not
    // cached at module load).
    const original = process.env.COMMERCE_CLICK_TOKEN_PEPPER;
    process.env.COMMERCE_CLICK_TOKEN_PEPPER = "";
    try {
      const token = generateClickToken();
      assert.throws(() => hashClickToken(token));
      assert.throws(() => hashClickIp("1.2.3.4"));
    } finally {
      process.env.COMMERCE_CLICK_TOKEN_PEPPER = original;
    }
  });
});
